import frappe
from frappe.utils import flt


@frappe.whitelist()
def get_outstanding_invoices(party_type: str, party: str) -> list[dict]:
    """Return all unpaid invoices for a party."""
    dt = "Sales Invoice" if party_type == "Customer" else "Purchase Invoice"
    party_field = "customer" if dt == "Sales Invoice" else "supplier"
    return frappe.get_all(
        dt,
        filters={party_field: party, "docstatus": 1, "outstanding_amount": [">", 0]},
        fields=["name", "grand_total", "outstanding_amount", "posting_date"],
    )


@frappe.whitelist()
def make_payment_entry_from_invoice(source_name: str, target_doc=None):
    """Create a Payment Entry from a Sales Invoice."""
    from frappe.model.mapper import get_mapped_doc
    return get_mapped_doc(
        "Sales Invoice",
        source_name,
        {
            "Sales Invoice": {
                "doctype": "Payment Entry",
                "field_map": {
                    "name":         "reference_name",
                    "customer":     "party",
                    "grand_total":  "paid_amount",
                    "company":      "company",
                    "currency":     "currency",
                },
                "validation": {"docstatus": ["=", 1]},
            }
        },
        target_doc,
    )


@frappe.whitelist()
def make_payment_entry_from_purchase_invoice(source_name: str, target_doc=None):
    """Create a Payment Entry from a Purchase Invoice."""
    from frappe.model.mapper import get_mapped_doc
    return get_mapped_doc(
        "Purchase Invoice",
        source_name,
        {
            "Purchase Invoice": {
                "doctype": "Payment Entry",
                "field_map": {
                    "name":         "reference_name",
                    "supplier":     "party",
                    "grand_total":  "paid_amount",
                    "company":      "company",
                    "currency":     "currency",
                },
                "validation": {"docstatus": ["=", 1]},
            }
        },
        target_doc,
    )
