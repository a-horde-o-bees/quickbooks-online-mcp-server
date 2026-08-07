"""Live TDD suite: prove the stock upstream server fails each overlay claim,
and the fork passes it, against the Integration Testing Sandbox. See README.md
for the claims matrix and safety rules.

Run from the project root: uv run python quickbooks-online-mcp-server/tests-live/run.py --server fork|stock
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REQUIRED_COMPANY = "Integration Testing Sandbox"
SEED_TARGET = 1100  # >1000 so a one-page cap is distinguishable from a full pull
SEED_CUSTOMER = "ITEST Volume Customer"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
FORK_DIR = PROJECT_ROOT / "quickbooks-online-mcp-server"


@dataclass
class Outcome:
    claim: str
    passed: bool
    detail: str


@dataclass
class Report:
    server: str
    outcomes: list[Outcome] = field(default_factory=list)

    def add(self, claim: str, passed: bool, detail: str) -> None:
        self.outcomes.append(Outcome(claim, passed, detail))
        print(f"  [{'PASS' if passed else 'FAIL'}] {claim}: {detail}")

    @property
    def failed(self) -> bool:
        return any(not o.passed for o in self.outcomes)


def _env_token(env_path: Path) -> str | None:
    m = re.search(r"^QUICKBOOKS_REFRESH_TOKEN=(.*)$", env_path.read_text(), re.M)
    return m.group(1).strip() if m else None


def _set_env_token(env_path: Path, token: str) -> None:
    text = env_path.read_text()
    text = re.sub(r"^QUICKBOOKS_REFRESH_TOKEN=.*$",
                  f"QUICKBOOKS_REFRESH_TOKEN={token}", text, flags=re.M)
    env_path.write_text(text)


def _prepare_stock(stock_dir: Path) -> None:
    """Bind the stock build to the same realm: copy the canonical .env in."""
    if not (stock_dir / "dist" / "index.js").exists():
        sys.exit(f"stock dist not built under {stock_dir}")
    shutil.copy2(FORK_DIR / ".env", stock_dir / ".env")


def _sync_token_back(stock_dir: Path) -> None:
    """A stock run may rotate the shared refresh token into its own .env;
    fold it back into the canonical env files so the next run isn't dead."""
    rotated = _env_token(stock_dir / ".env")
    canonical = _env_token(FORK_DIR / ".env")
    if rotated and rotated != canonical:
        _set_env_token(FORK_DIR / ".env", rotated)
        source = PROJECT_ROOT / ".env.integration-testing"
        if source.exists():
            _set_env_token(source, rotated)
        print("  (rotated refresh token synced back to canonical .env files)")


def _rows_from_query_entity(text: str) -> list[dict[str, Any]]:
    """query_entity emits 'Found N <E> record(s):' then one JSON object per
    content block; the client joins blocks with no separator — the concatenated
    shape extract_search_records exists for."""
    from qbo_pipeline._mcp_client import extract_search_records
    return extract_search_records(text)


