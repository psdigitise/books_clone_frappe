"""
Central query library for Zoho Books Clone.
All raw SQL lives here — controllers import from this module
instead of writing inline SQL.
"""
import frappe
from frappe.utils import flt, getdate, today


# ── General Ledger ────────────────────────────────────────────────────────────

def get_gl_entries(
    from_date: str,
    to_date: str,
    company: str,
    account: str | None = None,
    party_type: str | None = None,
    party: str | None = None,
    voucher_no: str | None = None,
) -> list[dict]:
    """Return GL entries for a date range with optional filters."""
    conditions = [
        "docstatus = 1",
        "posting_date BETWEEN %(from_date)s AND %(to_date)s",
        "company = %(company)s",
    ]
    params: dict = {"from_date": from_date, "to_date": to_date, "company": company}

    if account:
        conditions.append("account = %(account)s")
        params["account"] = account
    if party_type:
        conditions.append("party_type = %(party_type)s")
        params["party_type"] = party_type
    if party:
        conditions.append("party = %(party)s")
        params["party"] = party
    if voucher_no:
        conditions.append("voucher_no = %(voucher_no)s")
        params["voucher_no"] = voucher_no

    where = " AND ".join(conditions)
    return frappe.db.sql(f"""
        SELECT
            posting_date, account, voucher_type, voucher_no,
            party_type, party, debit, credit, remarks
        FROM `tabGeneral Ledger Entry`
        WHERE {where}
        ORDER BY posting_date, creation
    """, params, as_dict=True)


def get_account_balance(account: str, as_of_date: str | None = None) -> float:
    """Net balance (debit - credit) for an account, optionally up to a date."""
    params: dict = {"account": account}
    date_cond = ""
    if as_of_date:
        date_cond = "AND posting_date <= %(as_of_date)s"
        params["as_of_date"] = as_of_date

    result = frappe.db.sql(f"""
        SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance
        FROM `tabGeneral Ledger Entry`
        WHERE account = %(account)s AND docstatus = 1 {date_cond}
    """, params, as_dict=True)
    return flt(result[0].balance) if result else 0.0


def get_account_balances_bulk(
    accounts: list[str], as_of_date: str | None = None
) -> dict[str, float]:
    """Return {account_name: balance} for a list of accounts (single query)."""
    if not accounts:
        return {}
    placeholders = ", ".join(["%s"] * len(accounts))
    date_cond = f"AND posting_date <= '{as_of_date}'" if as_of_date else ""
    rows = frappe.db.sql(f"""
        SELECT account, COALESCE(SUM(debit) - SUM(credit), 0) AS balance
        FROM `tabGeneral Ledger Entry`
        WHERE account IN ({placeholders}) AND docstatus = 1 {date_cond}
        GROUP BY account
    """, accounts, as_dict=True)
    return {r.account: flt(r.balance) for r in rows}


# ── Invoices ──────────────────────────────────────────────────────────────────

def get_outstanding_invoices(
    party_type: str,
    party: str,
    company: str | None = None,
) -> list[dict]:
    """Unpaid invoices for a customer or supplier."""
    dt = "Sales Invoice" if party_type == "Customer" else "Purchase Invoice"
    party_field = "customer" if dt == "Sales Invoice" else "supplier"
    filters: dict = {party_field: party, "docstatus": 1, "outstanding_amount": [">", 0]}
    if company:
        filters["company"] = company
    return frappe.get_all(
        dt,
        filters=filters,
        fields=["name", "posting_date", "due_date", "grand_total", "outstanding_amount", "currency"],
        order_by="due_date asc",
    )


