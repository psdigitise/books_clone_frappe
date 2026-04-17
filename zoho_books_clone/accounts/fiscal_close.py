"""
Fiscal Year Closing Utility — Zoho Books Workflow Audit.

Provides a whitelisted API to close a fiscal year by:
  1. Calculating net P&L (Income − Expense − COGS) for the year
  2. Creating a closing Journal Entry that transfers net profit/loss
     to the Retained Earnings equity account
  3. Marking the Fiscal Year as closed

This mirrors Zoho Books' year-end closing workflow.
"""

import frappe
from frappe import _
from frappe.utils import flt, getdate


@frappe.whitelist(allow_guest=False)
def close_fiscal_year(fiscal_year: str, retained_earnings_account: str = None) -> dict:
    """
    Close a fiscal year by posting a closing Journal Entry.

    Steps:
      - Sum all Income credits and Expense/COGS debits for the year
      - Post a JE: DR Income accounts (zero them) / CR Retained Earnings (if profit)
        or DR Retained Earnings / CR Expense accounts (if loss)
      - Mark Fiscal Year as closed

    Returns: {journal_entry, net_profit, fiscal_year}
    """
    fy = frappe.get_doc("Fiscal Year", fiscal_year)

    if getattr(fy, "is_closed", 0):
        frappe.throw(_("Fiscal Year {0} is already closed.").format(fiscal_year))

    company = getattr(fy, "company", None)
    if not company:
        company = (
            frappe.db.get_single_value("Books Settings", "default_company")
            or frappe.defaults.get_default("company")
        )
    if not company:
        frappe.throw(_("No company found. Please set a default company in Books Settings."))

    # Resolve retained earnings account
    re_account = retained_earnings_account or _get_retained_earnings(company)
    if not re_account:
        frappe.throw(_(
            "No Retained Earnings account found for company {0}. "
            "Please create an Equity-type account named 'Retained Earnings'."
        ).format(company))

    start_date = fy.year_start_date
    end_date = fy.year_end_date

    # Calculate total income and total expenses for the period
    income_total = _sum_by_root_type(company, start_date, end_date, "Income")
    expense_total = _sum_by_root_type(company, start_date, end_date, "Expense")
    cogs_total = _sum_by_root_type(company, start_date, end_date, "Cost of Goods Sold")

    net_profit = income_total - expense_total - cogs_total

    if not net_profit:
        # Still mark as closed even if zero
        frappe.db.set_value("Fiscal Year", fiscal_year, "is_closed", 1)
        return {
            "journal_entry": None,
            "net_profit": 0,
            "fiscal_year": fiscal_year,
            "message": "No net profit/loss to transfer. Fiscal year marked as closed.",
        }

    # Build closing Journal Entry
    je = frappe.get_doc({
        "doctype": "Journal Entry",
        "posting_date": end_date,
        "company": company,
        "fiscal_year": fiscal_year,
        "remark": _("Year-end closing entry for Fiscal Year {0}").format(fiscal_year),
        "accounts": [],
    })

    if net_profit > 0:
        # Profit: DR a summary income clearing, CR Retained Earnings
        je.append("accounts", {
            "account": _get_summary_account(company, "Income"),
            "debit": flt(net_profit),
            "credit": 0,
        })
        je.append("accounts", {
            "account": re_account,
            "debit": 0,
            "credit": flt(net_profit),
        })
    else:
        # Loss: DR Retained Earnings, CR a summary expense clearing
        loss = abs(net_profit)
        je.append("accounts", {
            "account": re_account,
            "debit": flt(loss),
            "credit": 0,
        })
        je.append("accounts", {
            "account": _get_summary_account(company, "Expense"),
            "debit": 0,
            "credit": flt(loss),
        })

    je.flags.ignore_permissions = True
    je.insert()
    je.submit()

    # Mark fiscal year as closed
    frappe.db.set_value("Fiscal Year", fiscal_year, "is_closed", 1)

    return {
        "journal_entry": je.name,
        "net_profit": net_profit,
        "fiscal_year": fiscal_year,
        "message": _("Fiscal Year {0} closed. Net {1}: {2}").format(
            fiscal_year,
            "Profit" if net_profit > 0 else "Loss",
            frappe.format_value(abs(net_profit), {"fieldtype": "Currency"}),
        ),
    }


@frappe.whitelist(allow_guest=False)
def reopen_fiscal_year(fiscal_year: str) -> dict:
    """Reopen a closed fiscal year (System Manager only)."""
    if "System Manager" not in frappe.get_roles(frappe.session.user):
        frappe.throw(_("Only System Managers can reopen a closed fiscal year."))

    frappe.db.set_value("Fiscal Year", fiscal_year, "is_closed", 0)
    return {"fiscal_year": fiscal_year, "status": "Reopened"}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _sum_by_root_type(company, start_date, end_date, account_type):
    """Sum net GL balance for all accounts of a given type within a date range."""
    result = frappe.db.sql("""
        SELECT COALESCE(SUM(gle.credit) - SUM(gle.debit), 0) AS net
        FROM `tabGeneral Ledger Entry` gle
        JOIN `tabAccount` acc ON acc.name = gle.account
        WHERE acc.company = %(company)s
          AND acc.account_type IN %(types)s
          AND gle.posting_date BETWEEN %(start)s AND %(end)s
          AND gle.is_cancelled = 0
    """, {
        "company": company,
        "types": _type_list(account_type),
        "start": start_date,
        "end": end_date,
    }, as_dict=True)

    val = flt(result[0].net) if result else 0
    # For Income: credit - debit is positive (income earned)
    # For Expense/COGS: credit - debit is negative (expenses incurred) → we want positive
    if account_type in ("Expense", "Cost of Goods Sold"):
        return abs(val)
    return val


def _type_list(account_type):
    """Map logical type to the actual account_type values used in the Account DocType."""
    return {
        "Income": ("Income",),
        "Expense": ("Expense", "Expense Account"),
        "Cost of Goods Sold": ("Cost of Goods Sold",),
    }.get(account_type, (account_type,))


def _get_retained_earnings(company):
    return frappe.db.get_value(
        "Account",
        {"account_type": "Equity", "company": company, "is_group": 0,
         "account_name": ["like", "%Retained%"]},
        "name",
    ) or frappe.db.get_value(
        "Account",
        {"account_type": "Equity", "company": company, "is_group": 0},
        "name",
    )


def _get_summary_account(company, root_type):
    """Get the top-level group account for Income or Expense to use as closing entry source."""
    type_map = {"Income": "Income", "Expense": "Expense"}
    return frappe.db.get_value(
        "Account",
        {"account_type": type_map.get(root_type, root_type),
         "company": company, "is_group": 0},
        "name",
    )
