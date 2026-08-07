import { updateQuickbooksVendor } from "../handlers/update-quickbooks-vendor.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "update-vendor";
const toolDescription = "Update a vendor in QuickBooks Online.";
// OVERLAY (vendor-tools): upstream's typed schema + .passthrough() on the
// object levels so valid QBO Vendor fields that aren't in the schema (e.g.
// Active, PrintOnCheckName, AcctNum, Notes, TermRef, Vendor1099) aren't
// silently stripped — the same fix upstream applied to create-journal-entry
// (bef85c4) and proposes for create-vendor in PR #108. Replaces the former
// z.any() relax.
const toolSchema = z.object({
  vendor: z.object({
    Id: z.string(),
    SyncToken: z.string(),
    DisplayName: z.string(),
    GivenName: z.string().optional(),
    FamilyName: z.string().optional(),
    CompanyName: z.string().optional(),
    PrimaryEmailAddr: z.object({
      Address: z.string().optional(),
    }).passthrough().optional(),
    PrimaryPhone: z.object({
      FreeFormNumber: z.string().optional(),
    }).passthrough().optional(),
    BillAddr: z.object({
      Line1: z.string().optional(),
      Line2: z.string().optional(),
      Line3: z.string().optional(),
      City: z.string().optional(),
      Country: z.string().optional(),
      CountrySubDivisionCode: z.string().optional(),
      PostalCode: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough(),
});

const toolHandler = async (args: { [x: string]: any }) => {
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

export const UpdateVendorTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
}; 