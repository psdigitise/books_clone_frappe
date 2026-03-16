import frappe
from frappe import _


def after_install():
    create_roles()
    seed_naming_series()
    create_default_accounts()
    frappe.db.commit()
    print("✅  Zoho Books Clone installed successfully!")


def after_migrate():
    seed_naming_series()
    frappe.db.commit()


def create_roles():
    for role in ["Books Admin", "Accountant", "Books Manager", "Books Viewer"]:
        if not frappe.db.exists("Role", role):
            frappe.get_doc({"doctype": "Role", "role_name": role}).insert(ignore_permissions=True)


def seed_naming_series():
    """
    Ensure naming series exist in the NamingSeries DocType.
    Without this, "New Sales Invoice" button throws 'Series not found'.
    """
    series = {
        "Sales Invoice":    "INV-.YYYY.-.#####",
        "Purchase Invoice": "PINV-.YYYY.-.#####",
        "Payment Entry":    "PAY-.YYYY.-.#####",
        "Bank Transaction": "BTXN-.YYYY.-.#####",
    }
    for doctype, prefix in series.items():
        # frappe.model.naming stores series in __NamingSeries doc
        try:
            ns = frappe.get_doc("Naming Series") if frappe.db.exists("Naming Series") else None
            current = frappe.db.get_value("Naming Series", None, "user_must_always_select") or ""
        except Exception:
            pass
        # Ensure the series counter exists
        key = f"{prefix}."
        if not frappe.db.exists("Series", key):
            try:
                frappe.db.sql("INSERT IGNORE INTO `tabSeries` (name, current) VALUES (%s, 0)", key)
            except Exception:
                pass
    frappe.db.commit()


def create_default_accounts():
    try:
        company = frappe.db.get_single_value("Books Settings", "default_company") or ""
    except Exception:
        company = ""
    if not company:
        return

    coa = [
        ("Assets",                "Asset",     None,                 1),
        ("Current Assets",        "Asset",     "Assets",             1),
        ("Cash",                  "Cash",      "Current Assets",     0),
        ("Bank Accounts",         "Bank",      "Current Assets",     1),
        ("Accounts Receivable",   "Receivable","Current Assets",     0),
        ("Fixed Assets",          "Asset",     "Assets",             1),
        ("Liabilities",           "Liability", None,                 1),
        ("Current Liabilities",   "Liability", "Liabilities",        1),
        ("Accounts Payable",      "Payable",   "Current Liabilities",0),
        ("GST Payable",           "Tax",       "Current Liabilities",0),
        ("Equity",                "Equity",    None,                 1),
        ("Retained Earnings",     "Equity",    "Equity",             0),
        ("Income",                "Income",    None,                 1),
        ("Sales Revenue",         "Income",    "Income",             0),
        ("Other Income",          "Income",    "Income",             0),
        ("Expenses",              "Expense",   None,                 1),
        ("Cost of Goods Sold",    "Expense",   "Expenses",           0),
        ("Operating Expenses",    "Expense",   "Expenses",           1),
        ("Salaries & Wages",      "Expense",   "Operating Expenses", 0),
        ("Rent",                  "Expense",   "Operating Expenses", 0),
        ("Office Supplies",       "Expense",   "Operating Expenses", 0),
    ]

    for name, atype, parent, is_group in coa:
        if not frappe.db.exists("Account", {"account_name": name, "company": company}):
            try:
                frappe.get_doc({
                    "doctype":       "Account",
                    "account_name":  name,
                    "account_type":  atype,
                    "parent_account": parent,
                    "is_group":      is_group,
                    "company":       company,
                    "currency":      "INR",
                }).insert(ignore_permissions=True)
            except Exception as e:
                frappe.log_error(str(e), f"Account seed: {name}")