async def _query_all(caller, entity: str, where: list | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 1
    while True:
        params: dict[str, Any] = {"entity": entity, "limit": 1000, "offset": offset}
        if where:
            params["where"] = where
        page = _rows_from_query_entity(await caller("query_entity", params))
        rows.extend(page)
        if len(page) < 1000:
            return rows
        offset += 1000


# --- claims ---------------------------------------------------------------


async def claim_guard(caller) -> None:
    from qbo_pipeline._mcp_client import extract_single_json
    company = extract_single_json(await caller("get_company_info", {}))
    name = company.get("CompanyName")
    if name != REQUIRED_COMPANY:
        sys.exit(f"ABORT: bound realm is {name!r}, not {REQUIRED_COMPANY!r} — refusing to run")
    print(f"  guard: bound to {name!r}")


async def claim_seed(caller, report: Report) -> None:
    """Top the corpus up to SEED_TARGET payments through batch_request itself."""
    from qbo_pipeline._batch import batch_create_all

    from qbo_pipeline._batch import _parse_batch_response

    customers = await _query_all(caller, "Customer",
                                 where=[{"field": "DisplayName", "value": SEED_CUSTOMER}])
    if customers:
        cust_id = customers[0]["Id"]
    else:
        text = await caller("batch_request", {"items": [{
            "bId": "seed-cust", "operation": "create", "entity_type": "Customer",
            "entity": {"DisplayName": SEED_CUSTOMER}}]})
        [created] = _parse_batch_response(text, "Customer", ["seed-cust"])
        if created.error or not created.qbo_record:
            sys.exit(f"seed customer create failed: {created.error}")
        cust_id = created.qbo_record["Id"]
    have = len(await _query_all(caller, "Payment"))
    deficit = max(0, SEED_TARGET - have)
    if deficit:
        items = [(f"seed-{i}", {"TotalAmt": 1.0, "CustomerRef": {"value": str(cust_id)}})
                 for i in range(deficit)]
        results = await batch_create_all(caller, "Payment", items)
        failed = [r for r in results if r.error]
        report.add("seed", not failed,
                   f"{deficit} payments created in 30-item batches, {len(failed)} faults "
                   f"(corpus was {have}, target {SEED_TARGET})")
    else:
        report.add("seed", True, f"corpus already at {have} >= {SEED_TARGET}")


async def claim_fetchall(caller, report: Report, server: str, total: int) -> None:
    text = await caller("search_payments", {"fetchAll": True})
    from qbo_pipeline._mcp_client import extract_search_records
    got = len(extract_search_records(text))
    if server == "stock":
        # TDD defect proof: the stock schema strips fetchAll, capping at one page
        report.add("fetchall-stock-defect", got < total,
                   f"stock returned {got} of {total} (defect {'reproduced' if got < total else 'NOT reproduced'})")
    else:
        report.add("fetchall-fork", got == total, f"fork returned {got} of {total}")


async def claim_absence(caller, report: Report) -> None:
    for tool in ("batch_request", "query_entity"):
        try:
            text = await caller(tool, {"items": []} if tool == "batch_request"
                                else {"entity": "Payment"})
            absent = text.startswith("Error") and ("not found" in text.lower() or "unknown" in text.lower())
            detail = text[:120]
        except Exception as e:  # MCP unknown-tool surfaces as an exception
            absent, detail = True, f"{type(e).__name__}: {e}"[:120]
        report.add(f"absence-{tool}", absent, detail)


async def claim_validation(caller, report: Report) -> None:
    async def expect_reject(name: str, tool: str, params: dict) -> None:
        try:
            text = await caller(tool, params)
            rejected = text.startswith("Error")
            detail = text[:110]
        except Exception as e:  # framework-level schema rejection
            rejected, detail = True, f"{type(e).__name__}: {e}"[:110]
        report.add(f"validation-{name}", rejected, detail)

    dup = [{"bId": "x", "operation": "create", "entity_type": "Customer",
            "entity": {"DisplayName": "d"}}] * 2
    await expect_reject("duplicate-bid", "batch_request", {"items": dup})
    over = [{"bId": f"b{i}", "query": "select * from Customer"} for i in range(31)]
    await expect_reject("over-30-items", "batch_request", {"items": over})
    await expect_reject("query-mutate-hybrid", "batch_request", {"items": [
        {"bId": "h", "operation": "create", "entity_type": "Customer",
         "entity": {"DisplayName": "d"}, "query": "select * from Customer"}]})
    await expect_reject("payload-less-mutate", "batch_request", {"items": [
        {"bId": "m", "operation": "create", "entity_type": "Customer"}]})
    await expect_reject("limit-zero", "query_entity", {"entity": "Payment", "limit": 0})
    await expect_reject("limit-1001", "query_entity", {"entity": "Payment", "limit": 1001})
    await expect_reject("unknown-entity", "query_entity", {"entity": "NotAnEntity"})


async def claim_faults(caller, report: Report) -> None:
    """One bad item in a full 30-item batch: 29 land, 1 faults; then clean up."""
    from qbo_pipeline._batch import _parse_batch_response

    customers = await _query_all(caller, "Customer",
                                 where=[{"field": "DisplayName", "value": SEED_CUSTOMER}])
    cust_id = customers[0]["Id"]
    items = []
    for i in range(30):
        ref = "99999999" if i == 13 else str(cust_id)  # one dangling CustomerRef
        items.append({"bId": f"f{i}", "operation": "create", "entity_type": "Payment",
                      "entity": {"TotalAmt": 2.0, "CustomerRef": {"value": ref}}})
    bids = [it["bId"] for it in items]
    results = _parse_batch_response(
        await caller("batch_request", {"items": items}), "Payment", bids)
    faults = [r for r in results if r.error]
    created = [r.qbo_record for r in results if r.qbo_record]
    ok = len(faults) == 1 and len(created) == 29
    report.add("faults-isolation", ok, f"{len(created)} created, {len(faults)} item fault(s)")

    if created:
        dels = [{"bId": f"d{i}", "operation": "delete", "entity_type": "Payment",
                 "entity": {"Id": p["Id"], "SyncToken": p["SyncToken"]}}
                for i, p in enumerate(created)]
        del_results = _parse_batch_response(
            await caller("batch_request", {"items": dels}), "Payment",
            [d["bId"] for d in dels], operation="delete")
        del_faults = [r for r in del_results if r.error]
        report.add("faults-cleanup-delete", not del_faults,
                   f"batch-deleted {len(del_results) - len(del_faults)}/{len(created)}")


async def claim_pagination(caller, report: Report, total: int) -> None:
    page1 = _rows_from_query_entity(
        await caller("query_entity", {"entity": "Payment", "limit": 1000, "offset": 1}))
    page2 = _rows_from_query_entity(
        await caller("query_entity", {"entity": "Payment", "limit": 1000, "offset": 1001}))
    ids = [int(r["Id"]) for r in page1 + page2]
    ordered = ids == sorted(ids)
    distinct = len(set(ids)) == len(ids)
    complete = len(ids) == total
    report.add("pagination-id-ordered", ordered and distinct and complete,
               f"pages {len(page1)}+{len(page2)}, ordered={ordered}, "
               f"distinct={distinct}, union=={total}: {complete}")


async def claim_vendor_passthrough(caller, report: Report, server: str) -> None:
    """Vendor schema strip: stock's strict 6-field schema silently drops valid
    QBO Vendor fields; the fork's typed+passthrough schema persists them.
    Probes are fields QBO verifiably STORES: AcctNum, BillAddr.Line2, and
    PrintOnCheckName with a value different from DisplayName (QBO auto-fills
    it from DisplayName, so only a custom value is probative). Vendor has no
    Notes field — QBO discards it regardless of schema (probe-verified
    2026-07-27; pipeline/_pull_spec.py) — so Notes is no probe here."""
    import time

    from qbo_pipeline._mcp_client import extract_single_json
    name = f"ITEST Vendor {server} {int(time.time())}"
    sent = {
        "DisplayName": name,
        "CompanyName": "ITEST Co",
        "PrintOnCheckName": "ITEST CUSTOM CHECK NAME",
        "AcctNum": "IT-001",
        "BillAddr": {"Line1": "1 Test Way", "Line2": "Suite 2", "Line3": "Dock 3",
                     "City": "Newark", "CountrySubDivisionCode": "NJ", "PostalCode": "07102"},
    }
    created = extract_single_json(await caller("create_vendor", {"vendor": sent}))
    got_acct = created.get("AcctNum")
    got_check = created.get("PrintOnCheckName")
    got_line2 = (created.get("BillAddr") or {}).get("Line2")
    detail = (f"AcctNum={got_acct!r} PrintOnCheckName={got_check!r} "
              f"BillAddr.Line2={got_line2!r}")
    if server == "stock":
        # QBO auto-fills PrintOnCheckName (from CompanyName when present, else
        # DisplayName): the strip shows as our custom value not surviving.
        stripped = not got_acct and got_check != sent["PrintOnCheckName"] and not got_line2
        report.add("vendor-strip-stock-defect", stripped,
                   f"{detail} (silent strip {'reproduced' if stripped else 'NOT reproduced'})")
    else:
        kept = (got_acct == sent["AcctNum"] and got_check == sent["PrintOnCheckName"]
                and got_line2 == "Suite 2")
        report.add("vendor-passthrough-fork", kept, detail)


async def claim_tombstone_probe(caller, report: Report) -> None:
    from qbo_pipeline._mcp_client import extract_search_records
    live = len(await _query_all(caller, "Account"))
    query_view = len(extract_search_records(
        await caller("search_accounts", {"criteria": [], "fetchAll": True})))
    report.add("tombstone-probe (informational)", True,
               f"/batch view {live} vs /query view {query_view} accounts "
               f"({'no tombstones yet — realm never reset' if live == query_view else 'DIVERGED — tombstones present'})")


# --- main -----------------------------------------------------------------


async def _run(server: str, report: Report) -> None:
    from qbo_pipeline._mcp_client import call_tool, qbo_session

    async with qbo_session() as session:
        async def caller(name: str, params: dict) -> str:
            return await call_tool(session, name, params)

        await claim_guard(caller)
        if server == "fork":
            await claim_seed(caller, report)
            total = len(await _query_all(caller, "Payment"))
            await claim_fetchall(caller, report, server, total)
            await claim_validation(caller, report)
            await claim_faults(caller, report)
            total = len(await _query_all(caller, "Payment"))
            await claim_pagination(caller, report, total)
            await claim_vendor_passthrough(caller, report, server)
            await claim_tombstone_probe(caller, report)
        else:
            # total from the realm itself is unavailable to stock (no query_entity);
            # the fork run's corpus target is the floor
            await claim_fetchall(caller, report, server, SEED_TARGET)
            await claim_absence(caller, report)
            await claim_vendor_passthrough(caller, report, server)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", choices=["fork", "stock"], required=True)
    ap.add_argument("--stock-dir", default=None, help="extracted+built stock upstream tree")
    a = ap.parse_args()

    if a.server == "stock":
        if not a.stock_dir:
            sys.exit("--stock-dir is required with --server stock")
        stock = Path(a.stock_dir).resolve()
        _prepare_stock(stock)
        os.environ["QBO_MCP_DIR"] = str(stock)
        os.environ["QBO_MCP_ENTRY"] = str(stock / "dist" / "index.js")
    # qbo_pipeline._mcp_client resolves paths at import — import only now
    sys.path.insert(0, str(PROJECT_ROOT / "pipeline"))

    report = Report(a.server)
    print(f"tests-live: server={a.server}")
    try:
        asyncio.run(_run(a.server, report))
    finally:
        if a.server == "stock":
            _sync_token_back(Path(a.stock_dir).resolve())

    out = Path(__file__).parent / f"results-{a.server}.json"
    out.write_text(json.dumps(
        [{"claim": o.claim, "passed": o.passed, "detail": o.detail} for o in report.outcomes],
        indent=1))
    print(f"{'FAILED' if report.failed else 'OK'} — results in {out}")
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
