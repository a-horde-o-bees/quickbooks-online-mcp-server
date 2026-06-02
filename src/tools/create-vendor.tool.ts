import { createQuickbooksVendor } from "../handlers/create-quickbooks-vendor.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "create-vendor";
const toolDescription = "Create a vendor in QuickBooks Online.";
const toolSchema = z.object({
  // OVERLAY (vendor-tools): relax to z.any(). Upstream's explicit schema lists
  // only ~6 fields and silently strips the rest (Active, Vendor1099, TermRef,
  // CurrencyRef, Notes, WebAddr, …); mirror the create-customer contract. The
  // args.params unwrap is upstream's now (PR #22), so it's no longer part of
  // this overlay — schema-relax is all that remains.
  vendor: z.any(),
});

const toolHandler = async (args: { [x: string]: any }) => {
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

  const vendor = response.result;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(vendor),
      }
    ],
  };
};

export const CreateVendorTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
}; 