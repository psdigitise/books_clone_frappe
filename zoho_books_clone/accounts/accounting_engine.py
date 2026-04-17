"""
Accounting Engine — P2/Issue 3
Central module that owns all GL map construction logic.

Every financial DocType calls into this module on submit/cancel instead of
building its own GL maps, ensuring a single place to audit and change posting rules.
"""
import frappe
from frappe import _
from frappe.utils import flt
from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import (
    make_gl_entries,
)


# ─── Sales Invoice ─────────────────────────────────────────────────────────────

def post_sales_invoice(doc) -> None:
    """DR Receivable / CR Income (+ tax accounts) on Sales Invoice submit."""
    _require(doc, "debit_to",      "Debit To (Accounts Receivable) account")
    _require(doc, "income_account","Income Account")

    gl_map = [
        {
            "account":      doc.debit_to,
            "debit":        flt(doc.grand_total),
            "credit":       0,
            "voucher_type": doc.doctype,
            "voucher_no":   doc.name,
            "posting_date": doc.posting_date,
            "party_type":   "Customer",
            "party":        doc.customer,
            "company":      doc.company,
            "fiscal_year":  doc.fiscal_year or "",
            "remarks":      f"Invoice {doc.name} — {doc.customer_name or doc.customer}",
        },
        {
            "account":      doc.income_account,
            "debit":        0,
            "credit":       flt(doc.net_total),
            "voucher_type": doc.doctype,
            "voucher_no":   doc.name,
            "posting_date": doc.posting_date,
            "company":      doc.company,
            "fiscal_year":  doc.fiscal_year or "",
            "remarks":      f"Income — Invoice {doc.name}",
        },
    ]
    for tax in (doc.taxes or []):
        if flt(tax.tax_amount) and tax.account_head:
            gl_map.append({
                "account":      tax.account_head,
                "debit":        0,
                "credit":       flt(tax.tax_amount),
                "voucher_type": doc.doctype,
                "voucher_no":   doc.name,
                "posting_date": doc.posting_date,
                "company":      doc.company,
                "fiscal_year":  doc.fiscal_year or "",
                "remarks":      f"{tax.description} — Invoice {doc.name}",
            })
    make_gl_entries(gl_map)


# ─── Purchase Invoice ──────────────────────────────────────────────────────────

def post_purchase_invoice(doc) -> None:
    """
    DR Expense (net_total) + DR ITC Tax Accounts / CR Payable (grand_total).

    Correctly separates:
      - Net purchase cost   → Expense account (debit = net_total)
      - Input Tax Credit    → Each tax line's account_head (debit = tax_amount)
      - Total payable       → AP account (credit = grand_total)

    This ensures GST ITC is tracked per tax type in the GL, enabling accurate
    GSTR-2A reconciliation via get_itc_ledger().
    """
    _require(doc, "credit_to",       "Credit To (Accounts Payable) account")
    _require(doc, "expense_account", "Expense Account")

    net_total   = flt(doc.net_total)
    grand_total = flt(doc.grand_total)
    total_tax   = flt(doc.total_tax) if hasattr(doc, "total_tax") else (grand_total - net_total)

    gl_map = [
        # DR Expense account for net purchase cost (excluding tax)
        {
            "account":      doc.expense_account,
            "debit":        net_total,
            "credit":       0,
            "voucher_type": doc.doctype,
            "voucher_no":   doc.name,
            "posting_date": doc.posting_date,
            "company":      doc.company,
            "fiscal_year":  doc.fiscal_year or "",
            "remarks":      f"Purchase cost (net) — Bill {doc.name}",
        },
        # CR Payable for full amount owed to supplier
        {
            "account":      doc.credit_to,
            "debit":        0,
            "credit":       grand_total,
            "voucher_type": doc.doctype,
            "voucher_no":   doc.name,
            "posting_date": doc.posting_date,
            "party_type":   "Supplier",
            "party":        doc.supplier,
            "company":      doc.company,
            "fiscal_year":  doc.fiscal_year or "",
            "remarks":      f"Payable to {doc.supplier} — Bill {doc.name}",
        },
    ]

    # DR individual ITC accounts per tax line (CGST, SGST, IGST, etc.)
    tax_lines_posted = flt(0)
    for tax in (doc.taxes or []):
        tax_amount = flt(tax.tax_amount)
        if not tax_amount:
            continue

        account = tax.account_head
        if not account:
            # No specific account — fall into the expense line (already included in net fallback)
            continue

        gl_map.append({
            "account":      account,
            "debit":        tax_amount,
            "credit":       0,
            "voucher_type": doc.doctype,
            "voucher_no":   doc.name,
            "posting_date": doc.posting_date,
            "company":      doc.company,
            "fiscal_year":  doc.fiscal_year or "",
            "remarks":      f"ITC — {tax.tax_type or tax.description or 'Tax'} — Bill {doc.name}",
        })
        tax_lines_posted += tax_amount

    # If no tax lines had account_heads, the tax was already included in the
    # expense debit via grand_total fallback. We need to adjust: swap net_total
    # debit back to grand_total so the entry remains balanced.
    if not tax_lines_posted and total_tax:
        for entry in gl_map:
            if entry["account"] == doc.expense_account:
                entry["debit"] = grand_total
                entry["remarks"] = f"Purchase cost (gross, no ITC accounts) — Bill {doc.name}"
                break

    make_gl_entries(gl_map)


