# Upstream PR draft — batch operations

Branch: `batch-operations` (fork `a-horde-o-bees/quickbooks-online-mcp-server`, commit `56df418`, rebased on `upstream/main` @ `0993518`; pushed to the fork 2026-08-07).
Submission steps per upstream `CONTRIBUTING.md`: file (or reference) a feature issue first, push the branch to the fork (`git push origin batch-operations`), then open the PR from the GitHub UI. The commit message should gain the issue number once one exists (amend or note in the PR body).

---

**Title:** Add batch_request and query_entity tools (QBO /batch operations)

## What

Two tools exposing the QBO `/batch` endpoint, which the server does not currently cover:

- **`batch_request`** — submit up to 30 create/update/delete/query operations in a single API call. Items carry caller-assigned `bId`s for response matching, and mutate items accept `optionsData` (e.g. `void`). Malformed input — duplicate `bId`s, a mutate item missing its payload, an item mixing `query` with mutate fields, more than 30 items — is rejected with an actionable error before any API call.
- **`query_entity`** — one entity-agnostic paginated read (`SELECT * FROM <entity>` with `STARTPOSITION`/`MAXRESULTS`) for all 29 entity types the server serves, with typed `where` criteria (`=`, `<`, `>`, `<=`, `>=`, `LIKE`, `IN`) and an optional `fetchAll` that paginates to completion.

## Why

- **Throughput.** Bulk workloads (imports, migrations, mass updates) currently need one API call per record; `/batch` cuts up to 30× off the round-trips. Proven under a production migration workload pushing tens of thousands of transactions.
- **Uniform pagination.** The per-entity `search_*` tools paginate inconsistently; `query_entity` gives one pagination contract for every entity.
- **Referenceable reads.** The `/batch` Query operation returns only live, referenceable records. Soft-deleted records read `Active=true` via the GET `/query` endpoint the `search_*` tools ride, yet fault 2500 when referenced — reads that feed reference resolution (e.g. resolving a customer by name before creating an invoice) need the `/batch` view.

## Design notes

- **Paging is validated, never clamped**: QBO silently returns at most 1000 rows for an oversized `MAXRESULTS` instead of faulting, which would make `fetchAll`'s short-page termination silently truncate — so `limit` outside 1..1000 is rejected.
- **Token-expiry resilience**: a long `fetchAll` re-fetches the client per page (proactive refresh) and retries a page once on a reactive expiry (`003200`), covering QBO expiring the token before the client's own estimate. `batch_request` re-sends once after a forced refresh on a request-level 401 — duplicate-safe because a 401 rejects the whole batch before any item is processed. The shared predicate serializes non-Error rejections (node-quickbooks rejects a request-level 401 with the parsed body object, which `String()` flattens to `"[object Object]"`).
- **Error convention**: both tools return failures as text content, matching every existing tool.
- `optionsData` passes through verbatim; its semantics stay QBO's (per the official .NET/PHP SDK Batch implementations).

## Testing

- 35 unit tests across the two handlers; every added file at 100% statement/branch/function/line coverage.
- Full suite green on top of current `main` (639 tests).
- Live-verified against a QBO sandbox (2026-08-07): a 1,116-payment corpus seeded through `batch_request` itself (37 batches, 0 faults, ~1,000 ops/min); `query_entity` paginated it Id-ordered with no duplicates or gaps; a 30-item batch with one bad item landed 29 with one item-level fault and the 29 batch-deleted cleanly; every malformed-input case (duplicate `bId`, >30 items, query/mutate hybrid, payload-less mutate, out-of-range limit, unknown entity) rejected with an actionable error before any API call.
