import frappe
from zoho_books_clone.db.queries import get_cash_flow


def execute(filters=None):
    filters = filters or {}
    data = get_cash_flow(filters["company"], filters["from_date"], filters["to_date"])

    columns = [
        {"label": "Section", "fieldname": "section", "fieldtype": "Data",     "width": 300},
        {"label": "Amount",  "fieldname": "amount",  "fieldtype": "Currency", "width": 150},
    ]
    rows = [
        {"section": "Operating Activities (Net P&L)",       "amount": data["operating"]},
        {"section": "Investing Activities (Asset changes)",  "amount": data["investing"]},
        {"section": "Financing Activities (Equity/Liability)","amount": data["financing"]},
        {},
        {"section": "Net Change in Cash",                    "amount": data["net_change"]},
    ]
    return columns, rows
