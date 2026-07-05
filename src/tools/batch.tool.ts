import { batchQuickbooks, BatchItem } from "../handlers/batch-quickbooks.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "batch_request";
const toolDescription =
  "Submit up to 30 QuickBooks Online operations in a single API call via the /batch endpoint. " +
  "Each item carries a caller-assigned unique bId for response matching. Mutate items pass " +
  "{operation: create|update|delete, entity_type, entity} plus optional optionsData " +
  "(e.g. 'void' to void instead of delete where the entity supports it); query items pass {query}. " +
  "The two item forms are mutually exclusive. On a token-expiry 401 the request is retried once " +
  "after a token refresh (safe: a 401 rejects the whole batch before any item is processed). " +
  "Caller chunks any work over 30 items.";

const batchItemSchema = z.object({
  bId: z.string().min(1).describe("Caller-assigned identifier, unique within the batch; matches request to response in the result array"),
  operation: z.enum(["create", "update", "delete"]).optional().describe("Mutate operation; required unless 'query' is set"),
  entity_type: z.string().optional().describe("QBO entity type, e.g. 'Customer', 'Invoice', 'Bill'; required for mutate ops"),
  entity: z.any().optional().describe("Entity payload matching the entity_type schema; required for mutate ops"),
  optionsData: z.string().optional().describe("Request options passed through to the batch item, e.g. 'void' to void the referenced transaction; mutate items only"),
  query: z.string().optional().describe("Read-only QBO Query; e.g. \"select * from Customer where Active=true\". Mutually exclusive with operation/entity_type/entity/optionsData"),
});

const toolSchema = z.object({
  items: z.array(batchItemSchema).min(1).max(30).describe("Batch of operations; max 30 per QBO API limit"),
});

type ToolParams = z.infer<typeof toolSchema>;

const toolHandler = async (args: any) => {
  const params: ToolParams = args.params;
  const response = await batchQuickbooks(params.items as BatchItem[]);

  if (response.isError) {
    return {
      content: [
        { type: "text" as const, text: `Error in batch_request: ${response.error}` },
      ],
    };
  }

  return {
    content: [
      { type: "text" as const, text: `Batch processed ${params.items.length} item(s):` },
      { type: "text" as const, text: JSON.stringify(response.result) },
    ],
  };
};

export const BatchRequestTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
