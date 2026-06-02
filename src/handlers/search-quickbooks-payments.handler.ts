import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface SearchPaymentsInput {
  customer_ref?: string;
  txn_date_from?: string;
  txn_date_to?: string;
  limit?: number;
  offset?: number;
  fetchAll?: boolean;
}

export async function searchQuickbooksPayments(data: SearchPaymentsInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    const criteria: Record<string, any> = {};

    if (data.customer_ref) {
      criteria.CustomerRef = data.customer_ref;
    }
    if (data.txn_date_from) {
      criteria.TxnDate = { $gte: data.txn_date_from };
    }
    if (data.txn_date_to) {
      criteria.TxnDate = { ...criteria.TxnDate, $lte: data.txn_date_to };
    }
    if (data.limit) {
      criteria.limit = data.limit;
    }
    if (data.offset) {
      criteria.offset = data.offset;
    }
    if (data.fetchAll) {
      criteria.fetchAll = true;
    }

    return new Promise((resolve) => {
      (quickbooks as any).findPayments(criteria, (err: any, result: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          const payments = result?.QueryResponse?.Payment || [];
          resolve({ result: payments, isError: false, error: null });
        }
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}

