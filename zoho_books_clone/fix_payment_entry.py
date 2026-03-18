# Run this with: bench --site booksnew execute zoho_books_clone.fix_payment_entry
import frappe

def execute():
    # Direct SQL fix — change the field in DB right now
    frappe.db.sql("""
        UPDATE `tabDocField`
        SET fieldtype = 'Data',
            options   = NULL
        WHERE parent    = 'Payment Entry'
          AND fieldname = 'mode_of_payment'
    """)
    frappe.db.commit()

    # Wipe all caches for Payment Entry
    frappe.clear_cache(doctype="Payment Entry")
    frappe.delete_doc_if_exists("DocType", "Books Payment Mode", ignore_permissions=True)
    frappe.db.commit()

    print("Done — mode_of_payment is now a plain Data field.")
