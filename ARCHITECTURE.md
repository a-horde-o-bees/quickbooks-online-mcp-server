# Architecture — quickbooks-online-mcp-server (our fork)

How the project-owned fork of Intuit's `quickbooks-online-mcp-server` diverges from upstream, how the project binds to and authenticates it, and the OAuth callback tunnel the consent flow runs over.

This file and `DECISIONS.md` ride on the fork branch and are excluded when cherry-picking commits upstream.

## Divergence from upstream

Overlays land as native commits on the fork's `monaco-overlays` branch:

- `batch_request` — chunked + concurrent batch create/update/delete; the throughput backbone for pushes.
- `force-reauth` — `auth-server` clears stale in-memory tokens on re-auth so a fresh consent recovers from invalidated state.
- `vendor-tools` — schema-relax only, post upstream PR #22.
- `search-payments` — `fetchAll` for >1000-record pulls.
- `search-fetchall-fix` — `search_invoices` / `search_items` / `search_accounts` previously discarded the sibling `fetchAll` (destructured only `criteria`), capping pulls at one 1000-row page; they now fold options into criteria like `search_customers` / `search_payments`, so `fetchAll` paginates fully (verified: 13,867 invoices). Upstream candidate.

These overlays are native commits on `monaco-overlays`, layered on the upstream base and reconciled forward by merging `upstream/main` (conflicts in the overlaid files are where the adaptation happens). The former `apply.sh` / `--extensions` marker-block framework that held them as patches is retired — superseded by these commits, and prone to a failure mode that bit us once: an in-place edit with no backing overlay file was silently clobbered by a `git submodule update`.

## Error convention — text at the tool boundary, never MCP `isError`

Tools flatten a failure to a text content block (`Error <verb> <entity>: ${error}`, `Error in batch_request: …`) and **never set the MCP result's `isError`**. `isError` lives only in the handler return shape (`{ isError, error, result }`); the tool layer reads it and emits text. This is upstream's convention across all ~143 tools, and overlays follow it exactly (`batch_request`, the paginated `search_*`, the relaxed vendor tools) — so the client sees one error shape whether it calls an upstream-unaltered tool or an overlay.

The client (`qbo_pipeline._mcp_client`) conforms to that contract: a result whose text begins `Error ` is treated as the failure — `call_tool` retries the retryable ones (so the fork refreshes on, e.g., an access-token-expiry `Error searching … token expired`), and `fetch_records` raises the rest. Batch keeps **per-record** faults: `batch_request` returns each item's outcome and `_dispatch_batch` parses them per-item — a batch is never collapsed to one error.

Do **not** propagate `isError` to the MCP result to "correct" this: it would diverge from upstream on every tool and conflict on each forward-merge of `upstream/main`. Mirror upstream; the client conforms.

## How the project binds to this server

`qbo_pipeline._mcp_client` launches the server as a stdio subprocess — one per pipeline verb run — reading `quickbooks-online-mcp-server/.env` at launch to bind the QuickBooks client to the active realm, so `switch-target` rebinds with no session restart. Path resolution: `QBO_MCP_ENTRY` / `QBO_MCP_DIR` env overrides, else `<project-root>/quickbooks-online-mcp-server/dist/index.js`. `qbo_pipeline._target_verify` confirms the active `.env` matches the requested target before any read/write. Subprocess lifecycle, concurrency cap, and rate limiting are detailed in `qbo-pipeline/ARCHITECTURE.md` § "MCP transport, rate, and concurrency limits". The project does **not** register this server as a session-bound agent MCP server — see `qbo-pipeline/DECISIONS.md`.

## OAuth callback tunnel

Intuit production apps reject `http://localhost` redirect URIs, so the QBO consent flow needs an HTTPS-reachable callback. An ngrok tunnel forwards `https://blouse-boastful-tigress.ngrok-free.dev/callback` — the reserved subdomain registered as the redirect URI in both `.env.stage` and `.env.production` — to `http://localhost:8000`, where `auth-server` listens during `npm run auth`.

`uv run python -m pipeline._ensure_ngrok` brings the tunnel up. It's idempotent: an already-running tunnel is detected and the script returns silently. A `SessionStart` hook in `.claude/settings.json` runs it on every session startup, resume, and clear, so re-auth (`env -C quickbooks-online-mcp-server npm run auth`) needs no manual setup.

## Do not probe `/callback` while `npm run auth` is running

The `auth-server` HTTP listener treats every request to `/callback` as the OAuth consent redirect — it calls `oauthClient.createToken(req.url)` on whatever query string arrives. A naked `curl https://blouse-boastful-tigress.ngrok-free.dev/callback` (e.g. a tunnel-health check) reaches the listener, supplies no authorization code, gets a 400 from Intuit's token endpoint, the script logs `✗ Authentication failed`, and exits. The user's actual browser consent then arrives at a dead listener, and the whole flow has to restart.

To check tunnel health while `npm run auth` is *not* running, hit any path other than `/callback` — the ngrok agent returns `tunnel not active` or `upstream not listening` either way, which suffices. While `npm run auth` *is* running, leave the tunnel alone until the script returns.

## Recovery

`npm run auth` fails with `ERR_NGROK_3200` (the offline error page) when ngrok didn't start — usually a missing auth token or the reserved domain in use elsewhere. Inspect `/tmp/ngrok-monaco-erp.log` and run `ngrok config check`. Reserved-subdomain and authtoken setup are in `setup.sh`.

`npm run auth` fails with `400 invalid_grant` from `refreshUsingToken` when the active env's `REFRESH_TOKEN` was invalidated server-side. The `force-reauth` overlay routes `auth-server` past this; if the failure surfaces anyway, confirm `dist` is built from this branch (`npm install && npm run build`) and that `dist/auth-server.js` references `forceReauth`.
