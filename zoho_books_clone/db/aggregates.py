"""
High-level aggregate helpers used by the dashboard and reports.
Wraps queries.py into structured summaries.
"""
import frappe
from frappe.utils import flt, get_first_day, get_last_day, getdate, today
from zoho_books_clone.db import queries


@frappe.whitelist()
def get_dashboard_kpis(company: str | None = None) -> dict:
    """
    Return KPI dict for the Books dashboard.
    Called from the desk homepage widget.
    """
    company = company or frappe.db.get_single_value("Global Defaults", "default_company")
    if not company:
        return {}

    t = today()
    som = str(get_first_day(t))   # start of month
    eom = str(get_last_day(t))    # end of month

    inv   = queries.get_invoice_summary(company, som, eom)
    pay   = queries.get_payment_summary(company, som, eom)
    pl    = queries.get_profit_and_loss(company, som, eom)
    bals  = queries.get_balance_sheet_totals(company, t)

    return {
        "month_revenue":      flt(inv.get("total_invoiced")),
        "month_collected":    flt(inv.get("total_collected")),
        "month_outstanding":  flt(inv.get("total_outstanding")),
        "month_payments_in":  flt(pay.get("total_received")),
        "month_payments_out": flt(pay.get("total_paid")),
        "net_profit_mtd":     flt(pl.get("net_profit")),
        "total_assets":       flt(bals.get("total_assets")),
        "total_liabilities":  flt(bals.get("total_liabilities")),
        "overdue_count":      len(queries.get_overdue_invoices(company)),
    }


@frappe.whitelist()
def get_monthly_revenue_trend(company: str | None = None, months: int = 6) -> list[dict]:
    """
    Revenue and expense per month for the last N months.
    Returns list of {month, revenue, expense, net}.
    """
    company = company or frappe.db.get_single_value("Global Defaults", "default_company")
    rows = frappe.db.sql("""
        SELECT
            DATE_FORMAT(si.posting_date, '%%Y-%%m') AS month,
            COALESCE(SUM(si.grand_total), 0)         AS revenue
        FROM `tabSales Invoice` si
        WHERE si.company   = %(company)s
          AND si.docstatus  = 1
          AND si.posting_date >= DATE_SUB(CURDATE(), INTERVAL %(months)s MONTH)
        GROUP BY month
        ORDER BY month
    """, {"company": company, "months": months}, as_dict=True)
    return rows


@frappe.whitelist()
def get_aging_buckets(company: str | None = None) -> dict:
    """
    AR aging summary: {current, 1_30, 31_60, 61_90, over_90}
    """
    company = company or frappe.db.get_single_value("Global Defaults", "default_company")
    t = today()
    rows = frappe.db.sql("""
        SELECT
            SUM(CASE WHEN DATEDIFF(%(today)s, due_date) <= 0  THEN outstanding_amount ELSE 0 END) AS current_amt,
            SUM(CASE WHEN DATEDIFF(%(today)s, due_date) BETWEEN  1 AND 30 THEN outstanding_amount ELSE 0 END) AS d1_30,
            SUM(CASE WHEN DATEDIFF(%(today)s, due_date) BETWEEN 31 AND 60 THEN outstanding_amount ELSE 0 END) AS d31_60,
            SUM(CASE WHEN DATEDIFF(%(today)s, due_date) BETWEEN 61 AND 90 THEN outstanding_amount ELSE 0 END) AS d61_90,
            SUM(CASE WHEN DATEDIFF(%(today)s, due_date) > 90 THEN outstanding_amount ELSE 0 END)              AS over_90
        FROM `tabSales Invoice`
        WHERE company = %(company)s AND docstatus = 1 AND outstanding_amount > 0
    """, {"company": company, "today": t}, as_dict=True)
    r = rows[0] if rows else {}
    return {
        "current":  flt(r.get("current_amt")),
        "1_30":     flt(r.get("d1_30")),
        "31_60":    flt(r.get("d31_60")),
        "61_90":    flt(r.get("d61_90")),
        "over_90":  flt(r.get("over_90")),
    }
