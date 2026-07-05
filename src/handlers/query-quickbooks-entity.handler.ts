import { QuickbooksClient, quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { isTokenExpiry } from "../helpers/token-expiry.js";

// Entity-agnostic paginated read, issued over the QBO /batch Query operation
// (POST), NOT node-quickbooks' findX (GET /query).
//
// Why /batch and not /query: soft-deleted records (including everything left
// behind by a QBO "Clear data and reset") read `Active: true` via get-by-Id
// and via the GET /query endpoint, yet are unreferenceable — creating a
// dependent that points at one faults 2500 "made inactive", and they hold
// their name against recreation (fault 6240). No field distinguishes them;
// the endpoint does. The /batch Query operation returns only the live,
// referenceable set, so reads that feed reference resolution must use it.

// Entity names accepted in the FROM clause. Every entity the server's tool
// surface serves; the allowlist is also what makes the SQL interpolation safe.
export const SUPPORTED_ENTITIES: readonly string[] = [
  "Account", "Attachable", "Bill", "BillPayment", "Budget", "Class",
  "CreditMemo", "Customer", "Department", "Deposit", "Employee", "Estimate",
  "Invoice", "Item", "JournalEntry", "Payment", "PaymentMethod", "Purchase",
  "PurchaseOrder", "RefundReceipt", "SalesReceipt", "TaxAgency", "TaxCode",
  "TaxRate", "Term", "TimeActivity", "Transfer", "Vendor", "VendorCredit",
];

export const SUPPORTED_OPERATORS: readonly string[] = [
  "=", "<", ">", "<=", ">=", "LIKE", "IN",
];

// Entity property path, e.g. `Balance` or `MetaData.LastUpdatedTime`.
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9._]*$/;

// QBO caps MAXRESULTS at 1000; a larger value would silently truncate
// fetchAll pagination (a full page would read as a short one).
const MAX_PAGE_SIZE = 1000;

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

// Build the WHERE clause, or return a string error for an invalid criterion.
function buildWhereClause(
  where?: QueryEntityInput["where"],
): { clause: string } | { badCriterion: string } {
  if (!where || where.length === 0) return { clause: "" };
  const clauses: string[] = [];
  for (const c of where) {
    if (typeof c.field !== "string" || !FIELD_PATTERN.test(c.field)) {
      return { badCriterion: `invalid field '${c.field}'` };
    }
    const operator = c.operator ?? "=";
    if (!SUPPORTED_OPERATORS.includes(operator)) {
      return {
        badCriterion: `unsupported operator '${operator}' (known: ${SUPPORTED_OPERATORS.join(", ")})`,
      };
    }
    if (operator === "IN") {
      if (!Array.isArray(c.value) || c.value.length === 0) {
        return { badCriterion: `operator IN requires a non-empty array value (field '${c.field}')` };
      }
      clauses.push(`${c.field} IN (${c.value.map(toSqlLiteral).join(", ")})`);
      continue;
    }
    clauses.push(`${c.field} ${operator} ${toSqlLiteral(c.value)}`);
  }
  return { clause: " WHERE " + clauses.join(" AND ") };
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
// `fetchAll` never reuses one instance across the access-token boundary. The
// reactive arm covers QBO expiring the token earlier than the client's own
// estimate: on a token-expiry error, force a refresh — QBO is the authority
// that just rejected the token — rebuild the instance, and retry the page once.
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
  if (
    data.limit !== undefined &&
    (!Number.isInteger(data.limit) || data.limit < 1 || data.limit > MAX_PAGE_SIZE)
  ) {
    return {
      result: null,
      isError: true,
      error: `limit must be an integer in 1..${MAX_PAGE_SIZE} (QBO MAXRESULTS cap); got ${data.limit}`,
    };
  }
  if (
    data.offset !== undefined &&
    (!Number.isInteger(data.offset) || data.offset < 1)
  ) {
    return {
      result: null,
      isError: true,
      error: `offset must be an integer >= 1 (QBO STARTPOSITION is 1-based); got ${data.offset}`,
    };
  }
  const whereResult = buildWhereClause(data.where);
  if ("badCriterion" in whereResult) {
    return { result: null, isError: true, error: `Invalid where criterion: ${whereResult.badCriterion}` };
  }

  try {
    const limit = data.limit ?? MAX_PAGE_SIZE;
    const base = `select * from ${data.entity}${whereResult.clause}`;

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
