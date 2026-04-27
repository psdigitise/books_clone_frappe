import frappe
from frappe.utils import flt


def execute(filters=None):
    filters = filters or {}
    columns = get_columns()
    data    = get_data(filters)
    return columns, data


def get_columns():
    return [
        {"label":"Account",  "fieldname":"account", "fieldtype":"Link","options":"Account","width":250},
        {"label":"Type",     "fieldname":"type",    "fieldtype":"Data","width":100},
        {"label":"Amount",   "fieldname":"amount",  "fieldtype":"Currency","width":150},
    ]


def get_data(filters: dict) -> list[dict]:
    rows = frappe.db.sql("""
        SELECT g.account, a.account_type,
               SUM(g.credit) - SUM(g.debit) AS amount
        FROM `tabGeneral Ledger Entry` g
        JOIN `tabAccount` a ON a.name = g.account
        WHERE IFNULL(g.is_cancelled, 0) = 0
          AND g.posting_date BETWEEN %(from_date)s AND %(to_date)s
          AND g.company = %(company)s
          AND a.account_type IN ("Income","Expense")
        GROUP BY g.account
        ORDER BY a.account_type, g.account
    """, filters, as_dict=True)

    # Income accounts naturally have credit balances (credit - debit > 0).
    # Expense accounts naturally have debit balances, so credit - debit comes
    # out negative — flip the sign so expenses read as positive in the report.
    for r in rows:
        if r.account_type == "Expense":
            r.amount = flt(r.amount) * -1

    income  = [r for r in rows if r.account_type == "Income"]
    expense = [r for r in rows if r.account_type == "Expense"]

    total_income  = sum(flt(r.amount) for r in income)
    total_expense = sum(flt(r.amount) for r in expense)
    net_profit    = total_income - total_expense

    data = []
    data.append({"account":"── INCOME ──","type":"","amount":None})
    data.extend({"account":r.account,"type":"Income","amount":r.amount} for r in income)
    data.append({"account":"Total Income","type":"","amount":total_income})
    data.append({})
    data.append({"account":"── EXPENSES ──","type":"","amount":None})
    data.extend({"account":r.account,"type":"Expense","amount":r.amount} for r in expense)
    data.append({"account":"Total Expenses","type":"","amount":total_expense})
    data.append({})
    data.append({"account":"Net Profit / Loss","type":"","amount":net_profit})
    return data