def get_invoice_summary(company: str, from_date: str, to_date: str) -> dict:
    """Dashboard KPIs: total invoiced, total collected, outstanding."""
    row = frappe.db.sql("""
        SELECT
            COALESCE(SUM(grand_total),       0) AS total_invoiced,
            COALESCE(SUM(grand_total - outstanding_amount), 0) AS total_collected,
            COALESCE(SUM(outstanding_amount),0) AS total_outstanding
        FROM `tabSales Invoice`
        WHERE company = %(company)s
          AND docstatus = 1
          AND posting_date BETWEEN %(from_date)s AND %(to_date)s
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)
    return row[0] if row else {}


def get_overdue_invoices(company: str) -> list[dict]:
    """All sales invoices past their due date with a balance."""
    return frappe.db.sql("""
        SELECT name, customer, customer_name, due_date,
               outstanding_amount, grand_total, currency
        FROM `tabSales Invoice`
        WHERE company = %(company)s
          AND docstatus = 1
          AND outstanding_amount > 0
          AND due_date < %(today)s
        ORDER BY due_date ASC
    """, {"company": company, "today": today()}, as_dict=True)


def get_top_customers(company: str, from_date: str, to_date: str, limit: int = 10) -> list[dict]:
    """Top customers by revenue in a period."""
    return frappe.db.sql("""
        SELECT customer, customer_name,
               COUNT(*) AS invoice_count,
               SUM(grand_total) AS total_revenue
        FROM `tabSales Invoice`
        WHERE company = %(company)s
          AND docstatus = 1
          AND posting_date BETWEEN %(from_date)s AND %(to_date)s
        GROUP BY customer
        ORDER BY total_revenue DESC
        LIMIT %(limit)s
    """, {"company": company, "from_date": from_date, "to_date": to_date, "limit": limit}, as_dict=True)


# ── Payments ──────────────────────────────────────────────────────────────────

def get_payments_for_party(party_type: str, party: str, company: str) -> list[dict]:
    """All submitted payments for a party."""
    return frappe.get_all(
        "Payment Entry",
        filters={"party_type": party_type, "party": party, "company": company, "docstatus": 1},
        fields=["name", "payment_date", "payment_type", "paid_amount", "mode_of_payment"],
        order_by="payment_date desc",
    )


def get_payment_summary(company: str, from_date: str, to_date: str) -> dict:
    """Total received vs paid in a period."""
    row = frappe.db.sql("""
        SELECT
            COALESCE(SUM(CASE WHEN payment_type='Receive' THEN paid_amount ELSE 0 END),0) AS total_received,
            COALESCE(SUM(CASE WHEN payment_type='Pay'     THEN paid_amount ELSE 0 END),0) AS total_paid
        FROM `tabPayment Entry`
        WHERE company = %(company)s
          AND docstatus = 1
          AND payment_date BETWEEN %(from_date)s AND %(to_date)s
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)
    return row[0] if row else {}


# ── Banking ───────────────────────────────────────────────────────────────────

def get_unreconciled_transactions(bank_account: str) -> list[dict]:
    """Bank transactions not yet matched to a payment entry."""
    return frappe.get_all(
        "Bank Transaction",
        filters={"bank_account": bank_account, "status": "Unreconciled", "docstatus": 1},
        fields=["name", "date", "description", "debit", "credit", "balance", "reference_number"],
        order_by="date asc",
    )


def get_bank_balance(bank_account: str) -> float:
    """Latest running balance from bank transactions."""
    result = frappe.db.sql("""
        SELECT balance FROM `tabBank Transaction`
        WHERE bank_account = %s AND docstatus = 1
        ORDER BY date DESC, creation DESC
        LIMIT 1
    """, bank_account, as_dict=True)
    return flt(result[0].balance) if result else 0.0


