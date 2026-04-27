"""
Per-company bootstrap — runs on signup to seed a fresh company with the data
required for the golden flow (Customer → Item → Sales Invoice → Payment) to
work without manual setup.

Idempotent: every step checks for existence before inserting.
"""
import datetime

import frappe


COA = [
    # (account_name, account_type, parent, is_group)
    # account_type must be one of:
    # Asset / Liability / Income / Expense / Equity / Bank / Cash / Receivable / Payable / Tax
    ("Assets",                "Asset",     None,                  1),
    ("Current Assets",        "Asset",     "Assets",              1),
    ("Cash",                  "Cash",      "Current Assets",      0),
    ("Bank Accounts",         "Bank",      "Current Assets",      1),
    ("Accounts Receivable",   "Receivable","Current Assets",      0),
    ("Stock In Hand",         "Asset",     "Current Assets",      0),
    ("Liabilities",           "Liability", None,                  1),
    ("Current Liabilities",   "Liability", "Liabilities",         1),
    ("Accounts Payable",      "Payable",   "Current Liabilities", 0),
    ("CGST Payable",          "Tax",       "Current Liabilities", 0),
    ("SGST Payable",          "Tax",       "Current Liabilities", 0),
    ("IGST Payable",          "Tax",       "Current Liabilities", 0),
    ("Input Tax Credits",     "Tax",       "Current Assets",      1),
    ("CGST Input",            "Tax",       "Input Tax Credits",   0),
    ("SGST Input",            "Tax",       "Input Tax Credits",   0),
    ("IGST Input",            "Tax",       "Input Tax Credits",   0),
    ("Equity",                "Equity",    None,                  1),
    ("Retained Earnings",     "Equity",    "Equity",              0),
    ("Income",                "Income",    None,                  1),
    ("Sales Revenue",         "Income",    "Income",              0),
    ("Other Income",          "Income",    "Income",              0),
    ("Expenses",              "Expense",   None,                  1),
    ("Cost of Goods Sold",    "Expense",   "Expenses",            0),
    ("Stock Adjustment",      "Expense",   "Expenses",            0),
    ("Operating Expenses",    "Expense",   "Expenses",            1),
    ("Salaries & Wages",      "Expense",   "Operating Expenses",  0),
    ("Rent",                  "Expense",   "Operating Expenses",  0),
    ("Office Supplies",       "Expense",   "Operating Expenses",  0),
]


def bootstrap_company_data(company: str, fy_start: str = "04-01") -> None:
    """Seed a fresh company with the minimum data needed for invoicing."""
    if not company:
        return
    _seed_coa(company)
    _seed_fiscal_year(company, fy_start)


def _seed_coa(company: str) -> None:
    """Create the default Chart of Accounts for this company if absent."""
    for name, atype, parent, is_group in COA:
        if frappe.db.exists("Account", {"account_name": name, "company": company}):
            continue
        try:
            frappe.get_doc({
                "doctype":        "Account",
                "account_name":   name,
                "account_type":   atype,
                "parent_account": parent or "",
                "is_group":       is_group,
                "company":        company,
                "currency":       "INR",
            }).insert(ignore_permissions=True)
        except Exception as exc:
            frappe.log_error(f"Bootstrap COA — {company}/{name}: {exc}", "Books Bootstrap")


def _seed_fiscal_year(company: str, fy_start: str = "04-01") -> None:
    """Create a Fiscal Year for `company` covering today, if absent.

    Fiscal Year in this app is flat (no `companies` child table); the company
    is stored as a single Data field on the FY record. We use a per-company
    name (`<year>-<company-prefix>`) to avoid collisions across tenants.
    """
    try:
        today = datetime.date.today()
        month, day = (int(x) for x in (fy_start or "04-01").split("-"))

        start = datetime.date(today.year, month, day)
        if today < start:
            start = datetime.date(today.year - 1, month, day)
        end = datetime.date(start.year + 1, month, day) - datetime.timedelta(days=1)

        if start.year == end.year:
            year_label = str(start.year)
        else:
            year_label = f"{start.year}-{str(end.year)[-2:]}"

        # If a FY for this exact company+year already exists, skip
        if frappe.db.exists("Fiscal Year", {"year": year_label, "company": company}):
            return

        fy = frappe.new_doc("Fiscal Year")
        fy.year = year_label
        fy.year_start_date = start.strftime("%Y-%m-%d")
        fy.year_end_date = end.strftime("%Y-%m-%d")
        fy.company = company
        fy.insert(ignore_permissions=True)
    except Exception as exc:
        frappe.log_error(f"Bootstrap FY — {company}: {exc}", "Books Bootstrap")
