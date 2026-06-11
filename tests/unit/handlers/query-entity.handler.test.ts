import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// ESM-compatible module mocking
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { queryQuickbooksEntity } = await import('../../../src/handlers/query-quickbooks-entity.handler');

// Make `quickbooks.batch([{bId,Query}], cb)` resolve with `pages.shift()` each call,
// where each page is an array of entity rows wrapped as a QueryResponse.
function batchYields(entity: string, pages: any[][]) {
  (mockQuickBooksInstance.batch as any).mockImplementation((_items: any, cb: any) => {
    const rows = pages.shift() ?? [];
    cb(null, { BatchItemResponse: [{ bId: 'q', QueryResponse: { [entity]: rows } }] });
  });
}

function lastSql(): string {
  const calls = (mockQuickBooksInstance.batch as any).mock.calls;
  return calls[calls.length - 1][0][0].Query;
}

describe('queryQuickbooksEntity (/batch read path)', () => {
  beforeEach(() => resetAllMocks());

  it('rejects an unsupported entity without calling the API', async () => {
    const res = await queryQuickbooksEntity({ entity: 'Bogus' });
    expect(res.isError).toBe(true);
    expect(res.error).toContain("Unsupported entity 'Bogus'");
    expect(mockQuickBooksInstance.batch).not.toHaveBeenCalled();
  });

  it('reads one page as SELECT * with STARTPOSITION/MAXRESULTS', async () => {
    batchYields('Account', [[{ Id: '957', Name: 'Sales' }]]);
    const res = await queryQuickbooksEntity({ entity: 'Account' });
    expect(res.isError).toBe(false);
    expect(res.result).toEqual([{ Id: '957', Name: 'Sales' }]);
    expect(lastSql()).toBe('select * from Account STARTPOSITION 1 MAXRESULTS 1000');
  });

  it('honors explicit limit/offset', async () => {
    batchYields('Invoice', [[]]);
    await queryQuickbooksEntity({ entity: 'Invoice', limit: 50, offset: 101 });
    expect(lastSql()).toBe('select * from Invoice STARTPOSITION 101 MAXRESULTS 50');
  });

  it('builds a WHERE clause from string, boolean, and operator', async () => {
    batchYields('Account', [[]]);
    await queryQuickbooksEntity({
      entity: 'Account',
      where: [
        { field: 'Name', value: "O'Brien" },
        { field: 'Active', value: false },
        { field: 'Balance', value: 10, operator: '>' },
      ],
    });
    expect(lastSql()).toBe(
      "select * from Account WHERE Name = 'O\\'Brien' AND Active = false AND Balance > 10" +
        ' STARTPOSITION 1 MAXRESULTS 1000',
    );
  });

  it('fetchAll paginates until a short page', async () => {
    // limit 2: first page full (2) → continue; second page short (1) → stop.
    batchYields('Customer', [[{ Id: '1' }, { Id: '2' }], [{ Id: '3' }]]);
    const res = await queryQuickbooksEntity({ entity: 'Customer', limit: 2, fetchAll: true });
    expect(res.result).toEqual([{ Id: '1' }, { Id: '2' }, { Id: '3' }]);
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(2);
    expect((mockQuickBooksInstance.batch as any).mock.calls[1][0][0].Query).toContain('STARTPOSITION 3');
  });

  it('renders a boolean true literal', async () => {
    batchYields('Account', [[]]);
    await queryQuickbooksEntity({ entity: 'Account', where: [{ field: 'Active', value: true }] });
    expect(lastSql()).toContain('Active = true');
  });

  it('returns [] when BatchItemResponse is empty', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(null, { BatchItemResponse: [] }),
    );
    const res = await queryQuickbooksEntity({ entity: 'Account' });
    expect(res.result).toEqual([]);
  });

  it('returns [] when the QueryResponse carries no rows', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(null, { BatchItemResponse: [{ bId: 'q', QueryResponse: {} }] }),
    );
    const res = await queryQuickbooksEntity({ entity: 'Account' });
    expect(res.result).toEqual([]);
  });

  it('surfaces a per-item Fault as an error', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(null, { BatchItemResponse: [{ bId: 'q', Fault: { Error: [{ code: '4000' }] } }] }),
    );
    const res = await queryQuickbooksEntity({ entity: 'Account' });
    expect(res.isError).toBe(true);
  });

  it('surfaces a transport error as an error', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(new Error('network down'), null),
    );
    const res = await queryQuickbooksEntity({ entity: 'Account' });
    expect(res.isError).toBe(true);
  });

  it('refreshes the token and retries the page on a 003200 expiry Fault', async () => {
    let n = 0;
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) => {
      n++;
      if (n === 1) {
        return cb(null, {
          BatchItemResponse: [{ bId: 'q', Fault: { Error: [{ Message: 'AuthenticationFailed', code: '003200', Detail: 'Token expired' }] } }],
        });
      }
      cb(null, { BatchItemResponse: [{ bId: 'q', QueryResponse: { Invoice: [{ Id: '7001' }] } }] });
    });
    const res = await queryQuickbooksEntity({ entity: 'Invoice' });
    expect(res.isError).toBe(false);
    expect(res.result).toEqual([{ Id: '7001' }]);
    expect(mockQuickbooksClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mockQuickbooksClient.authenticate).toHaveBeenCalledTimes(1);
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(2);
  });

  it('refreshes and retries when a request-level 401 rejects with a raw body object', async () => {
    // node-quickbooks passes the parsed HTTP-error body OBJECT as `err` (not an
    // Error) — `String(err)` flattens it to "[object Object]", which is how the
    // retry sat dead through four ~60-min deploy kills (2026-06-11). The
    // predicate must serialize the object to see the 003200 marker.
    let n = 0;
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) => {
      n++;
      if (n === 1) {
        return cb({
          warnings: null,
          intuitObject: null,
          fault: { error: [{ message: 'message=AuthenticationFailed; errorCode=003200; statusCode=401', detail: 'Token expired', code: '3200' }] },
        }, null);
      }
      cb(null, { BatchItemResponse: [{ bId: 'q', QueryResponse: { Invoice: [{ Id: '7002' }] } }] });
    });
    const res = await queryQuickbooksEntity({ entity: 'Invoice' });
    expect(res.isError).toBe(false);
    expect(res.result).toEqual([{ Id: '7002' }]);
    expect(mockQuickbooksClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(2);
  });

  it('does not refresh on a non-expiry Fault', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(null, { BatchItemResponse: [{ bId: 'q', Fault: { Error: [{ code: '4000' }] } }] }),
    );
    const res = await queryQuickbooksEntity({ entity: 'Account' });
    expect(res.isError).toBe(true);
    expect(mockQuickbooksClient.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('surfaces a getInstance failure as an error', async () => {
    (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));
    const res = await queryQuickbooksEntity({ entity: 'Account' });
    expect(res.isError).toBe(true);
  });
});