# ── Reports ───────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_profit_and_loss(company: str, from_date: str, to_date: str) -> dict:
    """Return income, expense, and net profit totals."""
    rows = frappe.db.sql("""
        SELECT a.account_type,
               COALESCE(SUM(g.credit) - SUM(g.debit), 0) AS amount
        FROM `tabGeneral Ledger Entry` g
        JOIN `tabAccount` a ON a.name = g.account
        WHERE g.company      = %(company)s
          AND g.docstatus     = 1
          AND g.posting_date BETWEEN %(from_date)s AND %(to_date)s
          AND a.account_type IN ("Income", "Expense")
        GROUP BY a.account_type
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)

    totals = {r.account_type: flt(r.amount) for r in rows}
    income  = totals.get("Income",  0.0)
    expense = totals.get("Expense", 0.0)
    return {
        "total_income":  income,
        "total_expense": expense,
        "net_profit":    income - expense,
    }


@frappe.whitelist()
def get_balance_sheet_totals(company: str, as_of_date: str) -> dict:
    """Asset, liability, equity totals as of a date."""
    rows = frappe.db.sql("""
        SELECT a.account_type,
               COALESCE(SUM(g.debit) - SUM(g.credit), 0) AS balance
        FROM `tabGeneral Ledger Entry` g
        JOIN `tabAccount` a ON a.name = g.account
        WHERE g.company     = %(company)s
          AND g.docstatus    = 1
          AND g.posting_date <= %(as_of_date)s
          AND a.account_type IN ("Asset", "Liability", "Equity")
        GROUP BY a.account_type
    """, {"company": company, "as_of_date": as_of_date}, as_dict=True)

    totals = {r.account_type: flt(r.balance) for r in rows}
    return {
        "total_assets":      totals.get("Asset",     0.0),
        "total_liabilities": totals.get("Liability", 0.0),
        "total_equity":      totals.get("Equity",    0.0),
    }


@frappe.whitelist()
def get_cash_flow(company: str, from_date: str, to_date: str) -> dict:
    """Simplified cash-flow: operating (P&L accounts) + financing (equity) + investing (assets)."""
    rows = frappe.db.sql("""
        SELECT a.account_type,
               COALESCE(SUM(g.debit) - SUM(g.credit), 0) AS net
        FROM `tabGeneral Ledger Entry` g
        JOIN `tabAccount` a ON a.name = g.account
        WHERE g.company     = %(company)s
          AND g.docstatus    = 1
          AND g.posting_date BETWEEN %(from_date)s AND %(to_date)s
        GROUP BY a.account_type
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)

    by_type = {r.account_type: flt(r.net) for r in rows}
    operating  = by_type.get("Income", 0) - by_type.get("Expense", 0)
    investing  = by_type.get("Asset", 0)
    financing  = by_type.get("Equity", 0) - by_type.get("Liability", 0)
    return {
        "operating":  operating,
        "investing":  investing,
        "financing":  financing,
        "net_change": operating + investing + financing,
    }


