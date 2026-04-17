"""
Central Validation Layer — P2/Issue 10
Wired via hooks.py doc_events so every financial document passes through
one consistent set of safety checks before being saved or submitted.
"""
import frappe
from frappe import _
from frappe.utils import flt, getdate


# ─── Hook entry point ─────────────────────────────────────────────────────────

def on_validate(doc, method=None):
    """
    Called for every financial doctype listed in hooks.py doc_events.
    Runs checks that apply across all document types.
    """
    _check_company(doc)
    _check_posting_date(doc)
    _check_positive_amounts(doc)
    _check_period_not_closed(doc)
    _check_lock_date(doc)          # Audit: strict period lock


def on_submit(doc, method=None):
    """Extra guards run at submit time (after validate)."""
    _check_required_accounts(doc)


# ─── Individual checks ────────────────────────────────────────────────────────

def _check_company(doc):
    """Every financial document must belong to a company."""
    if not getattr(doc, "company", None):
        frappe.throw(_("Company is required on {0}").format(doc.doctype))
    # Only validate against the Company master if that DocType exists in this
    # installation. In standalone Frappe (without ERPNext), Company is stored as
    # a plain Data field, so there is no tabCompany to query.
    if (frappe.db.table_exists("tabCompany")
            and not frappe.db.exists("Company", doc.company)):
        frappe.throw(_(
            "Company '{0}' does not exist. Please set up your company first."
        ).format(doc.company))


def _check_posting_date(doc):
    """Posting date must be present and not obviously invalid."""
    date_field = _posting_date_field(doc)
    if not date_field:
        return
    date_val = getattr(doc, date_field, None)
    if not date_val:
        frappe.throw(_("Posting date is required on {0}").format(doc.doctype))
    try:
        getdate(date_val)
    except Exception:
        frappe.throw(_("Invalid posting date '{0}' on {1}").format(date_val, doc.doctype))


def _check_positive_amounts(doc):
    """Key monetary fields must be ≥ 0."""
    for field in ("grand_total", "net_total", "paid_amount"):
        val = getattr(doc, field, None)
        if val is not None and flt(val) < 0:
            frappe.throw(_(
                "'{0}' cannot be negative on {1} {2}"
            ).format(field, doc.doctype, doc.name or ""))


def _check_period_not_closed(doc):
    """
    If the fiscal year covering the posting date is closed, block the save.
    This is a lighter check than validate_fiscal_year (which also handles lock_date);
    here we just guard against accidentally saving to a closed year.
    """
    date_field = _posting_date_field(doc)
    company    = getattr(doc, "company", None)
    if not date_field or not company:
        return
    posting_date = getattr(doc, date_field, None)
    if not posting_date:
        return
    closed = frappe.db.sql("""
        SELECT name FROM `tabFiscal Year`
        WHERE company         = %s
          AND is_closed        = 1
          AND year_start_date <= %s
          AND year_end_date   >= %s
        LIMIT 1
    """, (company, posting_date, posting_date))
    if closed:
        frappe.throw(_(
            "Fiscal Year {0} is closed. Re-open it before posting to {1}."
        ).format(closed[0][0], posting_date))


def _check_lock_date(doc):
    """
    Audit: Strict period lock — block any save/submit on a document whose
    posting date falls on or before the Books Lock Date configured in
    Books Settings.  System Managers are exempt so they can perform corrections.
    """
    try:
        lock_date = frappe.db.get_single_value("Books Settings", "lock_date")
    except Exception:
        return   # Books Settings may not exist yet during install

    if not lock_date:
        return

    date_field = _posting_date_field(doc)
    if not date_field:
        return

    posting_date = getattr(doc, date_field, None)
    if not posting_date:
        return

    # System Managers bypass the lock so they can make corrections
    if "System Manager" in frappe.get_roles(frappe.session.user):
        return

    if getdate(posting_date) <= getdate(lock_date):
        frappe.throw(_(
            "The period up to {0} is locked. You cannot create or edit {1} documents "
            "dated on or before the lock date. Contact your System Manager to unlock the period."
        ).format(frappe.bold(lock_date), doc.doctype))


def _check_required_accounts(doc):
    """On submit, ensure the accounts that drive GL entries are set."""
    checks = {
        "Sales Invoice":    [("debit_to", "Debit To (AR)"), ("income_account", "Income Account")],
        "Purchase Invoice": [("credit_to", "Credit To (AP)"), ("expense_account", "Expense Account")],
        "Payment Entry":    [("paid_from", "Paid From"), ("paid_to", "Paid To")],
        "Credit Note":      [("debit_to", "Debit To (AR)"), ("income_account", "Income Account")],
    }
    for field, label in checks.get(doc.doctype, []):
        if not getattr(doc, field, None):
            frappe.throw(_(
                "'{0}' is required before submitting {1}"
            ).format(label, doc.doctype))


# ─── Helper ───────────────────────────────────────────────────────────────────

def _posting_date_field(doc) -> str | None:
    """Return the name of the date field used as posting date for this doctype."""
    return {
        "Sales Invoice":    "posting_date",
        "Purchase Invoice": "posting_date",
        "Payment Entry":    "payment_date",
        "Journal Entry":    "posting_date",
        "Credit Note":      "posting_date",
        "Expense":          "posting_date",
        "Expense Claim":    "claim_date",
    }.get(doc.doctype)
