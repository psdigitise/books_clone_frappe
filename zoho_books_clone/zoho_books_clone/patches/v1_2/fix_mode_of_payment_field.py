"""
Patch: Change mode_of_payment field in Payment Entry from Link(Books Payment Mode)
to a plain Data field, since Books Payment Mode DocType was not migrated.
"""
import frappe


def execute():
    # 1. Update the DocField record in the database
    frappe.db.sql("""
        UPDATE `tabDocField`
        SET fieldtype = 'Data', options = NULL
        WHERE parent = 'Payment Entry'
          AND fieldname = 'mode_of_payment'
    """)

    # 2. Reload the DocType metadata from DB cache
    frappe.clear_cache(doctype="Payment Entry")
    frappe.reload_doc("payments", "doctype", "payment_entry", force=True)

    frappe.db.commit()
    print("✓ mode_of_payment field changed to Data on Payment Entry")
