import frappe
from frappe import _


def after_install():
    create_roles()
    create_default_accounts()
    frappe.db.commit()
    print("✅ Zoho Books Clone installed successfully!")


def after_migrate():
    pass


def create_roles():
    roles = ["Books Admin", "Accountant", "Books Manager", "Books Viewer"]
    for role in roles:
        if not frappe.db.exists("Role", role):
            frappe.get_doc({"doctype":"Role","role_name":role}).insert(ignore_permissions=True)


def create_default_accounts():
    """Seed a minimal Indian chart of accounts."""
    company = frappe.db.get_single_value("Global Defaults", "default_company")
    if not company:
        return

    coa = [
        # (name, type, parent, is_group)
        ("Assets",                      "Asset",     None,          1),
        ("Current Assets",              "Asset",     "Assets",      1),
        ("Cash",                        "Cash",      "Current Assets", 0),
        ("Bank Accounts",               "Bank",      "Current Assets", 1),
        ("Accounts Receivable",         "Receivable","Current Assets", 0),
        ("Fixed Assets",                "Asset",     "Assets",      1),
        ("Liabilities",                 "Liability", None,          1),
        ("Current Liabilities",         "Liability", "Liabilities", 1),
        ("Accounts Payable",            "Payable",   "Current Liabilities", 0),
        ("GST Payable",                 "Tax",       "Current Liabilities", 0),
        ("Equity",                      "Equity",    None,          1),
        ("Retained Earnings",           "Equity",    "Equity",      0),
        ("Income",                      "Income",    None,          1),
        ("Sales Revenue",               "Income",    "Income",      0),
        ("Other Income",                "Income",    "Income",      0),
        ("Expenses",                    "Expense",   None,          1),
        ("Cost of Goods Sold",          "Expense",   "Expenses",    0),
        ("Operating Expenses",          "Expense",   "Expenses",    1),
        ("Salaries & Wages",            "Expense",   "Operating Expenses", 0),
        ("Rent",                        "Expense",   "Operating Expenses", 0),
        ("Office Supplies",             "Expense",   "Operating Expenses", 0),
    ]

    for (name, atype, parent, is_group) in coa:
        if not frappe.db.exists("Account", name):
            frappe.get_doc({
                "doctype":       "Account",
                "account_name":  name,
                "account_type":  atype,
                "parent_account": parent,
                "is_group":      is_group,
                "company":       company,
                "currency":      "INR",
            }).insert(ignore_permissions=True)
