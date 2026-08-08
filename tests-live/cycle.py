"""Full transaction-cycle claim: every transaction type the migration pushes,
created through batch_request on the merged server, read back via query_entity,
verified through QBO's five report tools as before/after deltas (immune to the
sample company's own data), then batch-deleted in link order.

Ledger math the deltas assert (all dated TXN_DATE):
  Invoice 123.45 (income, A/R) − CreditMemo 23.45 (contra income, A/R credit)
  Payment 123.45 applied to the invoice, deposited to bank
  JE Dr expense / Cr bank 55.55 · Bill expense 77.77 · BillPayment 77.77 (bank)
  VendorCredit −17.77 · Purchase (cash) 33.33 · PurchaseOrder 44.44 (non-posting)
  → income +100.00; expenses +148.88 (55.55+77.77−17.77+33.33)
  → bank −43.20 (−55.55−33.33−77.77+123.45); A/R −23.45; A/P −17.77
  → total assets −66.65 == liabilities+equity delta (BS identity preserved)
"""
from __future__ import annotations

from typing import Any

TXN_DATE = "2026-08-01"
WIDE = {"start_date": "2000-01-01", "end_date": "2030-12-31"}

AMT_INVOICE, AMT_CM, AMT_JE = 123.45, 23.45, 55.55
AMT_BILL, AMT_VC, AMT_PURCH, AMT_PO = 77.77, 17.77, 33.33, 44.44
EXP_INCOME = round(AMT_INVOICE - AMT_CM, 2)                       # 100.00
EXP_EXPENSE = round(AMT_JE + AMT_BILL - AMT_VC + AMT_PURCH, 2)    # 148.88
EXP_AR, EXP_AP = -AMT_CM, -AMT_VC
EXP_ASSETS = round(-AMT_JE - AMT_PURCH - AMT_BILL + AMT_INVOICE - AMT_CM, 2)  # -66.65


def _num(v: object) -> float:
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return 0.0


def _summaries(rep: dict, out: dict[str, list[str]] | None = None) -> dict[str, list[str]]:
    """label -> ColData values, from every Summary row at every depth."""
    out = {} if out is None else out
    rows = (rep.get("Rows") or {}).get("Row") or []
    for row in rows:
        summ = row.get("Summary")
        if summ:
            cold = summ.get("ColData") or []
            if cold:
                out[str(cold[0].get("value", ""))] = [str(c.get("value", "")) for c in cold]
        _summaries(row, out)
    return out


def _last_num(summaries: dict[str, list[str]], label: str) -> float:
    """Case-insensitive: QBO uppercases some summary labels (BS 'TOTAL ASSETS')
    while others are mixed case (P&L 'Total Income')."""
    want = label.casefold()
    vals = next((v for k, v in summaries.items() if k.casefold() == want), [""])
    return _num(vals[-1])


async def _report(caller, tool: str, params: dict) -> dict[str, list[str]]:
    from qbo_pipeline._mcp_client import extract_single_json
    return _summaries(extract_single_json(await caller(tool, params)))


async def _report_state(caller) -> dict[str, float]:
    pl = await _report(caller, "get_profit_and_loss", dict(WIDE))
    bs = await _report(caller, "get_balance_sheet", dict(WIDE))
    tb = await _report(caller, "get_trial_balance", dict(WIDE))
    ar = await _report(caller, "get_aged_receivables",
                       {"report_date": "2030-12-31", "aging_method": "Report_Date"})
    ap = await _report(caller, "get_aged_payables",
                       {"report_date": "2030-12-31", "aging_method": "Report_Date"})
    tb_total = tb.get("TOTAL") or ["", "", ""]
    return {
        "income": _last_num(pl, "Total Income"),
        "expense": _last_num(pl, "Total Expenses"),
        "assets": _last_num(bs, "Total Assets"),
        "liab_equity": _last_num(bs, "Total Liabilities and Equity"),
        "tb_debit": _num(tb_total[-2] if len(tb_total) >= 3 else ""),
        "tb_credit": _num(tb_total[-1]),
        "ar_total": _last_num(ar, "TOTAL"),
        "ap_total": _last_num(ap, "TOTAL"),
    }


async def _first_account(caller, query_all, acct_type: str) -> dict[str, Any]:
    rows = await query_all(caller, "Account", where=[{"field": "AccountType", "value": acct_type}])
    live = [r for r in rows if r.get("Active", True)]
    if not live:
        raise RuntimeError(f"no active {acct_type!r} account in the realm COA")
    return live[0]


def _acct_line(amount: float, account_id: str) -> dict[str, Any]:
    return {"Amount": amount, "DetailType": "AccountBasedExpenseLineDetail",
            "AccountBasedExpenseLineDetail": {"AccountRef": {"value": account_id}}}


