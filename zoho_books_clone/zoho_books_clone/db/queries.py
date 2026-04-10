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


@frappe.whitelist()
def get_trial_balance(company: str, from_date: str, to_date: str) -> list[dict]:
    """Account-wise debit/credit totals for a period (trial balance)."""
    rows = frappe.db.sql("""
        SELECT
            g.account,
            COALESCE(SUM(g.debit),  0) AS debit,
            COALESCE(SUM(g.credit), 0) AS credit
        FROM `tabGeneral Ledger Entry` g
        WHERE g.company      = %(company)s
          AND g.docstatus     = 1
          AND g.posting_date BETWEEN %(from_date)s AND %(to_date)s
        GROUP BY g.account
        ORDER BY g.account
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)
    return [{"account": r.account, "debit": flt(r.debit), "credit": flt(r.credit)} for r in rows]


@frappe.whitelist()
def get_ar_aging(company: str, as_of_date: str) -> list[dict]:
    """AR Aging: buckets outstanding sales invoices by days past due date."""
    rows = frappe.db.sql("""
        SELECT name, customer, due_date, posting_date, outstanding_amount
        FROM `tabSales Invoice`
        WHERE company     = %(company)s
          AND docstatus    = 1
          AND outstanding_amount > 0
    """, {"company": company}, as_dict=True)

    as_of = getdate(as_of_date)
    buckets = {
        "0-30 days":  {"range": "0-30 days",  "count": 0, "total": 0.0},
        "31-60 days": {"range": "31-60 days", "count": 0, "total": 0.0},
        "61-90 days": {"range": "61-90 days", "count": 0, "total": 0.0},
        "91+ days":   {"range": "91+ days",   "count": 0, "total": 0.0},
    }
    grand_total = 0.0
    for r in rows:
        due = getdate(r.due_date or r.posting_date or as_of_date)
        days = max(0, (as_of - due).days)
        amt  = flt(r.outstanding_amount)
        grand_total += amt
        bk = "0-30 days" if days <= 30 else "31-60 days" if days <= 60 else "61-90 days" if days <= 90 else "91+ days"
        buckets[bk]["count"] += 1
        buckets[bk]["total"] += amt

    result = list(buckets.values())
    for b in result:
        b["pct"] = round(b["total"] / grand_total * 100) if grand_total > 0 else 0
    return result


@frappe.whitelist()
def get_pl_monthly_breakdown(company: str, from_date: str, to_date: str) -> list[dict]:
    """Monthly income / expense / net-profit breakdown within a date range."""
    rows = frappe.db.sql("""
        SELECT
            DATE_FORMAT(g.posting_date, '%%b %%y')  AS label,
            DATE_FORMAT(g.posting_date, '%%Y-%%m')  AS ym,
            a.account_type,
            COALESCE(SUM(g.credit) - SUM(g.debit), 0) AS amount
        FROM `tabGeneral Ledger Entry` g
        JOIN `tabAccount` a ON a.name = g.account
        WHERE g.company      = %(company)s
          AND g.docstatus     = 1
          AND g.posting_date BETWEEN %(from_date)s AND %(to_date)s
          AND a.account_type IN ('Income', 'Expense')
        GROUP BY ym, a.account_type
        ORDER BY ym
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)

    periods: dict = {}
    for r in rows:
        key = r.ym
        if key not in periods:
            periods[key] = {"label": r.label, "income": 0.0, "expense": 0.0}
        if r.account_type == "Income":
            periods[key]["income"] += flt(r.amount)
        else:
            # Expense amount is (credit - debit), so positive means more debit = actual expense
            periods[key]["expense"] += abs(flt(r.amount))

    result = []
    for key in sorted(periods.keys()):
        p = periods[key]
        result.append({
            "label":   p["label"],
            "income":  p["income"],
            "expense": p["expense"],
            "profit":  p["income"] - p["expense"],
        })
    return result


# ── Banking ───────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_bank_accounts(company: str | None = None) -> list[dict]:
    """Return Bank Account records from Frappe."""
    filters = {}
    if company:
        filters["company"] = company
    rows = frappe.get_list(
        "Bank Account",
        filters=filters,
        fields=["name", "bank", "bank_account_no", "branch_code", "account",
                "currency", "is_default", "disabled"],
        limit=200,
        order_by="is_default desc, name asc",
    )
    return rows


@frappe.whitelist()
def get_bank_transactions(
    bank_account: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> list[dict]:
    """Return Bank Transactions with optional filters."""
    filters = {"docstatus": ["!=", 2]}
    if bank_account:
        filters["bank_account"] = bank_account
    if from_date:
        filters["date"] = [">=", from_date]
    if to_date:
        if "date" in filters:
            filters["date"] = ["between", [from_date, to_date]]
        else:
            filters["date"] = ["<=", to_date]
    rows = frappe.get_list(
        "Bank Transaction",
        filters=filters,
        fields=["name", "date", "bank_account", "description", "deposit",
                "withdrawal", "currency", "reference_number", "party_type",
                "party", "docstatus", "unallocated_amount"],
        limit=500,
        order_by="date desc",
    )
    return rows


@frappe.whitelist()
def reconcile_bank_account(
    bank_account: str,
    statement_date: str,
    statement_closing_balance: float,
    matched_transaction_names: str = "[]",
) -> dict:
    """
    Mark a set of Bank Transactions as reconciled for a given statement date.
    `matched_transaction_names` — JSON array of Bank Transaction names.
    Returns summary dict with reconciled count and closing balance.
    """
    import json
    names = json.loads(matched_transaction_names)
    reconciled = 0
    for name in names:
        try:
            doc = frappe.get_doc("Bank Transaction", name)
            if doc.docstatus == 1 and not doc.get("clearance_date"):
                doc.clearance_date = statement_date
                doc.save(ignore_permissions=True)
                reconciled += 1
        except Exception:
            pass
    frappe.db.commit()
    return {
        "bank_account": bank_account,
        "statement_date": statement_date,
        "statement_closing_balance": flt(statement_closing_balance),
        "reconciled_count": reconciled,
    }
