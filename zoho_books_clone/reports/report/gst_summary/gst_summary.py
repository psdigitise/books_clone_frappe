import frappe
from zoho_books_clone.db.queries import get_gst_summary


def execute(filters=None):
    filters = filters or {}
    data = get_gst_summary(filters["company"], filters["from_date"], filters["to_date"])
    columns = [
        {"label": "Tax Type",      "fieldname": "tax_type",     "fieldtype": "Data",     "width": 120},
        {"label": "Invoice Count", "fieldname": "invoice_count","fieldtype": "Int",      "width": 120},
        {"label": "Total Tax",     "fieldname": "total_tax",    "fieldtype": "Currency", "width": 150},
    ]
    return columns, data