# ── Tax ───────────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_gst_summary(company: str, from_date: str, to_date: str) -> list[dict]:
    """GST collected by tax type (CGST, SGST, IGST) for a period."""
    return frappe.db.sql("""
        SELECT t.tax_type,
               COUNT(DISTINCT t.parent) AS invoice_count,
               SUM(t.tax_amount)        AS total_tax
        FROM `tabTax Line` t
        JOIN `tabSales Invoice` si ON si.name = t.parent
        WHERE si.company    = %(company)s
          AND si.docstatus   = 1
          AND si.posting_date BETWEEN %(from_date)s AND %(to_date)s
          AND t.tax_type IN ("CGST", "SGST", "IGST")
        GROUP BY t.tax_type
        ORDER BY t.tax_type
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)


# ── Inventory ─────────────────────────────────────────────────────────────────

def get_stock_movement_summary(
    company: str,
    from_date: str,
    to_date: str,
    warehouse: str | None = None,
) -> list[dict]:
    """Total receipts and issues per item in a period."""
    wh_cond = "AND sle.warehouse = %(warehouse)s" if warehouse else ""
    params = {"company": company, "from_date": from_date, "to_date": to_date}
    if warehouse:
        params["warehouse"] = warehouse

    return frappe.db.sql(f"""
        SELECT
            sle.item_code,
            i.item_name,
            sle.warehouse,
            COALESCE(SUM(CASE WHEN sle.actual_qty > 0 THEN sle.actual_qty  ELSE 0 END), 0) AS total_in,
            COALESCE(SUM(CASE WHEN sle.actual_qty < 0 THEN -sle.actual_qty ELSE 0 END), 0) AS total_out,
            COALESCE(SUM(sle.actual_qty), 0) AS net_qty,
            COALESCE(SUM(sle.stock_value_difference), 0) AS net_value
        FROM `tabStock Ledger Entry` sle
        JOIN `tabItem` i ON i.name = sle.item_code
        WHERE sle.is_cancelled = 0
          AND sle.posting_date BETWEEN %(from_date)s AND %(to_date)s
          {wh_cond}
        GROUP BY sle.item_code, sle.warehouse
        ORDER BY ABS(SUM(sle.stock_value_difference)) DESC
    """, params, as_dict=True)


def get_slow_moving_items(
    company: str,
    days: int = 90,
    warehouse: str | None = None,
) -> list[dict]:
    """Items with no stock movement in the last N days that still have stock."""
    wh_cond = "AND b.warehouse = %(warehouse)s" if warehouse else ""
    params = {"days": days}
    if warehouse:
        params["warehouse"] = warehouse

    return frappe.db.sql(f"""
        SELECT
            b.item_code,
            i.item_name,
            b.warehouse,
            b.actual_qty,
            b.stock_value,
            b.valuation_rate,
            MAX(sle.posting_date) AS last_movement_date,
            DATEDIFF(CURDATE(), MAX(sle.posting_date)) AS days_since_movement
        FROM `tabBin` b
        JOIN `tabItem` i ON i.name = b.item_code
        LEFT JOIN `tabStock Ledger Entry` sle
            ON sle.item_code = b.item_code
            AND sle.warehouse = b.warehouse
            AND sle.is_cancelled = 0
        WHERE b.actual_qty > 0
          {wh_cond}
        GROUP BY b.item_code, b.warehouse
        HAVING last_movement_date IS NULL
            OR DATEDIFF(CURDATE(), last_movement_date) > %(days)s
        ORDER BY days_since_movement DESC
    """, params, as_dict=True)


def get_stock_ageing(
    warehouse: str | None = None,
    as_of_date: str | None = None,
) -> list[dict]:
    """FIFO-based stock ageing — how old is the stock on hand."""
    from frappe.utils import today as frappe_today
    date = as_of_date or frappe_today()
    wh_cond = "AND sle.warehouse = %(warehouse)s" if warehouse else ""
    params = {"date": date}
    if warehouse:
        params["warehouse"] = warehouse

    return frappe.db.sql(f"""
        SELECT
            sle.item_code,
            i.item_name,
            sle.warehouse,
            sle.posting_date AS receipt_date,
            sle.actual_qty   AS receipt_qty,
            sle.incoming_rate AS rate,
            DATEDIFF(%(date)s, sle.posting_date) AS age_days,
            sle.actual_qty * sle.incoming_rate    AS receipt_value
        FROM `tabStock Ledger Entry` sle
        JOIN `tabItem` i ON i.name = sle.item_code
        WHERE sle.actual_qty > 0
          AND sle.posting_date <= %(date)s
          AND sle.is_cancelled = 0
          {wh_cond}
        ORDER BY sle.item_code, sle.posting_date ASC
    """, params, as_dict=True)


def get_item_valuation_history(
    item_code: str,
    warehouse: str,
    from_date: str,
    to_date: str,
) -> list[dict]:
    """Valuation rate history for an item+warehouse over a period."""
    return frappe.db.sql("""
        SELECT
            posting_date,
            voucher_type,
            voucher_no,
            actual_qty,
            qty_after_transaction,
            valuation_rate,
            stock_value
        FROM `tabStock Ledger Entry`
        WHERE item_code  = %(item_code)s
          AND warehouse  = %(warehouse)s
          AND is_cancelled = 0
          AND posting_date BETWEEN %(from_date)s AND %(to_date)s
        ORDER BY posting_date, creation
    """, {"item_code": item_code, "warehouse": warehouse,
          "from_date": from_date, "to_date": to_date}, as_dict=True)


# ── Trial Balance ─────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_trial_balance(company: str, from_date: str, to_date: str) -> list[dict]:
    """Account-level trial balance: opening + period debits/credits + closing."""
    rows = frappe.db.sql("""
        SELECT
            gle.account,
            a.account_type,
            SUM(CASE WHEN gle.posting_date < %(from_date)s THEN gle.debit - gle.credit ELSE 0 END) AS opening,
            SUM(CASE WHEN gle.posting_date BETWEEN %(from_date)s AND %(to_date)s THEN gle.debit ELSE 0 END) AS debit,
            SUM(CASE WHEN gle.posting_date BETWEEN %(from_date)s AND %(to_date)s THEN gle.credit ELSE 0 END) AS credit
        FROM `tabGeneral Ledger Entry` gle
        JOIN `tabAccount` a ON a.name = gle.account
        WHERE gle.company = %(company)s
          AND gle.docstatus = 1
          AND gle.posting_date <= %(to_date)s
        GROUP BY gle.account, a.account_type
        ORDER BY gle.account
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)

    for r in rows:
        r["closing"] = flt(r.get("opening")) + flt(r.get("debit")) - flt(r.get("credit"))

    return rows


