"""Ensure INR exists in the Currency master."""
import frappe


def execute():
    if not frappe.db.exists("Currency", "INR"):
        frappe.get_doc({
            "doctype":       "Currency",
            "currency_name": "INR",
            "symbol":        "₹",
            "fraction":      "Paise",
            "fraction_units": 100,
            "number_format": "#,##,###.##",
            "enabled":       1,
        }).insert(ignore_permissions=True)
        frappe.db.commit()
        print("✅ INR currency seeded")
    else:
        print("ℹ  INR already exists")
