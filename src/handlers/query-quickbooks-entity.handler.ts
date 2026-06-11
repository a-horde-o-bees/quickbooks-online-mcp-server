import { QuickbooksClient, quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { isTokenExpiry } from "../helpers/token-expiry.js";

// Entity-agnostic paginated read, issued over the QBO **/batch Query** endpoint
// (POST), NOT node-quickbooks' findX (GET /query).
//
// Why /batch and not /query: a QBO "Clear data and reset" (and ordinary
// soft-deletes) leave records that read `Active: true` via get-by-Id AND via
// the GET /query endpoint that node-quickbooks' findX wraps — yet are
// unreferenceable (create a dependent → fault 2500 "made inactive") and hold
// their name (block recreation → 6240). The standalone /query endpoint returns
// these tombstones; the /batch Query operation returns only the live,
// referenceable set (verified 2026-06-08 on dev: `select * from Account`
// returned 35 via /batch vs 200 via /query, the 165 extra all unreferenceable
// tombstones). Resolving references against the /query view binds them to dead
// Ids; the /batch view is QBO's authoritative referenceable set. This is a
// QBO-platform behavior, identical on stock upstream — see DECISIONS.md.

// Supported entity names, used verbatim in the `FROM` clause.
const SUPPORTED_ENTITIES: readonly string[] = [
  "Account", "Term", "PaymentMethod", "TaxCode", "Customer", "Vendor", "Item",
  "Invoice", "CreditMemo", "PurchaseOrder", "Purchase", "JournalEntry", "Payment",
];

export interface QueryEntityInput {
  entity: string;
  where?: Array<{ field: string; value: unknown; operator?: string }>;
  limit?: number;
  offset?: number;
  fetchAll?: boolean;
}

// QBO query literal: quote + backslash-escape strings; booleans/numbers raw.
function toSqlLiteral(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

function buildWhereClause(where?: QueryEntityInput["where"]): string {
  if (!where || where.length === 0) return "";
  const clauses = where.map(
    (c) => `${c.field} ${c.operator ?? "="} ${toSqlLiteral(c.value)}`,
  );
  return " WHERE " + clauses.join(" AND ");
}

// Run one `SELECT … STARTPOSITION n MAXRESULTS k` as a single /batch Query item.
// Returns the entity rows (the QueryResponse array), or [] when the page is empty.
async function runBatchQuery(quickbooks: any, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    quickbooks.batch([{ bId: "q", Query: sql }], (err: any, response: any) => {
      if (err) return reject(err);
      const item = response?.BatchItemResponse?.[0];
      if (item?.Fault) {
        return reject(new Error(JSON.stringify(item.Fault)));
      }
      const queryResponse = item?.QueryResponse ?? {};
      // The rows live under the entity-named key; pick the first array value.
      const arrayKey = Object.keys(queryResponse).find((k) =>
        Array.isArray(queryResponse[k]),
      );
      resolve(arrayKey ? queryResponse[arrayKey] : []);
    });
  });
}

// Run one page resilient to mid-pagination token expiry. `getInstance()`
// refreshes proactively (5-min buffer) and is re-fetched per page so a long
// `fetchAll` never reuses one instance across the ~60-min token boundary. The
// reactive arm covers QBO expiring the token earlier than the client's own
// estimate (which is why a long deploy's pull died at ~60 min, errorCode
// 003200): on a token-expiry error, force a refresh — QBO is the authority that
// just rejected the token, so we don't trust `isTokenExpiredOrExpiringSoon` —
// rebuild the instance, and retry the page once.
async function runBatchQueryResilient(sql: string): Promise<any[]> {
  const quickbooks = await QuickbooksClient.getInstance();
  try {
    return await runBatchQuery(quickbooks, sql);
  } catch (error) {
    if (!isTokenExpiry(error)) throw error;
    await quickbooksClient.refreshAccessToken();
    const refreshed = await quickbooksClient.authenticate();
    return await runBatchQuery(refreshed, sql);
  }
}

export async function queryQuickbooksEntity(
  data: QueryEntityInput,
): Promise<ToolResponse<any[]>> {
  if (!SUPPORTED_ENTITIES.includes(data.entity)) {
    return {
      result: null,
      isError: true,
      error: `Unsupported entity '${data.entity}'. Known: ${SUPPORTED_ENTITIES.join(", ")}`,
    };
  }
  try {
    const limit = data.limit ?? 1000;
    const base = `select * from ${data.entity}${buildWhereClause(data.where)}`;

    if (data.fetchAll) {
      const all: any[] = [];
      let start = 1; // QBO STARTPOSITION is 1-based
      // Sequential single-item /batch calls: one Query per page, paginate until
      // a short page. (The /batch 30-op cap is per call, so one page per call
      // is always safe.) Each page is token-resilient, so a long pull survives
      // the access-token expiry boundary.
      for (;;) {
        const page = await runBatchQueryResilient(
          `${base} STARTPOSITION ${start} MAXRESULTS ${limit}`,
        );
        all.push(...page);
        if (page.length < limit) break;
        start += limit;
      }
      return { result: all, isError: false, error: null };
    }

    const offset = data.offset ?? 1;
    const rows = await runBatchQueryResilient(
      `${base} STARTPOSITION ${offset} MAXRESULTS ${limit}`,
    );
    return { result: rows, isError: false, error: null };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
