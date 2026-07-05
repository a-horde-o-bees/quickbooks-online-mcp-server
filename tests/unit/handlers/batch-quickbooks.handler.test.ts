import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// ESM-compatible module mocking
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { batchQuickbooks } = await import('../../../src/handlers/batch-quickbooks.handler');

const ITEM = { bId: 'tx-1', operation: 'create' as const, entity_type: 'Invoice', entity: { DocNumber: '1' } };

// node-quickbooks rejects a request-level 401 with the parsed HTTP-error body
// OBJECT (not an Error) — the transport-level shape, distinct from an
// in-response BatchItemResponse[].Fault.
const RAW_401_BODY = {
  warnings: null,
  intuitObject: null,
  fault: { error: [{ message: 'message=AuthenticationFailed; errorCode=003200; statusCode=401', detail: 'Token expired', code: '3200' }] },
};

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

  it('rejects a mutate item missing its entity payload without calling the API', async () => {
    const res = await batchQuickbooks([{ bId: 'tx-1', operation: 'create', entity_type: 'Invoice' }]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('tx-1');
    expect(mockQuickBooksInstance.batch).not.toHaveBeenCalled();
  });

  it('rejects duplicate bIds without calling the API', async () => {
    const res = await batchQuickbooks([ITEM, { ...ITEM }]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain("duplicate bId 'tx-1'");
    expect(mockQuickBooksInstance.batch).not.toHaveBeenCalled();
  });

  it('rejects an item mixing query with mutate fields without calling the API', async () => {
    const res = await batchQuickbooks([{ ...ITEM, query: 'select * from Invoice' }]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('mutually exclusive');
    expect(mockQuickBooksInstance.batch).not.toHaveBeenCalled();
  });

  it('rejects an empty query string without calling the API', async () => {
    const res = await batchQuickbooks([{ bId: 'q1', query: '' }]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('non-empty');
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

  it('passes optionsData through on a mutate item', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((items: any, cb: any) => {
      expect(items).toEqual([
        { bId: 'v1', operation: 'update', Invoice: { Id: '7001', SyncToken: '0' }, optionsData: 'void' },
      ]);
      cb(null, { BatchItemResponse: [{ bId: 'v1', Invoice: { Id: '7001' } }] });
    });
    const res = await batchQuickbooks([
      { bId: 'v1', operation: 'update', entity_type: 'Invoice', entity: { Id: '7001', SyncToken: '0' }, optionsData: 'void' },
    ]);
    expect(res.isError).toBe(false);
  });

  it('surfaces an authenticate() failure as an error', async () => {
    (mockQuickbooksClient.authenticate as any).mockRejectedValue(new Error('Auth failed'));
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('Auth failed');
  });

  it('refreshes the token and re-sends once on a request-level 401 raw-body rejection', async () => {
    // A 401 rejects the whole /batch call before the API processes any item,
    // so the single re-send cannot double-apply a mutation. The refresh must
    // be forced: the per-call authenticate() trusts the client's own expiry
    // estimate, which QBO's server-side expiry can precede.
    let n = 0;
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) => {
      n++;
      if (n === 1) return cb(RAW_401_BODY, null);
      cb(null, { BatchItemResponse: [{ bId: 'tx-1', Invoice: { Id: '7001' } }] });
    });
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(false);
    expect(res.result.BatchItemResponse[0].Invoice.Id).toBe('7001');
    expect(mockQuickbooksClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(2);
  });

  it('retries at most once: a second 401 surfaces as the error', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(RAW_401_BODY, null),
    );
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('003200');
    expect(mockQuickbooksClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(2);
  });

  it('surfaces a re-send failure after a successful heal', async () => {
    let n = 0;
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) => {
      n++;
      if (n === 1) return cb(RAW_401_BODY, null);
      cb(new Error('ValidationFault: something else'), null);
    });
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('ValidationFault');
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(2);
  });

  it('does not refresh on a non-expiry transport error', async () => {
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(new Error('network down'), null),
    );
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(mockQuickbooksClient.refreshAccessToken).not.toHaveBeenCalled();
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(1);
  });

  it('surfaces the original 401 without re-sending when the heal itself fails', async () => {
    (mockQuickbooksClient.refreshAccessToken as any).mockRejectedValue(new Error('refresh down'));
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(RAW_401_BODY, null),
    );
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('003200');
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(1);
  });

  it('handles a non-Error heal failure the same way', async () => {
    (mockQuickbooksClient.refreshAccessToken as any).mockRejectedValue('refresh down');
    (mockQuickBooksInstance.batch as any).mockImplementation((_i: any, cb: any) =>
      cb(RAW_401_BODY, null),
    );
    const res = await batchQuickbooks([ITEM]);
    expect(res.isError).toBe(true);
    expect(res.error).toContain('003200');
    expect((mockQuickBooksInstance.batch as any).mock.calls).toHaveLength(1);
  });
});
