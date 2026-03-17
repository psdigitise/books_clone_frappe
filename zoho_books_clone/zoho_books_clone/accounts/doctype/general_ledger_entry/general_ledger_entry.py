import frappe
from frappe.model.document import Document


class GeneralLedgerEntry(Document):
    pass


def make_gl_entries(gl_map: list[dict], cancel: bool = False) -> None:
    """
    Create or cancel General Ledger Entries.

    For creation, each dict must have:
        account, debit, credit, voucher_type, voucher_no,
        posting_date, company
    For cancellation, pass:
        [{"voucher_type": "...", "voucher_no": "..."}]
    """
    affected_accounts = set()

    for entry in gl_map:
        if cancel:
            _cancel_gl_entries(entry.get("voucher_type"), entry.get("voucher_no"))
            # Collect accounts that were affected so we can refresh balances
            rows = frappe.db.sql("""
                SELECT DISTINCT account FROM `tabGeneral Ledger Entry`
                WHERE voucher_type = %s AND voucher_no = %s
            """, (entry.get("voucher_type"), entry.get("voucher_no")))
            for row in rows:
                if row[0]:
                    affected_accounts.add(row[0])
        else:
            account = entry.get("account")
            if not account:
                frappe.throw(f"GL entry missing 'account' field: {entry}")
            _create_gl_entry(entry)
            affected_accounts.add(account)

    for account in affected_accounts:
        _update_account_balance(account)


def _create_gl_entry(entry: dict) -> None:
    doc = frappe.new_doc("General Ledger Entry")
    doc.update(entry)
    doc.flags.ignore_permissions = True
    doc.flags.ignore_mandatory = True
    doc.insert()


def _cancel_gl_entries(voucher_type: str, voucher_no: str) -> None:
    frappe.db.sql("""
        DELETE FROM `tabGeneral Ledger Entry`
        WHERE voucher_type = %s AND voucher_no = %s
    """, (voucher_type, voucher_no))


def _update_account_balance(account: str) -> None:
    if not account:
        return
    res = frappe.db.sql("""
        SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance
        FROM `tabGeneral Ledger Entry`
        WHERE account = %s AND docstatus != 2
    """, account, as_dict=True)
    balance = (res[0].balance or 0) if res else 0
    frappe.db.set_value("Account", account, "balance", balance, update_modified=False)