# ─── Payment Entry ─────────────────────────────────────────────────────────────

def post_payment_entry(doc) -> None:
    """
    Post GL entries for a Payment Entry.
    Receive: DR Bank/Cash, CR Receivable
    Pay:     DR Payable,   CR Bank/Cash
    """
    _require(doc, "paid_from", "Paid From account")
    _require(doc, "paid_to",   "Paid To account")

    if doc.payment_type == "Receive":
        gl_map = [
            {
                "account":      doc.paid_to,       # Bank / Cash — increases
                "debit":        flt(doc.paid_amount),
                "credit":       0,
                "voucher_type": doc.doctype,
                "voucher_no":   doc.name,
                "posting_date": doc.payment_date,
                "company":      doc.company,
                "remarks":      f"Payment received — {doc.name}",
            },
            {
                "account":      doc.paid_from,     # Receivable — decreases
                "debit":        0,
                "credit":       flt(doc.paid_amount),
                "voucher_type": doc.doctype,
                "voucher_no":   doc.name,
                "posting_date": doc.payment_date,
                "party_type":   doc.party_type,
                "party":        doc.party,
                "company":      doc.company,
                "remarks":      f"Received from {doc.party} — {doc.name}",
            },
        ]
    elif doc.payment_type == "Pay":
        gl_map = [
            {
                "account":      doc.paid_to,       # Payable — decreases
                "debit":        flt(doc.paid_amount),
                "credit":       0,
                "voucher_type": doc.doctype,
                "voucher_no":   doc.name,
                "posting_date": doc.payment_date,
                "party_type":   doc.party_type,
                "party":        doc.party,
                "company":      doc.company,
                "remarks":      f"Payment to {doc.party} — {doc.name}",
            },
            {
                "account":      doc.paid_from,     # Bank / Cash — decreases
                "debit":        0,
                "credit":       flt(doc.paid_amount),
                "voucher_type": doc.doctype,
                "voucher_no":   doc.name,
                "posting_date": doc.payment_date,
                "company":      doc.company,
                "remarks":      f"Payment made — {doc.name}",
            },
        ]
    else:
        frappe.throw(_("Payment type '{0}' not supported").format(doc.payment_type))

    make_gl_entries(gl_map)


# ─── Journal Entry ─────────────────────────────────────────────────────────────

