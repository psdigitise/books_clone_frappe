"""
REST API endpoints for the Books dashboard.
Accessible at /api/method/zoho_books_clone.api.dashboard.*
"""
import frappe
from frappe.utils import flt, today, get_first_day, get_last_day
from zoho_books_clone.db import queries, aggregates


@frappe.whitelist()
def get_home_dashboard(company: str | None = None) -> dict:
    """
    All data needed to render the Books home dashboard in one call.
    Returns KPIs, revenue trend, aging buckets, and top customers.
    """
    company = company or frappe.db.get_single_value("Global Defaults", "default_company")
    t   = today()
    som = str(get_first_day(t))
    eom = str(get_last_day(t))

    return {
        "kpis":            aggregates.get_dashboard_kpis(company),
        "revenue_trend":   aggregates.get_monthly_revenue_trend(company, months=6),
        "aging_buckets":   aggregates.get_aging_buckets(company),
        "top_customers":   queries.get_top_customers(company, som, eom, limit=5),
        "overdue_invoices":queries.get_overdue_invoices(company),
        "gst_summary":     queries.get_gst_summary(company, som, eom),
    }


@frappe.whitelist()
def get_cash_position(company: str | None = None) -> dict:
    """
    Cash & bank balances across all bank accounts + GL cash account.
    """
    company = company or frappe.db.get_single_value("Global Defaults", "default_company")
    bank_accounts = frappe.get_all(
        "Bank Account",
        filters={"company": company},
        fields=["name", "account_name", "bank_name", "current_balance", "currency"],
    )
    total = sum(flt(b.current_balance) for b in bank_accounts)
    return {"bank_accounts": bank_accounts, "total_cash": total}


@frappe.whitelist()
def search_transactions(query: str, company: str | None = None) -> list[dict]:
    """
    Full-text search across invoices and payments.
    Used by the global search bar in the Books UI.
    """
    company = company or frappe.db.get_single_value("Global Defaults", "default_company")
    like = f"%{query}%"

    invoices = frappe.db.sql("""
        SELECT 'Sales Invoice' AS doctype, name, customer AS party,
               grand_total AS amount, posting_date AS date, status
        FROM `tabSales Invoice`
        WHERE company = %(company)s AND docstatus != 2
          AND (name LIKE %(q)s OR customer LIKE %(q)s OR customer_name LIKE %(q)s)
        LIMIT 10
    """, {"company": company, "q": like}, as_dict=True)

    payments = frappe.db.sql("""
        SELECT 'Payment Entry' AS doctype, name, party,
               paid_amount AS amount, payment_date AS date, payment_type AS status
        FROM `tabPayment Entry`
        WHERE company = %(company)s AND docstatus != 2
          AND (name LIKE %(q)s OR party LIKE %(q)s)
        LIMIT 10
    """, {"company": company, "q": like}, as_dict=True)

    return sorted(invoices + payments, key=lambda r: r["date"] or "", reverse=True)
