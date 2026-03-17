import frappe
from frappe import _


def before_migrate():
    """Fix Module Def and DocType module assignments before Frappe runs orphan detection."""
    MODULE_APP_MAP = {
        "Books Setup": "zoho_books_clone",
        "Invoicing":   "zoho_books_clone",
        "Payments":    "zoho_books_clone",
        "Accounts":    "zoho_books_clone",
        "Banking":     "zoho_books_clone",
        "Taxes":       "zoho_books_clone",
        "Reports":     "zoho_books_clone",
    }
    DOCTYPE_MODULE_MAP = {
        "Books Payment Mode":      "Books Setup",
        "Books Settings":          "Books Setup",
        "Currency":                "Books Setup",
        "UOM":                     "Books Setup",
        "Payment Terms":           "Books Setup",
        "Sales Invoice":           "Invoicing",
        "Purchase Invoice":        "Invoicing",
        "Sales Invoice Item":      "Invoicing",
        "Purchase Invoice Item":   "Invoicing",
        "Customer":                "Invoicing",
        "Supplier":                "Invoicing",
        "Item":                    "Invoicing",
        "Tax Line":                "Invoicing",
        "Payment Entry":           "Payments",
        "Payment Entry Reference": "Payments",
        "Account":                 "Accounts",
        "Cost Center":             "Accounts",
        "Fiscal Year":             "Accounts",
        "General Ledger Entry":    "Accounts",
        "Bank Account":            "Banking",
        "Bank Transaction":        "Banking",
        "Tax Template":            "Taxes",
        "Tax Template Detail":     "Taxes",
    }
    for module, app in MODULE_APP_MAP.items():
        if frappe.db.exists("Module Def", module):
            frappe.db.set_value("Module Def", module, "app_name", app)
        else:
            frappe.get_doc({
                "doctype": "Module Def",
                "module_name": module,
                "app_name": app,
            }).insert(ignore_permissions=True, ignore_if_duplicate=True)
    for doctype, module in DOCTYPE_MODULE_MAP.items():
        if frappe.db.exists("DocType", doctype):
            frappe.db.set_value("DocType", doctype, "module", module)
    frappe.db.commit()


def after_install():
    create_roles()
    seed_naming_series()
    seed_currencies()
    seed_uoms()
    seed_modes_of_payment()
    seed_payment_terms()
    create_default_accounts()
    frappe.db.commit()
    print("✅  Zoho Books Clone installed successfully!")


def after_migrate():
    seed_naming_series()
    seed_currencies()
    seed_uoms()
    seed_modes_of_payment()
    seed_payment_terms()
    frappe.db.commit()


# ─── Roles ───────────────────────────────────────────────────────────────────
def create_roles():
    for role in ["Books Admin", "Accountant", "Books Manager", "Books Viewer"]:
        if not frappe.db.exists("Role", role):
            frappe.get_doc({"doctype": "Role", "role_name": role}).insert(ignore_permissions=True)


# ─── Naming Series ───────────────────────────────────────────────────────────
def seed_naming_series():
    series = {
        "Sales Invoice":    "INV-.YYYY.-.#####",
        "Purchase Invoice": "PINV-.YYYY.-.#####",
        "Payment Entry":    "PAY-.YYYY.-.#####",
        "Bank Transaction": "BTXN-.YYYY.-.#####",
        "Customer":         "CUST-.YYYY.-.#####",
        "Supplier":         "SUPP-.YYYY.-.#####",
    }
    for doctype, prefix in series.items():
        key = f"{prefix}."
        try:
            frappe.db.sql(
                "INSERT IGNORE INTO `tabSeries` (name, current) VALUES (%s, 0)", key
            )
        except Exception:
            pass
    frappe.db.commit()


