import frappe
from frappe.utils import flt


def execute(filters=None):
    filters = filters or {}
    return get_columns(), get_data(filters)


def get_columns():
    return [
        {"label":"Account",    "fieldname":"account","fieldtype":"Link","options":"Account","width":250},
        {"label":"Type",       "fieldname":"type",   "fieldtype":"Data","width":120},
        {"label":"Balance",    "fieldname":"balance","fieldtype":"Currency","width":150},
    ]


def get_data(filters: dict) -> list[dict]:
    rows = frappe.db.sql("""
        SELECT g.account, a.account_type,
               SUM(g.debit) - SUM(g.credit) AS balance
        FROM `tabGeneral Ledger Entry` g
        JOIN `tabAccount` a ON a.name = g.account
        WHERE g.docstatus = 1
          AND g.posting_date <= %(as_of_date)s
          AND g.company = %(company)s
          AND a.account_type IN ("Asset","Liability","Equity")
        GROUP BY g.account
        ORDER BY a.account_type, g.account
    """, filters, as_dict=True)

    def section(label, types):
        items = [r for r in rows if r.account_type in types]
        total = sum(flt(r.balance) for r in items)
        out = [{"account": f"── {label} ──", "type": "", "balance": None}]
        out.extend({"account":r.account,"type":r.account_type,"balance":r.balance} for r in items)
        out.append({"account":f"Total {label}","type":"","balance":total})
        return out, total

    assets,    ta = section("ASSETS",      ["Asset"])
    liabilities,tl = section("LIABILITIES",["Liability"])
    equity,    te = section("EQUITY",      ["Equity"])

    data = assets + [{}] + liabilities + [{}] + equity
    data.append({})
    data.append({"account":"Total Liabilities + Equity","type":"","balance":tl + te})
    return data
