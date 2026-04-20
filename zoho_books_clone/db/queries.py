"""
Central query library for Zoho Books Clone.
All raw SQL lives here — controllers import from this module
instead of writing inline SQL.
"""
import frappe
from frappe.utils import flt, today


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
    """
    Return income, expense (including COGS), and net profit totals.

    Account types included:
      Income          → revenue
      Expense         → operating expenses
      Cost of Goods Sold → COGS posted by Stock Entry on Material Issue
    """
    rows = frappe.db.sql("""
        SELECT a.account_type,
               COALESCE(SUM(g.credit) - SUM(g.debit), 0) AS amount
        FROM `tabGeneral Ledger Entry` g
        JOIN `tabAccount` a ON a.name = g.account
        WHERE g.company      = %(company)s
          AND g.is_cancelled  = 0
          AND g.posting_date BETWEEN %(from_date)s AND %(to_date)s
          AND a.account_type IN (
                "Income",
                "Expense",
                "Cost of Goods Sold"   -- COGS from inventory GL posting
              )
        GROUP BY a.account_type
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)

    totals = {r.account_type: flt(r.amount) for r in rows}
    income  = totals.get("Income", 0.0)
    # COGS is a debit-normal account; credit-debit gives a negative number → negate it
    cogs    = -totals.get("Cost of Goods Sold", 0.0)
    expense = -totals.get("Expense", 0.0)   # expenses are also debit-normal

    gross_profit = income - cogs
    net_profit   = gross_profit - expense

    return {
        "total_income":   income,
        "cogs":           cogs,
        "gross_profit":   gross_profit,
        "total_expense":  expense,
        "net_profit":     net_profit,
    }


@frappe.whitelist()
def get_balance_sheet_totals(company: str, as_of_date: str) -> dict:
    """
    Asset, liability, equity totals as of a date.

    All account types are fetched; classification:
      Debit-normal assets  → Asset, Cash, Bank, Receivable, Stock
      Credit-normal liab.  → Liability, Payable
      Tax                  → net positive = ITC asset; net negative = GST liability
      Equity               → Equity (credit-normal)
    """
    rows = frappe.db.sql("""
        SELECT a.account_type,
               COALESCE(SUM(g.debit) - SUM(g.credit), 0) AS balance
        FROM `tabGeneral Ledger Entry` g
        JOIN `tabAccount` a ON a.name = g.account
        WHERE g.company     = %(company)s
          AND g.is_cancelled = 0
          AND g.posting_date <= %(as_of_date)s
        GROUP BY a.account_type
    """, {"company": company, "as_of_date": as_of_date}, as_dict=True)

    t = {r.account_type: flt(r.balance) for r in rows}

    # Debit-normal: positive balance = asset
    ASSET_TYPES = ("Asset", "Cash", "Bank", "Receivable", "Stock")
    raw_assets = sum(t.get(tp, 0.0) for tp in ASSET_TYPES)

    # Tax accounts: ITC accounts carry debit balance (asset);
    # GST Payable accounts carry credit balance (liability).
    # The net (debit-credit) tells us which side dominates.
    tax_net = t.get("Tax", 0.0)
    itc_asset    = max(tax_net, 0.0)   # positive → ITC on asset side
    gst_liability = abs(min(tax_net, 0.0))  # negative → GST payable

    # Credit-normal: debit-credit is negative for balances owed
    LIAB_TYPES = ("Liability", "Payable")
    raw_liabilities = sum(abs(t.get(tp, 0.0)) for tp in LIAB_TYPES)

    inventory_value = t.get("Stock", 0.0)
    cash_and_bank   = t.get("Cash", 0.0) + t.get("Bank", 0.0)
    receivables     = t.get("Receivable", 0.0)
    other_assets    = t.get("Asset", 0.0)
    payables        = abs(t.get("Payable", 0.0))
    other_liab      = abs(t.get("Liability", 0.0))

    return {
        "total_assets":      raw_assets + itc_asset,
        "cash_and_bank":     cash_and_bank,
        "receivables":       receivables,
        "inventory_value":   inventory_value,
        "itc_receivable":    itc_asset,
        "other_assets":      other_assets,
        "total_liabilities": raw_liabilities + gst_liability,
        "payables":          payables,
        "gst_liability":     gst_liability,
        "other_liabilities": other_liab,
        "total_equity":      abs(t.get("Equity", 0.0)),
    }


@frappe.whitelist()
def get_cash_flow(company: str, from_date: str, to_date: str) -> dict:
    """
    Simplified cash-flow statement.
    Operating = Net Income (Revenue − Expenses − COGS)
    Investing  = net movement in Asset/Stock accounts
    Financing  = net movement in Equity − Liability accounts
    """
    rows = frappe.db.sql("""
        SELECT a.account_type,
               COALESCE(SUM(g.debit) - SUM(g.credit), 0) AS net
        FROM `tabGeneral Ledger Entry` g
        JOIN `tabAccount` a ON a.name = g.account
        WHERE g.company      = %(company)s
          AND g.is_cancelled  = 0
          AND g.posting_date BETWEEN %(from_date)s AND %(to_date)s
        GROUP BY a.account_type
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)

    by_type = {r.account_type: flt(r.net) for r in rows}
    # Operating: revenue less all cost/expense types
    operating = (
        -by_type.get("Income", 0)            # income is credit-normal
        + by_type.get("Expense", 0)
        + by_type.get("Cost of Goods Sold", 0)
    )
    investing  = by_type.get("Asset", 0) + by_type.get("Stock", 0)
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
    wh_cond      = "AND b.warehouse = %(warehouse)s" if warehouse else ""
    company_cond = "AND b.company   = %(company)s"   if company   else ""
    params: dict = {"days": days}
    if warehouse:
        params["warehouse"] = warehouse
    if company:
        params["company"] = company

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
          {company_cond}
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
        WHERE gle.company      = %(company)s
          AND gle.is_cancelled  = 0
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
            SUM(CASE WHEN a.account_type = 'Income'
                     THEN gle.credit - gle.debit ELSE 0 END) AS income,
            SUM(CASE WHEN a.account_type IN ('Expense', 'Cost of Goods Sold')
                     THEN gle.debit - gle.credit ELSE 0 END) AS expense
        FROM `tabGeneral Ledger Entry` gle
        JOIN `tabAccount` a ON a.name = gle.account
        WHERE gle.company    = %(company)s
          AND gle.is_cancelled = 0
          AND gle.posting_date BETWEEN %(from_date)s AND %(to_date)s
          AND a.account_type IN ('Income', 'Expense', 'Cost of Goods Sold')
        GROUP BY DATE_FORMAT(gle.posting_date, '%%Y-%%m')
        ORDER BY month
    """, {"company": company, "from_date": from_date, "to_date": to_date}, as_dict=True)

    for r in rows:
        r["profit"] = flt(r.get("income")) - flt(r.get("expense"))

    return rows


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


# ── Report Drill-Down (Audit Part 3 — Limited Report Drill-Down) ──────────────

@frappe.whitelist()
def get_account_ledger(
    account: str,
    company: str,
    from_date: str,
    to_date: str,
    party_type: str = None,
    party: str = None,
) -> dict:
    """
    Drill-down: full GL ledger for a single account in a date range.
    Returns opening balance, all period movements, closing balance.
    Used when the user clicks an account balance in P&L / Balance Sheet.
    """
    # Opening balance (all entries before from_date)
    opening_result = frappe.db.sql("""
        SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS opening
        FROM `tabGeneral Ledger Entry`
        WHERE account     = %(account)s
          AND company     = %(company)s
          AND is_cancelled = 0
          AND posting_date < %(from_date)s
    """, {"account": account, "company": company, "from_date": from_date}, as_dict=True)
    opening = flt(opening_result[0].opening) if opening_result else 0.0

    # Period entries
    conds = [
        "account = %(account)s",
        "company = %(company)s",
        "is_cancelled = 0",
        "posting_date BETWEEN %(from_date)s AND %(to_date)s",
    ]
    params = {"account": account, "company": company,
              "from_date": from_date, "to_date": to_date}

    if party_type:
        conds.append("party_type = %(party_type)s")
        params["party_type"] = party_type
    if party:
        conds.append("party = %(party)s")
        params["party"] = party

    where = " AND ".join(conds)
    entries = frappe.db.sql(f"""
        SELECT
            name, posting_date, voucher_type, voucher_no,
            party_type, party, debit, credit, remarks,
            (SUM(debit - credit) OVER (
                ORDER BY posting_date, creation
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) + %(opening)s) AS running_balance
        FROM `tabGeneral Ledger Entry`
        WHERE {where}
        ORDER BY posting_date, creation
    """, {**params, "opening": opening}, as_dict=True)

    total_debit  = sum(flt(e.debit)  for e in entries)
    total_credit = sum(flt(e.credit) for e in entries)
    closing      = opening + total_debit - total_credit

    return {
        "account":     account,
        "from_date":   from_date,
        "to_date":     to_date,
        "opening":     opening,
        "total_debit": total_debit,
        "total_credit":total_credit,
        "closing":     closing,
        "entries":     [dict(e) for e in entries],
    }


@frappe.whitelist()
def get_voucher_detail(voucher_type: str, voucher_no: str) -> dict:
    """
    Drill-down: all GL entries for a single voucher (invoice, payment, etc.).
    Also returns metadata about the source document.
    Used when clicking any voucher_no link in ledger or report views.
    """
    gl_entries = frappe.db.sql("""
        SELECT
            name, posting_date, account, party_type, party,
            debit, credit, remarks, voucher_type, voucher_no,
            is_cancelled, is_reversal
        FROM `tabGeneral Ledger Entry`
        WHERE voucher_type = %(vt)s AND voucher_no = %(vn)s
        ORDER BY posting_date, creation
    """, {"vt": voucher_type, "vn": voucher_no}, as_dict=True)

    total_debit  = sum(flt(e.debit)  for e in gl_entries if not e.is_cancelled)
    total_credit = sum(flt(e.credit) for e in gl_entries if not e.is_cancelled)

    # Fetch lightweight source doc fields for context
    extra = {}
    try:
        if voucher_type in ("Sales Invoice",):
            extra = frappe.get_value(voucher_type, voucher_no,
                ["customer", "customer_name", "grand_total", "outstanding_amount"],
                as_dict=True) or {}
        elif voucher_type in ("Purchase Invoice",):
            extra = frappe.get_value(voucher_type, voucher_no,
                ["supplier", "grand_total", "outstanding_amount"],
                as_dict=True) or {}
        elif voucher_type == "Payment Entry":
            extra = frappe.get_value(voucher_type, voucher_no,
                ["party_type", "party", "paid_amount", "payment_type"],
                as_dict=True) or {}
        elif voucher_type == "Stock Entry":
            extra = frappe.get_value(voucher_type, voucher_no,
                ["stock_entry_type", "total_outgoing_value", "total_incoming_value"],
                as_dict=True) or {}
    except Exception:
        pass

    return {
        "voucher_type":  voucher_type,
        "voucher_no":    voucher_no,
        "gl_entries":    [dict(e) for e in gl_entries],
        "total_debit":   total_debit,
        "total_credit":  total_credit,
        "is_balanced":   abs(total_debit - total_credit) < 0.01,
        "source_doc":    dict(extra) if extra else {},
    }


@frappe.whitelist()
def get_pl_account_breakdown(
    company: str, from_date: str, to_date: str, account_type: str = "Income"
) -> list[dict]:
    """
    Drill-down: P&L breakdown by individual account within a type (Income/Expense).
    Click Income total → see each income account with its amount.
    Click an account → get_account_ledger for full transactions.
    """
    return frappe.db.sql("""
        SELECT
            gle.account,
            a.account_type,
            COALESCE(SUM(gle.credit) - SUM(gle.debit), 0) AS amount,
            COUNT(DISTINCT gle.voucher_no) AS transaction_count
        FROM `tabGeneral Ledger Entry` gle
        JOIN `tabAccount` a ON a.name = gle.account
        WHERE gle.company      = %(company)s
          AND gle.is_cancelled  = 0
          AND gle.posting_date BETWEEN %(from_date)s AND %(to_date)s
          AND a.account_type   = %(account_type)s
        GROUP BY gle.account, a.account_type
        ORDER BY ABS(SUM(gle.credit) - SUM(gle.debit)) DESC
    """, {"company": company, "from_date": from_date,
          "to_date": to_date, "account_type": account_type}, as_dict=True)


@frappe.whitelist()
def get_party_ledger(
    party_type: str,
    party: str,
    company: str,
    from_date: str = None,
    to_date: str = None,
) -> dict:
    """
    Drill-down: complete ledger for a customer or supplier — all invoices,
    payments, and outstanding per document.  Used in customer/supplier cards.
    """
    inv_dt     = "Sales Invoice"    if party_type == "Customer" else "Purchase Invoice"
    party_fld  = "customer"         if party_type == "Customer" else "supplier"

    inv_filters = {party_fld: party, "company": company, "docstatus": 1}
    if from_date:
        inv_filters["posting_date"] = [">=", from_date]
    if to_date:
        inv_filters["posting_date"] = ["<=", to_date]

    invoices = frappe.get_all(
        inv_dt,
        filters=inv_filters,
        fields=["name", "posting_date", "due_date", "grand_total",
                "outstanding_amount", "status", "currency"],
        order_by="posting_date desc",
        limit=500,
    )

    pay_filters = {"party_type": party_type, "party": party,
                   "company": company, "docstatus": 1}
    payments = frappe.get_all(
        "Payment Entry",
        filters=pay_filters,
        fields=["name", "payment_date", "payment_type", "paid_amount", "mode_of_payment"],
        order_by="payment_date desc",
        limit=200,
    )

    total_invoiced    = sum(flt(i.grand_total)        for i in invoices)
    total_outstanding = sum(flt(i.outstanding_amount) for i in invoices)
    total_paid        = total_invoiced - total_outstanding

    return {
        "party_type":        party_type,
        "party":             party,
        "total_invoiced":    total_invoiced,
        "total_paid":        total_paid,
        "total_outstanding": total_outstanding,
        "invoices":          [dict(i) for i in invoices],
        "payments":          [dict(p) for p in payments],
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
