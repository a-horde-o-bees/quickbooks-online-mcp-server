// QBO-MCP-EXTENSION:vendor-tools — full replacement of upstream update-vendor.
// Same defects + fix as the create-vendor overlay: relax schema to z.any() and
// read `args.params.vendor` instead of `args.vendor` so payloads survive the
// MCP SDK's params-wrapping.

import { updateQuickbooksVendor } from "../handlers/update-quickbooks-vendor.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "update-vendor";
const toolDescription = "Update a vendor in QuickBooks Online.";
const toolSchema = z.object({
  vendor: z.any(),
});

const toolHandler = async (args: any) => {
  const response = await updateQuickbooksVendor(args.params.vendor);

  if (response.isError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error updating vendor: ${response.error}`,
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

export const UpdateVendorTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
