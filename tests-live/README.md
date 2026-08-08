# tests-live — TDD proofs against a live QBO sandbox

Live integration suite for the fork's overlay claims: each claim is proven
TDD-style — the **stock upstream build fails it** (the defect or gap is
reproduced live), the **fork build passes it** — against the dedicated
"Integration Testing Sandbox" realm (`migration.toml` target
`integration-testing`). Rides `monaco-overlays` beside `ARCHITECTURE.md`;
excluded from upstream cherry-picks.

## Safety

`run.py` hard-aborts unless the bound realm's live `CompanyName` is exactly
`Integration Testing Sandbox` — it seeds and mutates thousands of records and
must never touch a migration realm (`monaco-sandbox-*`, prod).

## Running

From the project root (the python driver rides `qbo_pipeline`):

```
# fork build (the checked-out dist/): seed + all fork claims
uv run python quickbooks-online-mcp-server/tests-live/run.py --server fork

# stock upstream baseline (defect/gap reproduction)
uv run python quickbooks-online-mcp-server/tests-live/run.py --server stock \
    --stock-dir <extracted+built upstream tree>
```

Run `fork` first (it seeds the >1000-payment corpus the fetchAll claim needs),
then `stock`. Runs are strictly sequential — the two builds share the realm's
OAuth refresh token, and `run.py` syncs a rotated token back to the canonical
`.env` after a stock run.

The stock baseline is an exact-sha GitHub tarball, extracted and built —
no git involvement (the box stays closed):

```
curl -sL https://codeload.github.com/intuit/quickbooks-online-mcp-server/tar.gz/<sha> | tar -xz
cd quickbooks-online-mcp-server-<sha> && npm ci && npm run build
```

## Claims matrix

| Claim | Stock expectation (defect proven) | Fork expectation |
| --- | --- | --- |
| `fetchall` — `search_payments` full pull | returns one page (≤1000) of a >1000 corpus; `fetchAll` isn't even in its schema | returns the full corpus |
| `absence` — `/batch` surface | `batch_request` / `query_entity` don't exist | n/a (their behavior is the claims below) |
| `validation` — batch surface self-limiting | n/a | duplicate `bId`, >30 items, query/mutate hybrid, payload-less mutate, `limit` 0/1001, unknown entity: each **rejected with an actionable error, never clamped or truncated** |
| `faults` — per-item isolation | n/a | a 30-item batch with one bad item: 29 land, 1 item-level fault; the 29 batch-delete cleanly |
| `pagination` — `query_entity` | n/a | Id-ordered pages, no duplicates or gaps across page boundaries, union == total |
| `vendor-strip` — create-vendor field fidelity | valid Vendor fields outside the strict 6-field schema (`AcctNum`, custom `PrintOnCheckName`, `BillAddr.Line2/3`) are **silently stripped** before the API call | typed + `.passthrough()` schema persists every QBO-storable field, verified on the created record (`Notes` is no probe — QBO's Vendor entity discards it regardless of schema) |
| `cycle` — full transaction cycle + report verification | n/a (batch/query absent) | every transaction type the migration pushes — Invoice, CreditMemo, Payment (applied via LinkedTxn), JournalEntry, Bill, BillPayment (linked), VendorCredit, Purchase, PurchaseOrder, plus Vendor/Item masters — created through `batch_request`, read back per type via `query_entity`, verified as **exact before/after deltas on all five report tools** (P&L income/expense, Balance Sheet assets == liabilities+equity, Trial Balance still balanced, A/R and A/P agings), then batch-deleted in link order |
| `tombstones` (informational) | — | `query_entity` (`/batch`) vs `search_accounts` (`/query`) Account populations; equal on a never-reset realm, diverging after a UI "Clear data and reset" (browser-only — run it to arm this claim) |

Deferred from live scope (already proven elsewhere):

- **401 heal / re-send** — needs a token that expires mid-run; not forceable
  black-box. Proven by unit tests covering the transport-level 401 shape
  (`DECISIONS.md` § "query_entity survives the access-token boundary", incl.
  the 2026-06-11 scar) and by four ~60-min deploys that previously died there.
- **Seeding is the volume proof**: the corpus is created through
  `batch_request` itself (30-item chunks via `batch_create_all`), so a green
  seed run is the batching-throughput exercise.
