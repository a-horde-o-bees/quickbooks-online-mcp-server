// QBO-MCP-EXTENSION:vendor-tools — full replacement of upstream get-vendor.
// Upstream read `args.id`; the SDK passes `{params: {id: ...}}` so the lookup
// resolved to undefined. Aligned with get_customer's `args.params.id` pattern.

import { getQuickbooksVendor } from "../handlers/get-quickbooks-vendor.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "get-vendor";
const toolDescription = "Get a vendor by Id from QuickBooks Online.";
const toolSchema = z.object({
  id: z.string(),
});

const toolHandler = async (args: any) => {
  const response = await getQuickbooksVendor(args.params.id);

  if (response.isError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error getting vendor: ${response.error}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(response.result),
      },
    ],
  };
};

export const GetVendorTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
