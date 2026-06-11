import { formatError } from "./format-error.js";

// QBO access-token expiry, surfaced by a /batch Fault or a transport error.
// `formatError` JSON-stringifies a non-Error value — a request-level 401
// rejects with node-quickbooks' parsed body OBJECT, which `String()` would
// flatten to "[object Object]" and never match (the 2026-06-11 walk kills:
// four ~60-min deploys died on 003200 with the read retry already in place).
export const TOKEN_EXPIRY_MARKERS = ["003200", "token expired", "authenticationfailed"];

export function isTokenExpiry(error: unknown): boolean {
  const msg = formatError(error).toLowerCase();
  return TOKEN_EXPIRY_MARKERS.some((marker) => msg.includes(marker));
}