# ── AR Aging ──────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_ar_aging(company: str, as_of_date: str) -> list[dict]:
    """Accounts Receivable aging by customer with standard buckets."""
    rows = frappe.db.sql("""
        SELECT
            si.customer,
            si.customer_name,
            si.name             AS invoice,
            si.posting_date,
            si.due_date,
            si.outstanding_amount,
            DATEDIFF(%(as_of_date)s, si.due_date) AS overdue_days
        FROM `tabSales Invoice` si
        WHERE si.company      = %(company)s
          AND si.docstatus    = 1
          AND si.outstanding_amount > 0
        ORDER BY si.customer, si.posting_date
    """, {"company": company, "as_of_date": as_of_date}, as_dict=True)

    # Bucket into aging groups per customer
    buckets = {}
    for r in rows:
        cust = r["customer"]
        if cust not in buckets:
            buckets[cust] = {"customer": cust, "customer_name": r.get("customer_name", cust),
                             "current": 0, "days_1_30": 0, "days_31_60": 0,
                             "days_61_90": 0, "days_90_plus": 0, "total": 0}
        b = buckets[cust]
        amt = flt(r["outstanding_amount"])
        days = r["overdue_days"] or 0
        if days <= 0:
            b["current"] += amt
        elif days <= 30:
            b["days_1_30"] += amt
        elif days <= 60:
            b["days_31_60"] += amt
        elif days <= 90:
            b["days_61_90"] += amt
        else:
            b["days_90_plus"] += amt
        b["total"] += amt

    return list(buckets.values())


# ── P&L Monthly Breakdown ────────────────────────────────────────────────────

