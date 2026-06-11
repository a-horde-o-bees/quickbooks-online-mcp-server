import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// ESM-compatible module mocking
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { batchQuickbooks } = await import('../../../src/handlers/batch-quickbooks.handler');

const ITEM = { bId: 'tx-1', operation: 'create' as const, entity_type: 'Invoice', entity: { DocNumber: '1' } };

describe('batchQuickbooks (/batch write path)', () => {
  beforeEach(() => resetAllMocks());

  it('submits and returns the batch response', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(null, { BatchItemResponse: [{ bId: 'tx-1', Invoice: { Id: '7001' } }] }),
    );
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(false);
    expect(res.result.BatchItemResponse[0].Invoice.Id).toBe('7001');
  });

  it('rejects more than 30 items without calling the API', async () => {
    const items = Array.from({ length: 31 }, (_, i) => ({ ...ITEM, bId: `tx-${i}` }));
    const res = await batchQuickbooks(items);
    expect(res.isError).toBe(true);
    expect(mockQuickBooksInstance.batch).not.toHaveBeenCalled();
  });

  it('rejects a non-array / empty / bId-less / operation-less input without calling the API', async () => {
    for (const bad of [
      'not-an-array' as any,
      [],
      [{ operation: 'create', entity_type: 'Invoice', entity: {} }],
      [{ bId: 'tx-1' }],
    ]) {
      const res = await batchQuickbooks(bad);
      expect(res.isError).toBe(true);
    }
    expect(mockQuickBooksInstance.batch).not.toHaveBeenCalled();
  });

  it('passes a query item through as a Query request', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((items: any, cb: any) => {
      expect(items).toEqual([{ bId: 'q1', Query: 'select * from Invoice' }]);
      cb(null, { BatchItemResponse: [{ bId: 'q1', QueryResponse: {} }] });
    });
    const res = await batchQuickbooks([{ bId: 'q1', query: 'select * from Invoice' }]);
    expect(res.isError).toBe(false);
  });

  it('surfaces an authenticate() failure as an error', async () => {
    (mockQuickbooksClient.authenticate as any).mockRejectedValue(new Error('Auth failed'));
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('Auth failed');
  });

  it('heals the token on a request-level 401 raw-body rejection, without re-sending', async () => {
    // node-quickbooks passes the parsed HTTP-error body OBJECT as `err` (not an
    // Error). A 401 rejects the whole /batch call before the API processes
    // anything, so the python caller re-sends safely — but only if the token is
    // fresh by then: the per-call authenticate() trusts the client's own expiry
    // estimate, which QBO's server-side expiry can precede. The handler must
    // force the refresh on this error path (and must NOT re-send the mutation).
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb({
        warnings: null,
        intuitObject: null,
        fault: { error: [{ message: 'message=AuthenticationFailed; errorCode=003200; statusCode=401', detail: 'Token expired', code: '3200' }] },
      }, null),
    );
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('003200');
    expect(mockQuickbooksClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(1); // no re-send
  });

  it('does not refresh on a non-expiry transport error', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(new Error('network down'), null),
    );
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(mockQuickbooksClient.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('surfaces the original 401 even when the heal itself fails', async () => {
    (mockQuickbooksClient.refreshAccessToken as any).mockRejectedValue(new Error('refresh down'));
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb({ fault: { error: [{ message: 'message=AuthenticationFailed; errorCode=003200; statusCode=401', detail: 'Token expired' }] } }, null),
    );
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('003200');
  });
});
