import { queryQuickbooksEntity } from "../handlers/query-quickbooks-entity.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "query_entity";
const toolDescription =
  "Entity-agnostic paginated read: SELECT * FROM <entity> with STARTPOSITION/MAXRESULTS. " +
  "One uniform pagination path for any supported QBO entity (Account, Term, PaymentMethod, " +
  "TaxCode, Customer, Vendor, Item, Invoice, CreditMemo, PurchaseOrder, Purchase, " +
  "JournalEntry, Payment). Prefer this for bulk/programmatic reads over the per-entity " +
  "search_* tools, whose pagination support is inconsistent.";

const toolSchema = z.object({
  entity: z
    .string()
    .describe("QBO entity name, e.g. 'Invoice', 'CreditMemo', 'Customer'."),
  where: z
    .array(z.any())
    .optional()
    .describe(
      "Optional filters as {field,value,operator?} objects (e.g. {field:'Active',value:false})."
    ),
  limit: z
    .number()
    .optional()
    .describe("Page size / MAXRESULTS (QBO caps at 1000; default 1000)."),
  offset: z.number().optional().describe("1-based STARTPOSITION (default 1)."),
  fetchAll: z
    .boolean()
    .optional()
    .describe(
      "Auto-paginate to fetch all results in one call. Convenient but unbounded — " +
        "for large entities prefer external limit/offset paging to keep responses bounded."
    ),
});

const toolHandler = async ({ params }: any) => {
  const response = await queryQuickbooksEntity(params);
  if (response.isError) {
    return {
      content: [
        { type: "text" as const, text: `Error querying ${params?.entity}: ${response.error}` },
      ],
    };
  }
  const rows = response.result ?? [];
  return {
    content: [
      { type: "text" as const, text: `Found ${rows.length} ${params.entity} record(s):` },
      ...rows.map((r: any) => ({ type: "text" as const, text: JSON.stringify(r) })),
    ],
  };
};

export const QueryEntityTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
