import frappe
from frappe.model.document import Document


class GeneralLedgerEntry(Document):
    pass


def make_gl_entries(gl_map: list[dict], cancel: bool = False) -> None:
    """
    Create or cancel General Ledger Entries.
    gl_map: list of dicts with keys: account, debit, credit, voucher_type,
            voucher_no, posting_date, company, [party_type, party, remarks, ...]
    """
    for entry in gl_map:
        if cancel:
            _cancel_gl_entry(entry)
        else:
            _create_gl_entry(entry)
        _update_account_balance(entry["account"])


def _create_gl_entry(entry: dict) -> None:
    doc = frappe.new_doc("General Ledger Entry")
    doc.update(entry)
    doc.flags.ignore_permissions = True
    doc.insert()


def _cancel_gl_entry(entry: dict) -> None:
    frappe.db.sql("""
        DELETE FROM `tabGeneral Ledger Entry`
        WHERE voucher_type = %s AND voucher_no = %s
    """, (entry.get("voucher_type"), entry.get("voucher_no")))


def _update_account_balance(account: str) -> None:
    res = frappe.db.sql("""
        SELECT SUM(debit) - SUM(credit) AS balance
        FROM `tabGeneral Ledger Entry`
        WHERE account = %s AND docstatus != 2
    """, account, as_dict=True)
    balance = (res[0].balance or 0) if res else 0
    frappe.db.set_value("Account", account, "balance", balance)
