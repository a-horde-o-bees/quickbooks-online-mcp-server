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

Executed 2026-06-02: overlays replayed as native commits on `26c80d4`, merged `upstream/main` (`3794133`, 27 commits) with the overlap verdicts applied as conflict resolution — `refresh-writeback` dropped (superseded by `19c90be`), `force-reauth` re-applied atop the refactored client. `apply.sh` / `--extensions` removed. **Follow-up:** collapse `vendor-tools` to schema-relax only — upstream PR #22's `args.params` unwrap now overlaps our handler; the merge kept our full overlay pending the trim.
