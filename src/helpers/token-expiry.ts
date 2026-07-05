import { formatError } from "./format-error.js";

// QBO access-token expiry, surfaced by a /batch Fault or a transport error.
// The predicate serializes through `formatError` (JSON for non-Error values):
// a request-level 401 rejects with node-quickbooks' parsed body OBJECT, which
// `String()` would flatten to "[object Object]" and never match.
export const TOKEN_EXPIRY_MARKERS = ["003200", "token expired", "authenticationfailed"];

export function isTokenExpiry(error: unknown): boolean {
  const msg = formatError(error).toLowerCase();
  return TOKEN_EXPIRY_MARKERS.some((marker) => msg.includes(marker));
}