def _parse_mixed(text: str, bid_types: dict[str, str]) -> dict[str, tuple[dict | None, str | None]]:
    """Per-item outcomes of a mixed-entity-type batch: bid -> (record, error)."""
    from qbo_pipeline._mcp_client import extract_single_json
    body = extract_single_json(text)
    by_bid = {str(r.get("bId", "")): r for r in body.get("BatchItemResponse") or []}
    out: dict[str, tuple[dict | None, str | None]] = {}
    for bid, etype in bid_types.items():
        item = by_bid.get(bid)
        if item is None:
            out[bid] = (None, "no batch response")
            continue
        fault = item.get("Fault")
        if fault:
            errors = fault.get("Error", [])
            out[bid] = (None, str(errors[0].get("Detail")) if errors else "unknown fault")
            continue
        rec = item.get(etype)
        out[bid] = (rec, None if rec else f"missing {etype!r} in response item")
    return out


async def run_cycle(caller, report, query_all) -> None:
    import time

    ts = int(time.time())

    # --- resolve COA + masters -------------------------------------------
    income = await _first_account(caller, query_all, "Income")
    expense = await _first_account(caller, query_all, "Expense")
    bank = await _first_account(caller, query_all, "Bank")
    customers = await query_all(caller, "Customer",
                                where=[{"field": "DisplayName", "value": "ITEST Volume Customer"}])
    cust = customers[0]["Id"]

    masters = [
        {"bId": "vend", "operation": "create", "entity_type": "Vendor",
         "entity": {"DisplayName": f"ITEST Cycle Vendor {ts}"}},
        {"bId": "item", "operation": "create", "entity_type": "Item",
         "entity": {"Name": f"ITEST Service {ts}", "Type": "Service",
                    "IncomeAccountRef": {"value": income["Id"]}}},
    ]
    m = _parse_mixed(await caller("batch_request", {"items": masters}),
                     {"vend": "Vendor", "item": "Item"})
    vend_rec, vend_err = m["vend"]
    item_rec, item_err = m["item"]
    if vend_err or item_err or not vend_rec or not item_rec:
        report.add("cycle-masters", False, f"vendor={vend_err} item={item_err}")
        return
    vend, item = vend_rec["Id"], item_rec["Id"]
    report.add("cycle-masters", True, f"Vendor {vend}, Item {item} created via batch")

    # --- baseline reports -------------------------------------------------
    before = await _report_state(caller)

    # --- transactions (batch 1: independent; batch 2: linked) ------------
    sales_line = lambda amt: [{"Amount": amt, "DetailType": "SalesItemLineDetail",
                               "SalesItemLineDetail": {"ItemRef": {"value": item},
                                                       "Qty": 1, "UnitPrice": amt}}]
    b1 = [
        {"bId": "inv", "operation": "create", "entity_type": "Invoice",
         "entity": {"CustomerRef": {"value": cust}, "TxnDate": TXN_DATE,
                    "Line": sales_line(AMT_INVOICE)}},
        {"bId": "cm", "operation": "create", "entity_type": "CreditMemo",
         "entity": {"CustomerRef": {"value": cust}, "TxnDate": TXN_DATE,
                    "Line": sales_line(AMT_CM)}},
        {"bId": "je", "operation": "create", "entity_type": "JournalEntry",
         "entity": {"TxnDate": TXN_DATE, "Line": [
             {"Amount": AMT_JE, "DetailType": "JournalEntryLineDetail",
              "JournalEntryLineDetail": {"PostingType": "Debit",
                                         "AccountRef": {"value": expense["Id"]}}},
             {"Amount": AMT_JE, "DetailType": "JournalEntryLineDetail",
              "JournalEntryLineDetail": {"PostingType": "Credit",
                                         "AccountRef": {"value": bank["Id"]}}}]}},
        {"bId": "bill", "operation": "create", "entity_type": "Bill",
         "entity": {"VendorRef": {"value": vend}, "TxnDate": TXN_DATE,
                    "Line": [_acct_line(AMT_BILL, expense["Id"])]}},
        {"bId": "vc", "operation": "create", "entity_type": "VendorCredit",
         "entity": {"VendorRef": {"value": vend}, "TxnDate": TXN_DATE,
                    "Line": [_acct_line(AMT_VC, expense["Id"])]}},
        {"bId": "purch", "operation": "create", "entity_type": "Purchase",
         "entity": {"PaymentType": "Cash", "AccountRef": {"value": bank["Id"]},
                    "TxnDate": TXN_DATE, "Line": [_acct_line(AMT_PURCH, expense["Id"])]}},
        {"bId": "po", "operation": "create", "entity_type": "PurchaseOrder",
         "entity": {"VendorRef": {"value": vend}, "TxnDate": TXN_DATE,
                    "Line": [_acct_line(AMT_PO, expense["Id"])]}},
    ]
    types = {"inv": "Invoice", "cm": "CreditMemo", "je": "JournalEntry",
             "bill": "Bill", "vc": "VendorCredit", "purch": "Purchase",
             "po": "PurchaseOrder", "pay": "Payment", "bp": "BillPayment"}
    created: dict[str, dict] = {}
    fails: list[str] = []
    b1_types = {i["bId"]: types[i["bId"]] for i in b1}
    for bid, (rec, err) in _parse_mixed(
            await caller("batch_request", {"items": b1}), b1_types).items():
        if rec:
            created[bid] = rec
        else:
            fails.append(f"{bid}: {err}")
    if fails:
        report.add("cycle-create", False, "; ".join(fails)[:200])
        return

    b2 = [
        {"bId": "pay", "operation": "create", "entity_type": "Payment",
         "entity": {"CustomerRef": {"value": cust}, "TotalAmt": AMT_INVOICE,
                    "TxnDate": TXN_DATE, "DepositToAccountRef": {"value": bank["Id"]},
                    "Line": [{"Amount": AMT_INVOICE,
                              "LinkedTxn": [{"TxnId": created["inv"]["Id"],
                                             "TxnType": "Invoice"}]}]}},
        {"bId": "bp", "operation": "create", "entity_type": "BillPayment",
         "entity": {"VendorRef": {"value": vend}, "TotalAmt": AMT_BILL,
                    "TxnDate": TXN_DATE, "PayType": "Check",
                    "CheckPayment": {"BankAccountRef": {"value": bank["Id"]}},
                    "Line": [{"Amount": AMT_BILL,
                              "LinkedTxn": [{"TxnId": created["bill"]["Id"],
                                             "TxnType": "Bill"}]}]}},
    ]
    for bid, (rec, err) in _parse_mixed(
            await caller("batch_request", {"items": b2}),
            {"pay": "Payment", "bp": "BillPayment"}).items():
        if rec:
            created[bid] = rec
        else:
            fails.append(f"{bid}: {err}")
    if fails:
        report.add("cycle-create", False, "; ".join(fails)[:200])
        return
    report.add("cycle-create", True,
               "9 transaction types created via batch_request (incl. linked Payment/BillPayment)")

    # --- read-back per type via query_entity ------------------------------
    missing = []
    for bid, etype in types.items():
        rows = await query_all(caller, etype,
                               where=[{"field": "Id", "value": created[bid]["Id"]}])
        if not rows:
            missing.append(etype)
    report.add("cycle-readback", not missing,
               "all 9 types readable via query_entity" if not missing
               else f"missing from /batch view: {missing}")

    # --- report deltas ----------------------------------------------------
    after = await _report_state(caller)
    d = {k: round(after[k] - before[k], 2) for k in before}
    checks = {
        "P&L income": (d["income"], EXP_INCOME),
        "P&L expense": (d["expense"], EXP_EXPENSE),
        "BS assets": (d["assets"], EXP_ASSETS),
        "BS liab+equity": (d["liab_equity"], EXP_ASSETS),
        "AR aging": (d["ar_total"], EXP_AR),
        "AP aging": (d["ap_total"], EXP_AP),
    }
    bad = [f"{k}: got {g} want {w}" for k, (g, w) in checks.items() if g != w]
    tb_ok = round(after["tb_debit"], 2) == round(after["tb_credit"], 2) and after["tb_debit"] > 0
    if not tb_ok:
        bad.append(f"TB imbalance: Dr {after['tb_debit']} vs Cr {after['tb_credit']}")
    report.add("cycle-reports", not bad,
               "P&L / BS / TB / AR / AP deltas all exact" if not bad else "; ".join(bad)[:250])

    # --- cleanup: delete in link order, exercising delete per type --------
    def _del(bid: str) -> dict:
        rec = created[bid]
        return {"bId": f"d-{bid}", "operation": "delete", "entity_type": types[bid],
                "entity": {"Id": rec["Id"], "SyncToken": rec["SyncToken"]}}

    del1 = [_del(b) for b in ("pay", "bp")]
    del2 = [_del(b) for b in ("inv", "cm", "je", "bill", "vc", "purch", "po")]
    errs = []
    for batch in (del1, del2):
        bid_types = {i["bId"]: i["entity_type"] for i in batch}
        for bid, (rec, err) in _parse_mixed(
                await caller("batch_request", {"items": batch}), bid_types).items():
            if err:
                errs.append(f"{bid}: {err}")
    report.add("cycle-cleanup", not errs,
               "all 9 batch-deleted in link order" if not errs else "; ".join(errs)[:200])
