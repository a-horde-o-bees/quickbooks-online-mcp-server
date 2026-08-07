# Decisions — quickbooks-online-mcp-server

The choices behind a project-owned fork of Intuit's QBO MCP server rather than overlays or a rewrite, with the alternatives weighed and their measured failure modes.

## Adopt Intuit's official server

Use `intuit/quickbooks-online-mcp-server` as the QBO MCP integration; defer a custom Python equivalent until a concrete capability gap forces it.

Why:

- Intuit owns the server, so auth refresh, realmId handling, and QBO API surface currency stay their problem.
- 143 tools across 29 entity types plus 11 financial reports cover the ledger/customer/invoice/report space without wrappers.
- TypeScript vs. Python is irrelevant to consumers — Claude Code / Desktop / Cursor launch it via `npx` from host config.
- Switching cost stays low: any custom build would mirror the same QBO entity model.

Rejected:

- Build from scratch in Python first — the 143-tool surface would have to be re-implemented before any value, and Intuit's investment continues compounding.
- Wrap a community Python server (`nikhilgy`, `hvkshetry`, `vespo92`, `geopopos`) — none match the official tool surface or test coverage (Intuit's 335 tests / 100%); maintenance falls on the wrapper author.

Re-evaluate if any of these materialize:

- A tool we need isn't in Intuit's 143 and can't be composed from existing ones.
- Node process latency or connection management becomes a bottleneck vs. in-process Python.
- A project-specific batch / cache pattern can't be expressed against the generic server.
- Intuit deprecates the server or stops tracking QBO API changes.
- Tool-level authorization or per-user scoping is required, which Intuit's server treats as process-level.

Verified 2026-04-21: research sweep across 107 QBO MCP repos plus Intuit's auth and compliance docs; official server selected.

## Fork the QBO MCP server

Maintain a project-owned fork at `https://github.com/a-horde-o-bees/quickbooks-online-mcp-server` carrying our overlays as native commits on `monaco-overlays`, rather than continuing the `apply.sh` overlay framework or rebuilding from scratch.

Why:

- Overlay count crossed five (`batch_request`, `force-reauth`, `vendor-tools`, `search-payments`, `search-fetchall-fix`), and marker-block anchor drift in `apply.sh` was accumulating per-rebase.
- Native commits replay cleanly against upstream HEAD via rebase; overlap verdicts apply as conflict resolution (drop `refresh-writeback`, superseded by upstream `19c90be`; collapse `vendor-tools` to schema-relax post upstream PR #22).
- Branching from the submodule pin first preserves a known-working baseline before replaying onto upstream HEAD.
- Stays close to upstream improvements; PR-worthy overlays (e.g. `search-fetchall-fix`) flow back upstream directly.

Rejected:

- Continue maintaining `apply.sh` — marker-block drift across five overlays makes every upstream bump a manual reconciliation; the framework is retired and `tools/quickbooks-online-mcp-server--extensions/` removed.
- Rewrite the server from scratch — the overlay count doesn't justify abandoning Intuit's 143 tools / 335 tests; same reasoning as the adopt decision above.

Verified 2026-05-19: fork stood up; overlays replayed; the overlay extensions framework marked for retirement once migration completes.

Executed 2026-06-02: overlays replayed as native commits on `26c80d4`, merged `upstream/main` (`3794133`, 27 commits) with the overlap verdicts applied as conflict resolution — `refresh-writeback` dropped (superseded by `19c90be`), `force-reauth` re-applied atop the refactored client. `apply.sh` / `--extensions` removed.

Caught up 2026-08-07: merged `upstream/main` to `0993518` (30 commits — account hierarchy #79/#81, invoice PDF #49 + template fields #92, JE strict-Zod + passthrough #80, update-bill read-merge-write #86, duplicate-OAuth-callback fix #77, save-tokens symlink fix #63, search date-filter array format #55, vendor-credit line parity #101, attachable metadata #97). Conflict resolutions: jest coverage floors — both sides kept; interactive-OAuth redirect — ours kept (env-declared with localhost fallback; upstream PR #123 proposes the same); invoice handler/tool — upstream's additive fields taken; `search-payments` offset/fetchAll re-expressed as node-quickbooks array-criteria entries to match #55's format (its stale object-shape test updated per the code). Suite 35/35 / 641 green.

Caught up 2026-06-02: merged `upstream/main` again to `8328e89` (9 more commits — attachable upload, CRUD restriction mode, P&L Classes, per-call token refresh #41). Only `client.ts` overlapped; adopted upstream's `getInstance()` per-call-refresh client and re-applied `force-reauth` (still needed — #41 fixes empty-env-var OAuth loops, not server-side-invalidated-token recovery). Then collapsed `vendor-tools` to schema-relax only: upstream PR #22 now does the `args.params` unwrap, so `get-vendor` reverts fully to upstream and `create`/`update-vendor` keep only the `z.any()` relax. Fork is current with Intuit upstream; overlays minimal.

## Vendor schemas: typed + passthrough, not `z.any()` (supersedes the schema-relax)

Replace the `vendor-tools` `z.any()` relax with upstream's typed create/update-vendor schemas extended by `BillAddr.Line2`/`Line3` and `.passthrough()` at every object level. User-ratified 2026-08-07: upstream's direction is *stricter* schemas (merged #80 replaced JE `z.any()` with real Zod; open #98 asks for more create-tool validation), so maintaining a relax patch swims against every forward-merge and hides what the tools actually accept.

Why this shape and not the alternatives:

- **The relax existed to defeat silent stripping, not to skip validation.** Upstream's 6-field vendor schema silently strips valid QBO Vendor fields the projection carries — `Active`, `PrintOnCheckName`, `AcctNum`, `Notes` (the pull's identity anchor), `BillAddr.Line2`/`Line3`. (The bulk push routes vendors through `batch_request`, which has no per-entity schema — so the strip bites single-record tool callers, e.g. repairs and generic MCP clients, not the migration's batch path.) Upstream's maintainer fixed this exact defect class on create-journal-entry with `.passthrough()` (`bef85c4`, "so valid QBO fields aren't stripped"), and open PR #108 proposes typed additions + `.passthrough()` for create-vendor — so typed + passthrough is the house pattern, and our overlay now converges with it (the eventual #108 merge collapses to their version).
- **Rejected — keep `z.any()`:** validates nothing, documents nothing, and reads as the opposite of upstream's tightening direction on every merge.
- **Rejected — conform the pipeline by sending only upstream's 6 fields:** silently dropping `Notes` breaks the pull's identity binding, and dropping recorded master data (`Active`, `AcctNum`) is the omission form of the data-honesty violation. The pipeline's payload is correct; the schema was the defect.
- **No separate upstream PR:** #108 already carries the fix upstream; if it dies, a narrow `.passthrough()`-per-`bef85c4` PR is the fallback candidate.

Verified 2026-08-07: `tsc` clean, `npm test` 26/26 suites / 494 tests green on the rewritten schemas.

## Upstream is authoritative for the API surface, not for correctness or convention

Treat Intuit's server as the source of QBO *coverage* — which entities and operations exist — but never assume its tools are correct or internally consistent. Verify behavior against our own probes/audits before depending on it; fix what's deficient.

Why — upstream has demonstrated all three failure modes:

- **Inconsistent convention from split authorship.** 8 bill/vendor tools are hyphenated (`create-bill`, `get-vendor`, …) against 134 underscore tools; single-entity reads split `get_*` (36) vs `read_*` (2 — `read_invoice`, `read_item`); the single-read param is `id` on most but `invoice_id` on `read_invoice`. That same hyphen family was also the buggiest — its `args.params` unwrap (`Issue #20`) and missing `SyncToken`/`DocNumber`/`TxnDate` bill fields were both ours to patch — so the odd naming and the bugs share a root: it was bolted on apart from the main surface.
- **Silently wrong behavior.** `search_*` discarded the `fetchAll` option and capped pulls at one 1000-row page (`search-fetchall-fix`), under-fetching whole entities with no error.
- **Undocumented validation behavior.** Duplicate-name (`6240`), Taxable-false-needs-exemption (`6000`), and currency-freeze (accepted-but-no-op) surfaced only by probing live (2026-06-08 capability sweep, `build/qbo-capability-tests/findings.jsonl`).

So, the posture:

- **Correct functional/correctness gaps in the fork, and PR them upstream.** Under-fetching, missing fields, broken unwrapping land as native commits on `monaco-overlays` and flow back upstream where generalizable (`search-fetchall-fix` is the model — an upstream candidate). Divergence is justified when it buys correctness.
- **Normalize cosmetic/ergonomic inconsistency at the client boundary, not in the fork.** The project calls a canonical regular surface; `qbo_pipeline._mcp_client` aliases it onto upstream's actual names (`qbo-pipeline/DECISIONS.md` "Canonical MCP tool surface"). Renaming in the fork would diverge ~10 files and conflict on every forward-merge for zero correctness gain — the same logic as the "Error convention" rule (mirror upstream where divergence buys nothing).

Rejected:

- **Rename to a clean surface in the fork** — permanent forward-merge conflicts on cosmetic-only edits; the client alias achieves the same ergonomics at zero merge cost.
- **Keep mirroring uncritically** — upstream ships inconsistent and sometimes-broken tools, so "it's official" is not evidence of correctness; trust only what our probes/audits confirm.

Verified 2026-06-08: naming provenance traced to upstream's first commit (`bfd03b4`, `akshit_agarwal@intuit.com`) and `86afee2` ("comprehensive API coverage with 143 tools"); our fork commits never renamed a tool. Delete-and-replace of transactions proven end-to-end on stage (the capability sweep), confirming a full wipe is a state-hygiene choice, not a capability limit.

## Reads go through the `/batch` Query endpoint, not `/query` — the live, referenceable view

`query_entity` is the project's single read tool — an entity-agnostic `SELECT * FROM <entity>` paginator that replaced the per-entity `search_*` tools, whose `fetchAll` pagination was inconsistent (some rejected paged criteria; credit-memos/POs couldn't page past 1000 at all). It issues that SELECT over the **POST `/batch`** Query operation (node-quickbooks `batch()`), never the standalone **GET `/query`** that node-quickbooks' `findX` wraps. The two endpoints disagree on what's visible, and only `/batch` returns the set you can actually reference.

**Why — the two endpoints return different populations (2026-06-08, dev).** A QBO "Clear data and reset" (and ordinary soft-deletes) leave **tombstone** records that read `Active: true` via `get_<entity>` *and* via GET `/query` — yet are unreferenceable (creating a dependent that points at one faults `2500` "…has been made inactive") and hold their name (recreation faults `6240`) and refuse reactivation (update faults `2010`). They are indistinguishable from live records on every field. The discriminator is purely the **endpoint**: `select * from Account` returned **35** rows via `/batch` vs **200** via `/query` — the 165 extra all tombstones, all reading `Active=true`, repeatable and pagination-independent (same minorversion 75). `where Name='Sales'` returned the one live `957` via `/batch` vs all five (incl. four dead) via `/query`. So a pull that resolves references off `/query` binds them to dead Ids; `/batch` is QBO's authoritative *referenceable* view.

This is a platform behavior, **identical on stock upstream** — both our former `query_entity` and upstream's `search_*` go through `findX`/`/query` and surface tombstones; our pagination overlay did not cause it. Confirmed by routing the same query through both paths in one session.

**Consequences.**

- `iter_record_pages` / `fetch_entity_index` (the pull's reference resolution) inherit the live view for free — references bind to the live record, tombstones excluded. A name that exists *only* as a tombstone resolves to nothing, so the push attempts a create and **fails loudly** (`6240`) rather than silently binding a dead Id — the correct surfacing of an unrecoverable realm.
- `/batch` caps at 30 operations per call, so a >1000-row entity paginates as **sequential single-Query `/batch` calls** (one page each) — no cap pressure.
- The `search_*` tools still ride `/query`; prefer `query_entity` for any read whose result feeds reference resolution.
- `query_entity` validates against a **`SUPPORTED_ENTITIES` allowlist** — the allowlist is also what makes the `FROM`-clause interpolation safe. It covers all 29 entity types the server's own tool surface serves (queryability evidenced by upstream's `search_*` tools riding GET `/query` for the same 29, and node-quickbooks' `findX` wrappers; the `/batch` Query operation documents no entity restriction). An allowlist that lags the tool surface breaks bulk reads with `"Unsupported entity '<E>'"` even when the entity's create/get/update tools exist (bit the first AP deploy's leading pull when Bill/VendorCredit/BillPayment were missing) — so a new entity type added to the server must be added here in the same change.

**Rejected.** Filtering tombstones by `Active` (they read `true` — no field distinguishes them). Reactivating them (`2010` refuses it). Treating it as our pagination bug (proven endpoint-level, upstream-identical).

## Batch-surface inputs are validated at the tool boundary; out-of-range paging is rejected, never clamped

`batch_request` and `query_entity` reject malformed or out-of-range input with an actionable error before any API call — duplicate `bId`s, a mutate item missing its payload, a query/mutate hybrid, a `limit` outside 1..1000, an unknown `where` operator or malformed field. The alternative for `limit` — clamping to QBO's 1000-row MAXRESULTS cap — was rejected because QBO itself doesn't fault an oversized MAXRESULTS, it silently returns at most 1000: under a clamped or passed-through larger limit, `fetchAll`'s short-page termination reads a full page as final and **silently truncates the pull** — the same silent-under-fetch class as upstream's `search_*` `fetchAll` bug (`search-fetchall-fix`). Rejection surfaces the caller's wrong assumption; a clamp hides it. Passing malformed batch items through for QBO to fault was rejected for the same reason the 30-item cap is enforced locally: QBO's fault for a shape error is opaque, and a duplicate `bId` doesn't fault at all — it makes response matching ambiguous.

`optionsData` passes through to the batch item verbatim (Intuit's `BatchItemRequest` attribute, e.g. `void`; per the official .NET/PHP SDKs' Batch implementations). The handler does not interpret it — semantics stay QBO's.

## `query_entity` survives the access-token boundary: proactive refresh + reactive 003200 retry

A deploy cycle's pulls run longer than Intuit's ~60-minute access token. Two arms keep a long `fetchAll` alive: `QuickbooksClient.getInstance()` is re-fetched **per page** and refreshes proactively when expiry is within a 5-minute buffer; and the reactive arm catches a page that fails on token expiry anyway (QBO is the authority that just rejected the token — its server-side expiry can precede the client's own estimate), forces `refreshAccessToken()`, rebuilds the instance, and retries the page once. A request-level 401 rejects the whole `/batch` call *before* the API processes anything, so the single retry cannot double-apply.

**Scar (2026-06-11): the reactive arm shipped dead.** `isTokenExpiry` matched markers against `String(error)` — but a request-level 401 rejects with node-quickbooks' parsed body **object** (a within-response `BatchItemResponse[].Fault` is wrapped in an `Error` first, which is the only shape the tests covered), and `String({...})` is `"[object Object]"`, so the marker never matched and the error passed through as a plain page failure. Four ~60-minute deploy kills on `errorCode=003200` happened with the retry present in `dist/`. Fix: the predicate serializes through `formatError` (JSON for non-Error values); the regression test rejects with the raw body object verbatim. Lesson encoded in the test: cover the *transport-level* error shape, not only the in-response Fault shape.

The push-side `batch_request` handler carries the **same reactive arm**: on a token-expiry error it forces `refreshAccessToken()` (QBO is the authority that just rejected the token, so the client's own expiry estimate is not trusted), rebuilds the instance, and **re-sends once**. Safe for mutations by the same pre-execution argument as the 429 carve-out: a request-level 401 rejects the whole `/batch` call before the API processes any item, so the single re-send cannot double-apply. The shared predicate lives in `helpers/token-expiry.ts`.

Rejected — **heal-only, caller-side re-send** (the prior ratification): correct while the only consumer was `qbo_pipeline._batch._dispatch_batch` (whose bounded-backoff retry owns mutation retry policy), but a generic MCP client has no re-send contract, so on early server-side expiry the tool simply failed for it — unacceptable for an upstream-facing tool that must be correct standalone. The caller's outer retry is unchanged and still covers persistent rejections (failed heal, back-to-back 401s). Rejected — **more than one in-handler re-send**: retry *policy* beyond the single duplicate-safe re-send (backoff, attempt budgets, outage classification) stays caller-side, where the idempotency reasoning is ratified.
