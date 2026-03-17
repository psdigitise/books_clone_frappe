"""Fix DocType module assignments corrupted by earlier migrations."""
import frappe


DOCTYPE_MODULE_MAP = {
    "Books Payment Mode": "Books Setup",
    "Books Settings":     "Books Setup",
    "Currency":           "Books Setup",
    "UOM":                "Books Setup",
    "Payment Terms":      "Books Setup",
    "Sales Invoice":      "Invoicing",
    "Purchase Invoice":   "Invoicing",
    "Sales Invoice Item": "Invoicing",
    "Purchase Invoice Item": "Invoicing",
    "Customer":           "Invoicing",
    "Supplier":           "Invoicing",
    "Item":               "Invoicing",
    "Tax Line":           "Invoicing",
    "Payment Entry":      "Payments",
    "Payment Entry Reference": "Payments",
    "Account":            "Accounts",
    "Cost Center":        "Accounts",
    "Fiscal Year":        "Accounts",
    "General Ledger Entry": "Accounts",
    "Bank Account":       "Banking",
    "Bank Transaction":   "Banking",
    "Tax Template":       "Taxes",
    "Tax Template Detail": "Taxes",
}

MODULE_APP_MAP = {
    "Books Setup": "zoho_books_clone",
    "Invoicing":   "zoho_books_clone",
    "Payments":    "zoho_books_clone",
    "Accounts":    "zoho_books_clone",
    "Banking":     "zoho_books_clone",
    "Taxes":       "zoho_books_clone",
    "Reports":     "zoho_books_clone",
}


def execute():
    # Fix Module Def app_name for all our modules
    for module, app in MODULE_APP_MAP.items():
        if frappe.db.exists("Module Def", module):
            frappe.db.set_value("Module Def", module, "app_name", app)
            print(f"  Fixed Module Def: {module} -> {app}")
        else:
            # Create the Module Def if missing
            frappe.get_doc({
                "doctype": "Module Def",
                "module_name": module,
                "app_name": app,
            }).insert(ignore_permissions=True, ignore_if_duplicate=True)
            print(f"  Created Module Def: {module} -> {app}")

    # Fix DocType module field for all our doctypes
    for doctype, module in DOCTYPE_MODULE_MAP.items():
        if frappe.db.exists("DocType", doctype):
            current = frappe.db.get_value("DocType", doctype, "module")
            if current != module:
                frappe.db.set_value("DocType", doctype, "module", module)
                print(f"  Fixed DocType module: {doctype}: {current} -> {module}")

    frappe.db.commit()
    print("✅ Module assignments fixed")
