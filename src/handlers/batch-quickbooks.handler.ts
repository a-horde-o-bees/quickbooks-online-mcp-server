import { quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { isTokenExpiry } from "../helpers/token-expiry.js";

/**
 * Batch item request — one operation in a QBO /batch call.
 * Mutate operation: { bId, operation, entity_type, entity }
 * Query operation:  { bId, query }
 */
export interface BatchItem {
  bId: string;
  operation?: "create" | "update" | "delete";
  entity_type?: string;
  entity?: unknown;
  query?: string;
}

/**
 * Submit a batch of operations to QuickBooks Online via the /batch endpoint.
 *
 * QBO caps the batch at 30 items per request. The handler enforces this and
 * returns an early error if exceeded so callers get an actionable message
 * instead of an opaque QBO API error.
 *
 * @param items Array of BatchItem (max 30)
 */
export async function batchQuickbooks(items: BatchItem[]): Promise<ToolResponse<any>> {
  if (!Array.isArray(items)) {
    return {
      result: null,
      isError: true,
      error: "items must be an array of BatchItem",
    };
  }
  if (items.length === 0) {
    return {
      result: null,
      isError: true,
      error: "items is empty — pass at least one BatchItem",
    };
  }
  if (items.length > 30) {
    return {
      result: null,
      isError: true,
      error: `QBO /batch caps at 30 items per request; got ${items.length}. Chunk the work caller-side.`,
    };
  }

  const requests: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!item.bId) {
      return {
        result: null,
        isError: true,
        error: "every BatchItem requires a bId (caller-assigned identifier for response matching)",
      };
    }
    if (item.query) {
      requests.push({ bId: item.bId, Query: item.query });
      continue;
    }
    if (!item.operation || !item.entity_type) {
      return {
        result: null,
        isError: true,
        error: `BatchItem ${item.bId}: must include either 'query' or all of {operation, entity_type, entity}`,
      };
    }
    requests.push({
      bId: item.bId,
      operation: item.operation,
      [item.entity_type]: item.entity,
    });
  }

  try {
    await quickbooksClient.authenticate();
    const quickbooks = quickbooksClient.getQuickbooks();

    return new Promise((resolve) => {
      // node-quickbooks exposes batch() at runtime (index.js:209) but the bundled
      // type declarations don't include it. Cast to any to access the method.
      (quickbooks as any).batch(requests, async (err: any, response: any) => {
        if (err) {
          // A token-expiry 401 rejects the whole /batch call BEFORE the API
          // processes anything, so the caller may safely re-send — but the
          // per-call authenticate() above refreshes only on the client's own
          // expiry estimate, and QBO's server-side expiry can precede it (the
          // read path's reactive arm exists for exactly this). Heal the token
          // now — QBO is the authority that just rejected it — so the caller's
          // re-send dispatches fresh. No re-send here: mutation retry policy
          // stays caller-side (qbo-pipeline `_batch._dispatch_batch`).
          if (isTokenExpiry(err)) {
            try {
              await quickbooksClient.refreshAccessToken();
              await quickbooksClient.authenticate();
            } catch (healErr) {
              // Surface the original 401; a failed heal changes nothing for
              // this call. But LOG it — a silent swallow left the 2026-07-01
              // deploy's 14-min 401 cascade with zero root-cause evidence.
              const m = healErr instanceof Error ? healErr.message : String(healErr);
              console.error(`[qbo-client] Token heal after 401 FAILED: ${m}`);
            }
          }
          resolve({
            result: null,
            isError: true,
            error: formatError(err),
          });
        } else {
          resolve({
            result: response,
            isError: false,
            error: null,
          });
        }
      });
    });
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
