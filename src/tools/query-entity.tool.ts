import {
  queryQuickbooksEntity,
  SUPPORTED_ENTITIES,
  SUPPORTED_OPERATORS,
} from "../handlers/query-quickbooks-entity.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "query_entity";
const toolDescription =
  "Entity-agnostic paginated read: SELECT * FROM <entity> with STARTPOSITION/MAXRESULTS, " +
  "issued over the QBO /batch Query endpoint. Returns the live, REFERENCEABLE set: " +
  "soft-deleted and 'Clear data and reset' tombstones (which read Active=true via the " +
  "standalone /query endpoint yet fault 2500 when referenced) are excluded. One uniform " +
  `pagination path for any supported QBO entity (${SUPPORTED_ENTITIES.join(", ")}). ` +
  "Prefer this for bulk/programmatic reads over the per-entity search_* tools, " +
  "which go through /query and surface tombstones.";

const criterionSchema = z.object({
  field: z
    .string()
    .describe("Entity property to filter on, e.g. 'Active' or 'MetaData.LastUpdatedTime'."),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number()])),
    ])
    .describe("Comparison value; an array (of strings/numbers) only with the IN operator."),
  operator: z
    .enum(SUPPORTED_OPERATORS as [string, ...string[]])
    .optional()
    .describe("Comparison operator; defaults to '='."),
});

const toolSchema = z.object({
  entity: z
    .string()
    .describe("QBO entity name, e.g. 'Invoice', 'CreditMemo', 'Customer'."),
  where: z
    .array(criterionSchema)
    .optional()
    .describe("Optional filters, ANDed together."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Page size / MAXRESULTS (QBO caps at 1000; default 1000)."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based STARTPOSITION (default 1)."),
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