# ─── Currencies ──────────────────────────────────────────────────────────────
def seed_currencies():
    currencies = [
        ("INR", "₹", "Paise",  100, "#,##,###.##"),
        ("USD", "$", "Cents",  100, "#,###.##"),
        ("EUR", "€", "Cents",  100, "#,###.##"),
        ("GBP", "£", "Pence",  100, "#,###.##"),
        ("AED", "د.إ","Fils",  100, "#,###.##"),
        ("SGD", "S$","Cents",  100, "#,###.##"),
    ]
    for code, symbol, fraction, units, fmt in currencies:
        if not frappe.db.exists("Currency", code):
            frappe.get_doc({
                "doctype":        "Currency",
                "currency_name":  code,
                "currency_symbol":symbol,
                "fraction":       fraction,
                "fraction_units": units,
                "number_format":  fmt,
                "enabled":        1,
            }).insert(ignore_permissions=True)


# ─── Units of Measure ────────────────────────────────────────────────────────
def seed_uoms():
    uoms = [
        ("Nos",     "Numbers / Units"),
        ("Kg",      "Kilogram"),
        ("Gram",    "Gram"),
        ("Liter",   "Liter"),
        ("Meter",   "Meter"),
        ("Hour",    "Hour"),
        ("Day",     "Day"),
        ("Month",   "Month"),
        ("Box",     "Box"),
        ("Pair",    "Pair"),
        ("Dozen",   "Dozen"),
        ("Quintal", "Quintal (100 Kg)"),
        ("Tonne",   "Metric Tonne"),
        ("Sq Meter","Square Meter"),
        ("Sq Foot", "Square Foot"),
    ]
    for name, desc in uoms:
        if not frappe.db.exists("UOM", name):
            frappe.get_doc({
                "doctype": "UOM",
                "uom_name": name,
                "description": desc,
                "enabled": 1,
            }).insert(ignore_permissions=True)


# ─── Modes of Payment ────────────────────────────────────────────────────────
def seed_modes_of_payment():
    modes = [
        ("Cash",          "Cash"),
        ("Bank Transfer", "Bank"),
        ("NEFT",          "Bank"),
        ("RTGS",          "Bank"),
        ("UPI",           "Bank"),
        ("Cheque",        "Bank"),
        ("Credit Card",   "Bank"),
        ("Debit Card",    "Bank"),
        ("Demand Draft",  "Bank"),
    ]
    for name, mtype in modes:
        if not frappe.db.exists("Books Payment Mode", name):
            frappe.get_doc({
                "doctype":        "Books Payment Mode",
                "mode_of_payment": name,
                "type":           mtype,
                "enabled":        1,
            }).insert(ignore_permissions=True)


# ─── Payment Terms ───────────────────────────────────────────────────────────
def seed_payment_terms():
    terms = [
        ("Net 30",        30, "Day(s) after invoice date"),
        ("Net 15",        15, "Day(s) after invoice date"),
        ("Net 7",          7, "Day(s) after invoice date"),
        ("Due on Receipt", 0, "Day(s) after invoice date"),
        ("Net 60",        60, "Day(s) after invoice date"),
        ("Net 90",        90, "Day(s) after invoice date"),
        ("End of Month",   0, "Day(s) after the end of the invoice month"),
    ]
    for name, days, basis in terms:
        if not frappe.db.exists("Payment Terms", name):
            frappe.get_doc({
                "doctype":           "Payment Terms",
                "payment_terms_name": name,
                "credit_days":       days,
                "due_date_based_on": basis,
            }).insert(ignore_permissions=True)


# ─── Chart of Accounts ───────────────────────────────────────────────────────
def create_default_accounts():
    company = frappe.db.get_single_value("Global Defaults", "default_company")
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
                    "doctype":        "Account",
                    "account_name":   name,
                    "account_type":   atype,
                    "parent_account": parent,
                    "is_group":       is_group,
                    "company":        company,
                    "currency":       "INR",
                }).insert(ignore_permissions=True)
            except Exception as e:
                frappe.log_error(str(e), f"Account seed: {name}")


# ─── Cost Centers ────────────────────────────────────────────────────────────
def seed_cost_centers():
    company = frappe.db.get_single_value("Global Defaults", "default_company")
    if not company:
        return
    if not frappe.db.exists("Cost Center", {"cost_center_name": "Main", "company": company}):
        try:
            frappe.get_doc({
                "doctype":          "Cost Center",
                "cost_center_name": "Main",
                "is_group":         0,
                "company":          company,
            }).insert(ignore_permissions=True)
        except Exception:
            pass