def post_journal_entry(doc) -> None:
    """Post GL entries from Journal Entry accounts child table."""
    gl_map = []
    for row in (doc.accounts or []):
        if flt(row.debit) or flt(row.credit):
            gl_map.append({
                "account":      row.account,
                "debit":        flt(row.debit),
                "credit":       flt(row.credit),
                "voucher_type": doc.doctype,
                "voucher_no":   doc.name,
                "posting_date": doc.posting_date,
                "party_type":   row.party_type or "",
                "party":        row.party or "",
                "company":      doc.company,
                "fiscal_year":  doc.fiscal_year or "",
                "remarks":      doc.remark or f"Journal Entry {doc.name}",
            })
    if not gl_map:
        frappe.throw(_("Journal Entry has no account rows with debit or credit"))
    make_gl_entries(gl_map)


# ─── Expense ───────────────────────────────────────────────────────────────────

def post_expense(doc) -> None:
    """DR Expense Account / CR Paid-Through (Bank or Cash) on Expense submit."""
    _require(doc, "expense_account", "Expense Account")
    _require(doc, "paid_through",    "Paid Through Account")

    total = flt(doc.total_amount) or flt(doc.amount)
    gl_map = [
        {
            "account":      doc.expense_account,
            "debit":        total,
            "credit":       0,
            "voucher_type": doc.doctype,
            "voucher_no":   doc.name,
            "posting_date": doc.posting_date,
            "company":      doc.company,
            "cost_center":  doc.cost_center or "",
            "remarks":      doc.description or doc.name,
        },
        {
            "account":      doc.paid_through,
            "debit":        0,
            "credit":       total,
            "voucher_type": doc.doctype,
            "voucher_no":   doc.name,
            "posting_date": doc.posting_date,
            "company":      doc.company,
            "cost_center":  doc.cost_center or "",
            "remarks":      doc.description or doc.name,
        },
    ]
    make_gl_entries(gl_map)


# ─── Expense Claim ─────────────────────────────────────────────────────────────

def post_expense_claim(doc) -> None:
    """DR Expense Account per line / CR Employee Payable on Expense Claim approval."""
    _require(doc, "payable_account", "Payable Account")

    # Resolve a default expense account for lines that don't carry one
    default_exp_acct = frappe.db.get_value(
        "Account",
        {"account_type": "Expense Account", "company": doc.company, "is_group": 0},
        "name",
    )

    gl_map = []
    for row in (doc.expenses or []):
        exp_acct = default_exp_acct
        if not exp_acct:
            frappe.throw(
                _("No Expense Account found for company {0}. "
                  "Please create one before approving.").format(doc.company)
            )
        gl_map.append({
            "account":      exp_acct,
            "debit":        flt(row.amount),
            "credit":       0,
            "voucher_type": doc.doctype,
            "voucher_no":   doc.name,
            "posting_date": row.expense_date or doc.claim_date,
            "company":      doc.company,
            "cost_center":  doc.cost_center or "",
            "remarks":      row.description or row.expense_type or "Expense Claim",
        })

    gl_map.append({
        "account":      doc.payable_account,
        "debit":        0,
        "credit":       flt(doc.total_claimed_amount),
        "voucher_type": doc.doctype,
        "voucher_no":   doc.name,
        "posting_date": doc.claim_date,
        "company":      doc.company,
        "cost_center":  doc.cost_center or "",
        "remarks":      f"Expense Claim {doc.name} — {doc.employee_name}",
    })
    make_gl_entries(gl_map)


# ─── Reversal (cancel) ─────────────────────────────────────────────────────────

def reverse_voucher(voucher_type: str, voucher_no: str) -> None:
    """Create reversing GL entries for any voucher (used on cancel)."""
    make_gl_entries(
        [{"voucher_type": voucher_type, "voucher_no": voucher_no}],
        cancel=True,
    )


# ─── Helpers ───────────────────────────────────────────────────────────────────

def _require(doc, field: str, label: str) -> None:
    if not getattr(doc, field, None):
        frappe.throw(_("Please set the '{0}' field on {1}").format(label, doc.name or "this document"))
