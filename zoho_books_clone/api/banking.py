"""
Banking API — whitelisted endpoints for banking workflow operations.

Covers:
  - get_bank_accounts_with_balances: Bank accounts with GL-computed balances
  - bounce_cheque: GL reversal when a cheque bounces
  - post_bank_transfer: inter-account fund transfer with GL posting
  - create_bank_gl_entry: JE for unmatched bank transactions (charges, interest)
"""
import frappe
from frappe import _
from frappe.utils import flt, today
from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import (
    make_gl_entries,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _bank_gl(bank_account: str) -> str:
    gl = frappe.db.get_value("Bank Account", bank_account, "gl_account")
    if not gl:
        frappe.throw(_("Bank Account {0} has no GL account linked.").format(bank_account))
    return gl


def _company(bank_account: str) -> str:
    co = frappe.db.get_value("Bank Account", bank_account, "company")
    return co or frappe.defaults.get_default("company") or ""


# ─── Endpoints ────────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_bank_accounts_with_balances(company: str = None) -> list:
    """
    Return all Bank Accounts for the company with their live GL balance,
    reconciliation stats, and recent transactions count.
    """
    if not company:
        company = frappe.db.get_single_value("Books Settings", "default_company") or ""

    accounts = frappe.get_all(
        "Bank Account",
        filters={"company": company} if company else {},
        fields=[
            "name", "account_name", "bank_name", "account_number", "ifsc_code",
            "gl_account", "currency", "is_default", "account_type",
        ],
        order_by="is_default desc, creation asc",
        limit=100,
    )

    for a in accounts:
        gl = a.get("gl_account")
        if gl:
            row = frappe.db.sql("""
                SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance
                FROM `tabGeneral Ledger Entry`
                WHERE account = %s AND is_cancelled = 0
            """, gl, as_dict=True)
            a["balance"] = flt(row[0].balance) if row else 0.0
        else:
            a["balance"] = 0.0

        # Reconciliation percentage
        total = frappe.db.count("Bank Transaction",
            {"bank_account": a["name"], "docstatus": 1})
        reconciled = frappe.db.count("Bank Transaction",
            {"bank_account": a["name"], "docstatus": 1, "status": "Reconciled"})
        a["reconcile_pct"] = round(reconciled / total * 100) if total else 0
        a["txn_count"] = total

    return accounts


@frappe.whitelist(allow_guest=False, methods=["POST"])
def bounce_cheque(payment_entry: str) -> dict:
    """
    Reverse GL entries when a cheque bounces.
    The original Payment Entry GL (DR Bank / CR Payable or DR Receivable / CR Bank)
    is unwound by creating reversing GL entries.
    """
    from zoho_books_clone.accounts.accounting_engine import reverse_voucher

    doc = frappe.get_doc("Payment Entry", payment_entry)
    if doc.docstatus != 1:
        frappe.throw(_("Payment Entry {0} is not submitted — cannot reverse.").format(payment_entry))

    reverse_voucher("Payment Entry", payment_entry)
    return {"payment_entry": payment_entry, "status": "GL Reversed"}


@frappe.whitelist(allow_guest=False, methods=["POST"])
def post_bank_transfer(
    from_account: str,
    to_account: str,
    amount: str,
    date: str = None,
    description: str = "",
) -> dict:
    """
    Transfer funds between two bank accounts.

    GL impact:
      DR  to_account.gl_account   (funds arrive)
      CR  from_account.gl_account (funds leave)

    Creates a Bank Transaction record on each account for reconciliation.
    No income/expense impact — pure asset swap.
    """
    amount_f = flt(amount)
    if amount_f <= 0:
        frappe.throw(_("Transfer amount must be positive."))
    if from_account == to_account:
        frappe.throw(_("Source and destination account must be different."))

    date = date or today()
    from_gl = _bank_gl(from_account)
    to_gl   = _bank_gl(to_account)
    company = _company(from_account)
    remark  = description or f"Transfer from {from_account} to {to_account}"

    # Bank Transaction — source account (withdrawal / debit).
    # skip_gl_posting flag: this API posts a single combined GL set below,
    # so the per-transaction _post_gl must not run (would double-post).
    bt_from = frappe.get_doc({
        "doctype": "Bank Transaction",
        "bank_account": from_account,
        "date": date,
        "description": f"Transfer to {to_account}" + (f" — {description}" if description else ""),
        "debit": amount_f,
        "credit": 0,
        "transaction_type": "Transfer",
        "status": "Reconciled",
    })
    bt_from.flags.ignore_permissions = True
    bt_from.flags.skip_gl_posting = True
    bt_from.insert()
    bt_from.submit()

    # Bank Transaction — destination account (deposit / credit)
    bt_to = frappe.get_doc({
        "doctype": "Bank Transaction",
        "bank_account": to_account,
        "date": date,
        "description": f"Transfer from {from_account}" + (f" — {description}" if description else ""),
        "debit": 0,
        "credit": amount_f,
        "transaction_type": "Transfer",
        "status": "Reconciled",
    })
    bt_to.flags.ignore_permissions = True
    bt_to.flags.skip_gl_posting = True
    bt_to.insert()
    bt_to.submit()

    # GL: DR to_gl / CR from_gl
    make_gl_entries([
        {
            "account": to_gl,
            "debit": amount_f,
            "credit": 0,
            "posting_date": date,
            "voucher_type": "Bank Transaction",
            "voucher_no": bt_from.name,
            "company": company,
            "remarks": remark,
        },
        {
            "account": from_gl,
            "debit": 0,
            "credit": amount_f,
            "posting_date": date,
            "voucher_type": "Bank Transaction",
            "voucher_no": bt_from.name,
            "company": company,
            "remarks": remark,
        },
    ])

    return {
        "from_transaction": bt_from.name,
        "to_transaction": bt_to.name,
        "amount": amount_f,
        "from_account": from_account,
        "to_account": to_account,
    }


@frappe.whitelist(allow_guest=False, methods=["POST"])
def create_bank_gl_entry(
    bank_account: str,
    bank_transaction: str,
    gl_account: str,
    amount: str,
    txn_type: str,
    date: str = None,
    description: str = "",
) -> dict:
    """
    Create a GL Journal Entry for an unmatched bank transaction, then mark
    the transaction as Reconciled.

    txn_type "Debit"  (withdrawal / charge):
      DR  gl_account   (expense)
      CR  bank_gl      (bank decreases)

    txn_type "Credit" (deposit / interest):
      DR  bank_gl      (bank increases)
      CR  gl_account   (income)
    """
    amount_f = flt(amount)
    date = date or today()
    bank_gl  = _bank_gl(bank_account)
    company  = _company(bank_account)
    remark   = description or f"Bank entry: {bank_transaction}"

    if txn_type == "Debit":
        entries = [
            {"account": gl_account, "debit": amount_f, "credit": 0},
            {"account": bank_gl,    "debit": 0,        "credit": amount_f},
        ]
    else:
        entries = [
            {"account": bank_gl,    "debit": amount_f, "credit": 0},
            {"account": gl_account, "debit": 0,        "credit": amount_f},
        ]

    for e in entries:
        e.update({
            "posting_date": date,
            "voucher_type": "Bank Transaction",
            "voucher_no": bank_transaction,
            "company": company,
            "remarks": remark,
        })

    make_gl_entries(entries)

    # Mark Bank Transaction as Reconciled
    try:
        doc = frappe.get_doc("Bank Transaction", bank_transaction)
        if doc.docstatus == 1:
            doc.status = "Reconciled"
            doc.clearance_date = date
            doc.save(ignore_permissions=True)
        frappe.db.commit()
    except Exception:
        pass

    return {
        "bank_transaction": bank_transaction,
        "gl_account": gl_account,
        "amount": amount_f,
        "txn_type": txn_type,
    }
