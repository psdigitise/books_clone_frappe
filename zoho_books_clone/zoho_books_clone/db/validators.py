"""
Cross-doctype validation helpers.
Called from DocType controllers before saving/submitting.
"""
import frappe
from frappe import _
from frappe.utils import getdate


def validate_fiscal_year(posting_date: str, company: str) -> str:
    """
    Return fiscal year name for the given posting date + company.
    Auto-creates a fiscal year if none exists — never blocks saving.
    """
    date = getdate(posting_date)

    # 1. Try matching by company + date
    fy = frappe.db.sql("""
        SELECT name FROM `tabFiscal Year`
        WHERE is_closed = 0
          AND year_start_date <= %(date)s
          AND year_end_date   >= %(date)s
          AND (
            EXISTS (
              SELECT 1 FROM `tabFiscal Year Company`
              WHERE parent = `tabFiscal Year`.name
                AND company = %(company)s
            )
            OR NOT EXISTS (
              SELECT 1 FROM `tabFiscal Year Company`
              WHERE parent = `tabFiscal Year`.name
            )
          )
        LIMIT 1
    """, {"company": company, "date": posting_date}, as_dict=True)

    if fy:
        return fy[0].name

    # 2. Try any open fiscal year covering the date (ignore company)
    fy = frappe.db.sql("""
        SELECT name FROM `tabFiscal Year`
        WHERE is_closed = 0
          AND year_start_date <= %(date)s
          AND year_end_date   >= %(date)s
        LIMIT 1
    """, {"date": posting_date}, as_dict=True)

    if fy:
        return fy[0].name

    # 3. Auto-create a fiscal year for this calendar year
    year = date.year
    fy_name = str(year)
    if not frappe.db.exists("Fiscal Year", fy_name):
        try:
            new_fy = frappe.get_doc({
                "doctype": "Fiscal Year",
                "year": fy_name,
                "year_start_date": f"{year}-01-01",
                "year_end_date": f"{year}-12-31",
            })
            new_fy.insert(ignore_permissions=True)
            frappe.db.commit()
            return fy_name
        except Exception:
            pass

    # 4. Return a best-guess name rather than blocking
    return fy_name


def validate_account_company(account: str, company: str) -> None:
    """Ensure an account belongs to the given company — skip if no company set."""
    if not company:
        return
    acc_company = frappe.db.get_value("Account", account, "company")
    if acc_company and acc_company != company:
        frappe.throw(
            _("Account {0} belongs to company {1}, not {2}").format(account, acc_company, company)
        )


def validate_account_type(account: str, expected_types: list[str]) -> None:
    """Ensure an account is one of the expected types."""
    acc_type = frappe.db.get_value("Account", account, "account_type")
    if acc_type and acc_type not in expected_types:
        frappe.throw(
            _("Account {0} must be of type {1}, found {2}").format(
                account, "/".join(expected_types), acc_type
            )
        )


def validate_no_future_date(date_str: str, field_label: str) -> None:
    """Prevent future posting dates (configurable — enable in Books Settings)."""
    try:
        allow_future = frappe.db.get_single_value("Books Settings", "allow_future_dates")
    except Exception:
        allow_future = True
    if not allow_future and getdate(date_str) > getdate():
        frappe.throw(_("{0} cannot be a future date").format(field_label))


def validate_duplicate_bill(supplier: str, bill_no: str, bill_date: str) -> None:
    """Prevent duplicate purchase invoices for the same supplier bill number."""
    if not bill_no:
        return
    existing = frappe.db.get_value(
        "Purchase Invoice",
        {"supplier": supplier, "bill_no": bill_no, "bill_date": bill_date, "docstatus": ["!=", 2]},
        "name",
    )
    if existing:
        frappe.throw(
            _("Duplicate bill: invoice {0} already recorded for supplier {1} with bill no {2}").format(
                existing, supplier, bill_no
            )
        )
