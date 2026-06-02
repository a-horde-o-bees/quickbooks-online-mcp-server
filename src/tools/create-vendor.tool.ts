// QBO-MCP-EXTENSION:vendor-tools — full replacement of upstream create-vendor.
// Two upstream defects this overlay fixes:
//   1. Schema declared `vendor: z.object({...})` with only 6 fields, silently
//      stripping everything else (Active, Vendor1099, CurrencyRef, Notes,
//      TermRef, Fax, WebAddr, PrintOnCheckName, etc.). Relaxed to z.any() to
//      mirror create-customer's contract.
//   2. Handler read `args.vendor` directly; the MCP SDK passes
//      `{params: {vendor: ...}}` so the handler saw undefined. Aligned with
//      create-customer's `args.params.vendor` access pattern.

import { createQuickbooksVendor } from "../handlers/create-quickbooks-vendor.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "create-vendor";
const toolDescription = "Create a vendor in QuickBooks Online.";
const toolSchema = z.object({
  vendor: z.any(),
});

const toolHandler = async (args: any) => {
  const response = await createQuickbooksVendor(args.params.vendor);

  if (response.isError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error creating vendor: ${response.error}`,
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

export const CreateVendorTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
