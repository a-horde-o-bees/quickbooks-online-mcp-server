import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

// QBO entity name -> node-quickbooks find method. Every findX delegates to the
// same `module.query(qbo, entity, criteria)` primitive, which honors
// {field:'limit'|'offset'|'fetchAll'} entries in a criteria array (STARTPOSITION
// / MAXRESULTS). Dispatching here gives one uniform, paginated read path for any
// entity — no per-entity tool drift. The QueryResponse key is the entity name.
const ENTITY_FIND: Record<string, string> = {
  Account: "findAccounts",
  Term: "findTerms",
  PaymentMethod: "findPaymentMethods",
  TaxCode: "findTaxCodes",
  Customer: "findCustomers",
  Vendor: "findVendors",
  Item: "findItems",
  Invoice: "findInvoices",
  CreditMemo: "findCreditMemos",
  PurchaseOrder: "findPurchaseOrders",
  Purchase: "findPurchases",
  JournalEntry: "findJournalEntries",
  Payment: "findPayments",
};

export interface QueryEntityInput {
  entity: string;
  where?: Array<Record<string, any>>;
  limit?: number;
  offset?: number;
  fetchAll?: boolean;
}

export async function queryQuickbooksEntity(
  data: QueryEntityInput
): Promise<ToolResponse<any[]>> {
  const method = ENTITY_FIND[data.entity];
  if (!method) {
    return {
      result: null,
      isError: true,
      error: `Unsupported entity '${data.entity}'. Known: ${Object.keys(ENTITY_FIND).join(", ")}`,
    };
  }
  try {
    const quickbooks = await QuickbooksClient.getInstance();
    // Pagination rides as {field,value} criteria entries — the array form
    // node-quickbooks' module.query parses for STARTPOSITION/MAXRESULTS.
    const criteria: Array<Record<string, any>> = [...(data.where ?? [])];
    criteria.push({ field: "limit", value: data.limit ?? 1000 });
    criteria.push({ field: "offset", value: data.offset ?? 1 });
    if (data.fetchAll) criteria.push({ field: "fetchAll", value: true });
    return new Promise((resolve) => {
      (quickbooks as any)[method](criteria, (err: any, result: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          resolve({
            result: result?.QueryResponse?.[data.entity] || [],
            isError: false,
            error: null,
          });
        }
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
