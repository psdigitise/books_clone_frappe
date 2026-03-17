"""
books_data.py – Whitelisted data-access endpoints for the Books frontend.
All methods are decorated with @frappe.whitelist() so any logged-in user
can call them without needing explicit DocType-level read permissions.
"""
import frappe


def _company():
    try:
        rows = frappe.db.get_all("Company", fields=["name"], limit=1, order_by="creation asc")
        return rows[0].name if rows else ""
    except Exception:
        return ""


# ─── Lookup helpers ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_company():
    return _company()


@frappe.whitelist()
def get_customers(company=None):
    return frappe.db.get_all(
        "Customer",
        fields=["name", "customer_name"],
        filters={"disabled": 0},
        order_by="customer_name asc",
        limit=200,
    )


@frappe.whitelist()
def get_suppliers(company=None):
    return frappe.db.get_all(
        "Supplier",
        fields=["name", "supplier_name"],
        filters={"disabled": 0},
        order_by="supplier_name asc",
        limit=200,
    )


@frappe.whitelist()
def get_accounts(company=None, account_type=None, account_types=None):
    """
    account_type  – single string, e.g. "Receivable"
    account_types – comma-separated, e.g. "Bank,Cash"
    """
    if not company:
        company = _company()
    filters = {"company": company, "is_group": 0}
    if account_type:
        filters["account_type"] = account_type
    elif account_types:
        filters["account_type"] = ["in", [t.strip() for t in account_types.split(",")]]
    return frappe.db.get_all(
        "Account",
        fields=["name", "account_type"],
        filters=filters,
        order_by="account_name asc",
        limit=100,
    )


@frappe.whitelist()
def get_accounts_full(company=None):
    """All accounts with balance info for the Accounts page."""
    if not company:
        company = _company()
    return frappe.db.get_all(
        "Account",
        fields=["name", "account_name", "account_type", "parent_account", "is_group", "balance"],
        filters={"company": company},
        order_by="account_type asc, account_name asc",
        limit=500,
    )


@frappe.whitelist()
def get_tax_templates(company=None):
    return frappe.db.get_all(
        "Tax Template",
        fields=["name", "template_name"],
        order_by="template_name asc",
        limit=50,
    )


@frappe.whitelist()
def get_tax_template(name):
    doc = frappe.get_doc("Tax Template", name)
    return doc.as_dict()


@frappe.whitelist()
def get_modes_of_payment():
    return frappe.db.get_all(
        "Books Payment Mode",
        fields=["name", "mode_of_payment", "type"],
        filters={"enabled": 1},
        order_by="mode_of_payment asc",
        limit=50,
    )


# ─── List pages ──────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_sales_invoices(company=None):
    if not company:
        company = _company()
    return frappe.db.get_all(
        "Sales Invoice",
        fields=["name", "customer", "customer_name", "posting_date", "due_date",
                "grand_total", "outstanding_amount", "status"],
        filters={"company": company, "docstatus": ["!=", 2]},
        order_by="posting_date desc",
        limit=200,
    )


@frappe.whitelist()
def get_purchase_invoices(company=None):
    if not company:
        company = _company()
    return frappe.db.get_all(
        "Purchase Invoice",
        fields=["name", "supplier", "supplier_name", "posting_date", "due_date",
                "grand_total", "outstanding_amount", "status"],
        filters={"company": company, "docstatus": ["!=", 2]},
        order_by="posting_date desc",
        limit=200,
    )


@frappe.whitelist()
def get_payment_entries(company=None):
    if not company:
        company = _company()
    return frappe.db.get_all(
        "Payment Entry",
        fields=["name", "party", "party_type", "paid_amount", "payment_type",
                "payment_date", "mode_of_payment"],
        filters={"company": company, "docstatus": ["!=", 2]},
        order_by="payment_date desc",
        limit=200,
    )


@frappe.whitelist()
def get_bank_transactions(bank_account):
    return frappe.db.get_all(
        "Bank Transaction",
        fields=["name", "date", "description", "debit", "credit",
                "balance", "reference_number", "status"],
        filters={"bank_account": bank_account},
        order_by="date desc",
        limit=100,
    )


@frappe.whitelist()
def get_open_invoices(party_type, party, company=None):
    if not company:
        company = _company()
    dt = "Sales Invoice" if party_type == "Customer" else "Purchase Invoice"
    party_field = "customer" if party_type == "Customer" else "supplier"
    return frappe.db.get_all(
        dt,
        fields=["name", "posting_date", "grand_total", "outstanding_amount"],
        filters={
            "company": company,
            party_field: party,
            "docstatus": 1,
            "outstanding_amount": [">", 0],
        },
        order_by="posting_date asc",
        limit=50,
    )
