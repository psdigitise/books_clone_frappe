"""Seed common payment modes."""
import frappe

MODES = ["Cash", "Bank Transfer", "NEFT", "RTGS", "UPI", "Cheque", "Credit Card", "Debit Card"]


def execute():
    for mode in MODES:
        if not frappe.db.exists("Books Payment Mode", mode):
            frappe.get_doc({"doctype": "Books Payment Mode", "mode_of_payment": mode}).insert(
                ignore_permissions=True
            )
    frappe.db.commit()
    print("✅ Modes of payment seeded")
