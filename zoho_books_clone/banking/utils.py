import frappe
from frappe.utils import flt


def auto_match_bank_transactions():
    """Daily scheduler: auto-reconcile bank transactions with payment entries."""
    unmatched = frappe.get_all(
        "Bank Transaction",
        filters={"status": "Unreconciled", "docstatus": 1},
        fields=["name", "reference_number", "debit", "credit", "date"],
    )
    for txn in unmatched:
        _try_match(txn)


def _try_match(txn: dict) -> None:
    if not txn.get("reference_number"):
        return
    payment = frappe.db.get_value(
        "Payment Entry",
        {"reference_no": txn["reference_number"], "docstatus": 1},
        "name",
    )
    if payment:
        frappe.db.set_value("Bank Transaction", txn["name"], {
            "status": "Reconciled",
            "payment_entry": payment,
        })