@frappe.whitelist()
def get_pl_monthly_breakdown(company: str, from_date: str, to_date: str) -> list[dict]:
    """Monthly income vs expense for sparkline / bar charts."""
    rows = frappe.db.sql("""
        SELECT
            DATE_FORMAT(gle.posting_date, '%%Y-%%m') AS month,
            SUM(CASE WHEN a.account_type = 'Income' THEN gle.credit - gle.debit ELSE 0 END) AS income,
            SUM(CASE WHEN a.account_type = 'Expense' THEN gle.debit - gle.credit ELSE 0 END) AS expense
        FROM `tabGeneral Ledger Entry` gle
        JOIN `tabAccount` a ON a.name = gle.account
        WHERE gle.company    = %(company)s
          AND gle.docstatus  = 1
          AND gle.posting_date BETWEEN %(from_date)s AND %(to_date)s
          AND a.account_type IN ('Income', 'Expense')
        GROUP BY DATE_FORMAT(gle.posting_date, '%%Y-%%m')
        ORDER BY month
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)

    for r in rows:
        r["profit"] = flt(r.get("income")) - flt(r.get("expense"))


# ── GST / ITC Report (P3/Issue 9) ─────────────────────────────────────────────

def get_gstr_summary(company: str, from_date: str, to_date: str) -> dict:
    """
    Build a GSTR-3B style summary:
      - Output tax  : taxes collected on submitted Sales Invoices
      - Input tax (ITC): taxes paid on submitted Purchase Invoices
      - Net liability : output - ITC
    Returns a dict with 'output', 'itc', and 'net' sections, each a list of
    {"tax_type": str, "amount": float} rows plus a totals dict.
    """
    # ── Output tax (from Sales Invoices) ──────────────────────────────────────
    output_rows = frappe.db.sql("""
        SELECT
            tl.tax_type,
            tl.description,
            SUM(tl.tax_amount)  AS amount,
            COUNT(DISTINCT si.name) AS invoice_count
        FROM `tabTax Line` tl
        JOIN `tabSales Invoice` si
          ON si.name = tl.parent
        WHERE si.company    = %(company)s
          AND si.docstatus  = 1
          AND si.posting_date BETWEEN %(from_date)s AND %(to_date)s
        GROUP BY tl.tax_type, tl.description
        ORDER BY tl.tax_type
    """, {"company": company, "from_date": from_date, "to_date": to_date},
    as_dict=True)

    # ── Input Tax Credit (from Purchase Invoices) ─────────────────────────────
    itc_rows = frappe.db.sql("""
        SELECT
            tl.tax_type,
            tl.description,
            SUM(tl.tax_amount)  AS amount,
            COUNT(DISTINCT pi.name) AS invoice_count
        FROM `tabTax Line` tl
        JOIN `tabPurchase Invoice` pi
          ON pi.name = tl.parent
        WHERE pi.company    = %(company)s
          AND pi.docstatus  = 1
          AND pi.posting_date BETWEEN %(from_date)s AND %(to_date)s
        GROUP BY tl.tax_type, tl.description
        ORDER BY tl.tax_type
    """, {"company": company, "from_date": from_date, "to_date": to_date},
    as_dict=True)

    total_output = sum(flt(r.amount) for r in output_rows)
    total_itc    = sum(flt(r.amount) for r in itc_rows)

    # ── Net payable by tax type ────────────────────────────────────────────────
    output_by_type = {r.tax_type: flt(r.amount) for r in output_rows}
    itc_by_type    = {r.tax_type: flt(r.amount) for r in itc_rows}
    all_types      = sorted(set(list(output_by_type) + list(itc_by_type)))

    net_rows = [
        {
            "tax_type":  t,
            "output":    output_by_type.get(t, 0.0),
            "itc":       itc_by_type.get(t, 0.0),
            "net":       output_by_type.get(t, 0.0) - itc_by_type.get(t, 0.0),
        }
        for t in all_types
    ]

    return {
        "output":       [dict(r) for r in output_rows],
        "itc":          [dict(r) for r in itc_rows],
        "net_by_type":  net_rows,
        "totals": {
            "total_output":     total_output,
            "total_itc":        total_itc,
            "net_tax_liability": total_output - total_itc,
        },
    }


def get_itc_ledger(company: str, from_date: str, to_date: str) -> list[dict]:
    """
    Line-by-line ITC ledger — every tax line on every submitted Purchase Invoice.
    Useful for GSTR-2A reconciliation.
    """
    return frappe.db.sql("""
        SELECT
            pi.name            AS voucher_no,
            pi.posting_date,
            pi.supplier,
            pi.bill_no,
            pi.bill_date,
            tl.tax_type,
            tl.description,
            tl.rate            AS tax_rate,
            tl.tax_amount,
            tl.account_head
        FROM `tabTax Line` tl
        JOIN `tabPurchase Invoice` pi
          ON pi.name = tl.parent
        WHERE pi.company    = %(company)s
          AND pi.docstatus  = 1
          AND pi.posting_date BETWEEN %(from_date)s AND %(to_date)s
        ORDER BY pi.posting_date, pi.name, tl.idx
    """, {"company": company, "from_date": from_date, "to_date": to_date},
    as_dict=True)
