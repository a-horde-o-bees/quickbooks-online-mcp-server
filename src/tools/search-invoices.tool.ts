import { searchQuickbooksInvoices } from "../handlers/search-quickbooks-invoices.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "search_invoices";
const toolDescription = "Search invoices in QuickBooks Online using criteria (maps to node-quickbooks findInvoices).";

// ALLOWED FIELD LISTS (derived from Quickbooks Invoice entity docs – Filterable and Sortable columns)
const ALLOWED_FILTER_FIELDS = [
  "Id",
  "MetaData.CreateTime",
  "MetaData.LastUpdatedTime",
  "DocNumber",
  "TxnDate",
  "DueDate",
  "CustomerRef",
  "ClassRef",
  "DepartmentRef",
  "Balance",
  "TotalAmt",
] as const;

const ALLOWED_SORT_FIELDS = [
  "Id",
  "MetaData.CreateTime",
  "MetaData.LastUpdatedTime",
  "DocNumber",
  "TxnDate",
  "Balance",
  "TotalAmt",
] as const;

// FIELD TYPE MAP
const FIELD_TYPE_MAP = {
  "Id": "string",
  "MetaData.CreateTime": "date",
  "MetaData.LastUpdatedTime": "date",
  "DocNumber": "string",
  "TxnDate": "date",
  "DueDate": "date",
  "CustomerRef": "string",
  "ClassRef": "string",
  "DepartmentRef": "string",
  "Balance": "number",
  "TotalAmt": "number",
} as const;

// Helper function to check if the value type matches the expected type for the field
const isValidInvoiceValueType = (field: string, value: any): boolean => {
  const expectedType = FIELD_TYPE_MAP[field as keyof typeof FIELD_TYPE_MAP];
  return typeof value === expectedType;
};

// Zod schemas that validate the fields against the white-lists
const filterableFieldSchema = z
  .string()
  .refine((val) => (ALLOWED_FILTER_FIELDS as readonly string[]).includes(val), {
    message: `Field must be one of: ${ALLOWED_FILTER_FIELDS.join(", ")}`,
  });

const sortableFieldSchema = z
  .string()
  .refine((val) => (ALLOWED_SORT_FIELDS as readonly string[]).includes(val), {
    message: `Sort field must be one of: ${ALLOWED_SORT_FIELDS.join(", ")}`,
  });

// Criteria can be advanced
const operatorSchema = z.enum(["=", "IN", "<", ">", "<=", ">=", "LIKE"]).optional();
const filterSchema = z.object({
  field: filterableFieldSchema,
  value: z.any(),
  operator: operatorSchema,
}).superRefine((obj, ctx) => {
  if (!isValidInvoiceValueType(obj.field as string, obj.value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Value type does not match expected type for field ${obj.field}`,
    });
  }
});

const advancedCriteriaSchema = z.object({
  filters: z.array(filterSchema).optional(),
  asc: sortableFieldSchema.optional(),
  desc: sortableFieldSchema.optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  count: z.boolean().optional(),
  fetchAll: z.boolean().optional(),
});

// Runtime schema used internally for validation
const RUNTIME_CRITERIA_SCHEMA = z.union([
  z.record(z.any()),
  z.array(z.record(z.any())),
  advancedCriteriaSchema,
]);

// Exposed schema – use broad type to prevent deep $ref issues.
// OVERLAY (search-fetchall-fix): declare the sibling pagination options so the
// MCP framework forwards them to the handler instead of stripping to `criteria`.
const toolSchema = z.object({
  criteria: z.any(),
  asc: z.string().optional(),
  desc: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  count: z.boolean().optional(),
  fetchAll: z.boolean().optional(),
});

const toolHandler = async ({ params }: any) => {
  // OVERLAY (search-fetchall-fix): capture sibling pagination options alongside
  // `criteria`. Upstream destructured only `criteria`, dropping the sibling
  // `fetchAll` clients send, so findInvoices capped at one 1000-row page.
  const { criteria = [], ...options } = params ?? {};

  // Validate runtime schema
  const parsed = RUNTIME_CRITERIA_SCHEMA.safeParse(criteria);
  if (!parsed.success) {
    return {
      content: [
        { type: "text" as const, text: `Invalid criteria: ${parsed.error.message}` },
      ],
    };
  }

  // Fold the sibling options into an advanced-options object the handler's
  // buildQuickbooksSearchCriteria converts to the {field,value} pagination
  // entries node-quickbooks honors (e.g. {field:"fetchAll",value:true}).
  const criteriaToSend =
    Object.keys(options).length === 0
      ? criteria
      : Array.isArray(criteria)
        ? { filters: criteria, ...options }
        : { ...(criteria ?? {}), ...options };

  const response = await searchQuickbooksInvoices(criteriaToSend);

  if (response.isError) {
    return {
      content: [
        { type: "text" as const, text: `Error searching invoices: ${response.error}` },
      ],
    };
  }
  const invoices = response.result;
  return {
    content: [
      { type: "text" as const, text: `Found ${invoices?.length || 0} invoices` },
      ...(invoices?.map((inv) => ({ type: "text" as const, text: JSON.stringify(inv) })) || []),
    ],
  };
};

export const SearchInvoicesTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
}; 