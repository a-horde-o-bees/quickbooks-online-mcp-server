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

Caught up 2026-06-02: merged `upstream/main` again to `8328e89` (9 more commits — attachable upload, CRUD restriction mode, P&L Classes, per-call token refresh #41). Only `client.ts` overlapped; adopted upstream's `getInstance()` per-call-refresh client and re-applied `force-reauth` (still needed — #41 fixes empty-env-var OAuth loops, not server-side-invalidated-token recovery). Then collapsed `vendor-tools` to schema-relax only: upstream PR #22 now does the `args.params` unwrap, so `get-vendor` reverts fully to upstream and `create`/`update-vendor` keep only the `z.any()` relax. Fork is current with Intuit upstream; overlays minimal.

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
