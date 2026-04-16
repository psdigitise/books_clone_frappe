import frappe
from frappe import _
from frappe.utils import flt, today as _today
from frappe.model.document import Document


class GeneralLedgerEntry(Document):
    pass


# ─── Public API ───────────────────────────────────────────────────────────────

def make_gl_entries(gl_map: list[dict], cancel: bool = False) -> None:
    """
    Create or reverse General Ledger Entries.

    Creation: each dict must have account, debit, credit, voucher_type,
              voucher_no, posting_date, company.
    Cancellation: pass [{"voucher_type": "...", "voucher_no": "..."}]
                  Entries are REVERSED (not deleted) to preserve audit trail.
    """
    if not cancel:
        _validate_gl_balance(gl_map)

    affected_accounts: set[str] = set()

    for entry in gl_map:
        if cancel:
            accounts = _reverse_gl_entries(
                entry.get("voucher_type"), entry.get("voucher_no")
            )
            affected_accounts.update(accounts)
        else:
            account = entry.get("account")
            if not account:
                frappe.throw(_("GL entry missing 'account' field: {0}").format(entry))
            _create_gl_entry(entry)
            affected_accounts.add(account)

    for account in affected_accounts:
        _update_account_balance(account)


def recompute_outstanding_from_gl(doctype: str, docname: str) -> float:
    """
    Compute the true outstanding amount for an invoice by comparing
    what the GL says the receivable/payable balance is for this voucher.

    Returns the outstanding amount and writes it back to the document.
    """
    # Determine which account holds the outstanding (debit_to / credit_to)
    party_account = frappe.db.get_value(
        doctype, docname,
        "debit_to" if doctype == "Sales Invoice" else "credit_to"
    )
    if not party_account:
        return 0.0

    # For Sales Invoice: AR was debited on submit; payments credit it.
    # Outstanding = net debit remaining on that account for this voucher_no.
    result = frappe.db.sql("""
        SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS outstanding
        FROM `tabGeneral Ledger Entry`
        WHERE account      = %s
          AND voucher_no   = %s
          AND is_cancelled = 0
    """, (party_account, docname), as_dict=True)

    # Also include payment entries that reference this doc
    payments = frappe.db.sql("""
        SELECT COALESCE(SUM(gle.credit) - SUM(gle.debit), 0) AS paid
        FROM `tabGeneral Ledger Entry` gle
        JOIN `tabPayment Entry Reference` per
          ON per.parent = gle.voucher_no
        WHERE gle.account      = %s
          AND per.reference_name = %s
          AND gle.is_cancelled = 0
          AND gle.voucher_type = 'Payment Entry'
    """, (party_account, docname), as_dict=True)

    invoice_debit = flt(result[0].outstanding) if result else 0.0
    payment_credit = flt(payments[0].paid) if payments else 0.0
    outstanding = max(0.0, invoice_debit - payment_credit)

    frappe.db.set_value(doctype, docname, "outstanding_amount", outstanding,
                        update_modified=False)
    return outstanding


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _validate_gl_balance(gl_map: list[dict]) -> None:
    """P0/Issue 2 — Reject unbalanced GL entry sets before posting."""
    total_debit  = sum(flt(e.get("debit",  0)) for e in gl_map)
    total_credit = sum(flt(e.get("credit", 0)) for e in gl_map)
    if abs(total_debit - total_credit) > 0.01:
        frappe.throw(_(
            "Unbalanced GL entries: total debit {0} ≠ total credit {1}. "
            "All debits must equal all credits."
        ).format(
            frappe.bold(f"₹{total_debit:,.2f}"),
            frappe.bold(f"₹{total_credit:,.2f}"),
        ))


def _reverse_gl_entries(voucher_type: str, voucher_no: str) -> set[str]:
    """
    P0/Issue 1 — Preserve audit trail by creating reversing entries
    instead of deleting the originals.
    Returns set of affected account names for balance refresh.
    """
    # Idempotency: if reversals already exist for this voucher, skip.
    already = frappe.db.sql("""
        SELECT COUNT(*) FROM `tabGeneral Ledger Entry`
        WHERE voucher_type = %s AND voucher_no = %s AND is_reversal = 1
    """, (voucher_type, voucher_no))[0][0]
    if already:
        return set()

    rows = frappe.db.sql("""
        SELECT name, account, debit, credit, party_type, party,
               cost_center, currency, company, fiscal_year, is_opening
        FROM `tabGeneral Ledger Entry`
        WHERE voucher_type = %s AND voucher_no = %s
          AND is_cancelled = 0 AND is_reversal = 0
    """, (voucher_type, voucher_no), as_dict=True)

    affected: set[str] = set()
    reversal_date = _today()

    for row in rows:
        # Mark the original entry as cancelled
        frappe.db.set_value(
            "General Ledger Entry", row.name, "is_cancelled", 1,
            update_modified=False
        )
        # Post a mirror entry with debit ↔ credit swapped
        _create_gl_entry({
            "account":      row.account,
            "debit":        flt(row.credit),   # swap
            "credit":       flt(row.debit),    # swap
            "voucher_type": voucher_type,
            "voucher_no":   voucher_no,
            "posting_date": reversal_date,
            "party_type":   row.party_type or "",
            "party":        row.party or "",
            "cost_center":  row.cost_center or "",
            "currency":     row.currency or "INR",
            "remarks":      f"Reversal of GL Entry {row.name}",
            "company":      row.company,
            "fiscal_year":  row.fiscal_year or "",
            "is_opening":   row.is_opening or 0,
            "is_reversal":  1,
        })
        affected.add(row.account)

    return affected


def _create_gl_entry(entry: dict) -> None:
    doc = frappe.new_doc("General Ledger Entry")
    doc.update(entry)
    doc.flags.ignore_permissions = True
    doc.flags.ignore_mandatory   = True
    doc.insert()


def _update_account_balance(account: str) -> None:
    """Recompute account balance from all active (non-cancelled) GL entries."""
    if not account:
        return
    res = frappe.db.sql("""
        SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance
        FROM `tabGeneral Ledger Entry`
        WHERE account = %s AND is_cancelled = 0
    """, account, as_dict=True)
    balance = flt(res[0].balance) if res else 0.0
    frappe.db.set_value("Account", account, "balance", balance,
                        update_modified=False)
