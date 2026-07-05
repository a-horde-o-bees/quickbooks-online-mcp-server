import { quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { isTokenExpiry } from "../helpers/token-expiry.js";

/**
 * One operation in a QBO /batch call.
 * Mutate operation: { bId, operation, entity_type, entity, optionsData? }
 * Query operation:  { bId, query }
 * The two forms are mutually exclusive per item.
 */
export interface BatchItem {
  bId: string;
  operation?: "create" | "update" | "delete";
  entity_type?: string;
  entity?: unknown;
  optionsData?: string;
  query?: string;
}

function inputError(message: string): ToolResponse<any> {
  return { result: null, isError: true, error: message };
}

/**
 * Validate items and project them into QBO BatchItemRequest shape.
 * Returns the request array, or a ToolResponse error for the first invalid item.
 */
function buildRequests(
  items: BatchItem[],
): Record<string, unknown>[] | ToolResponse<any> {
  const requests: Record<string, unknown>[] = [];
  const seenBIds = new Set<string>();

  for (const item of items) {
    if (!item.bId) {
      return inputError(
        "every BatchItem requires a bId (caller-assigned identifier for response matching)",
      );
    }
    if (seenBIds.has(item.bId)) {
      return inputError(
        `duplicate bId '${item.bId}' — bIds must be unique to match responses to requests`,
      );
    }
    seenBIds.add(item.bId);

    const hasMutateField =
      item.operation !== undefined ||
      item.entity_type !== undefined ||
      item.entity !== undefined ||
      item.optionsData !== undefined;

    if (item.query !== undefined) {
      if (hasMutateField) {
        return inputError(
          `BatchItem ${item.bId}: 'query' is mutually exclusive with operation/entity_type/entity/optionsData`,
        );
      }
      if (item.query === "") {
        return inputError(`BatchItem ${item.bId}: 'query' must be a non-empty string`);
      }
      requests.push({ bId: item.bId, Query: item.query });
      continue;
    }

    if (!item.operation || !item.entity_type || item.entity === undefined) {
      return inputError(
        `BatchItem ${item.bId}: must include either 'query' or all of {operation, entity_type, entity}`,
      );
    }
    const request: Record<string, unknown> = {
      bId: item.bId,
      operation: item.operation,
      [item.entity_type]: item.entity,
    };
    if (item.optionsData !== undefined) {
      request.optionsData = item.optionsData;
    }
    requests.push(request);
  }
  return requests;
}

// node-quickbooks exposes batch() at runtime but the bundled type
// declarations don't include it, hence the any-cast.
function sendBatch(
  quickbooks: unknown,
  requests: Record<string, unknown>[],
): Promise<any> {
  return new Promise((resolve, reject) => {
    (quickbooks as any).batch(requests, (err: any, response: any) =>
      err ? reject(err) : resolve(response),
    );
  });
}

/**
 * Submit a batch of operations to QuickBooks Online via the /batch endpoint.
 *
 * QBO caps the batch at 30 items per request. The handler enforces this and
 * returns an early error if exceeded so callers get an actionable message
 * instead of an opaque QBO API error.
 *
 * On a token-expiry 401 the handler refreshes the token and re-sends once.
 * This is safe for mutations: a request-level 401 rejects the whole /batch
 * call before the API processes any item, so the re-send cannot double-apply.
 * The refresh is unconditional — QBO's server-side expiry can precede the
 * client's own expiry estimate, so the rejection itself is the authority.
 *
 * @param items Array of BatchItem (max 30)
 */
export async function batchQuickbooks(items: BatchItem[]): Promise<ToolResponse<any>> {
  if (!Array.isArray(items)) {
    return inputError("items must be an array of BatchItem");
  }
  if (items.length === 0) {
    return inputError("items is empty — pass at least one BatchItem");
  }
  if (items.length > 30) {
    return inputError(
      `QBO /batch caps at 30 items per request; got ${items.length}. Chunk the work caller-side.`,
    );
  }

  const requests = buildRequests(items);
  if (!Array.isArray(requests)) {
    return requests;
  }

  try {
    await quickbooksClient.authenticate();
    const quickbooks = quickbooksClient.getQuickbooks();
    try {
      const response = await sendBatch(quickbooks, requests);
      return { result: response, isError: false, error: null };
    } catch (err) {
      if (!isTokenExpiry(err)) {
        return { result: null, isError: true, error: formatError(err) };
      }
      let refreshed: unknown;
      try {
        await quickbooksClient.refreshAccessToken();
        refreshed = await quickbooksClient.authenticate();
      } catch (healErr) {
        // Surface the original 401; a failed refresh changes nothing for
        // this call, but leaves diagnostic evidence.
        const m = healErr instanceof Error ? healErr.message : String(healErr);
        console.error(`Token refresh after a /batch 401 failed: ${m}`);
        return { result: null, isError: true, error: formatError(err) };
      }
      const response = await sendBatch(refreshed, requests);
      return { result: response, isError: false, error: null };
    }
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
