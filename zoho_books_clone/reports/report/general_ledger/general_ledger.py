import frappe
from frappe.utils import flt


def execute(filters=None):
    filters = filters or {}
    columns = get_columns()
    data    = get_data(filters)
    return columns, data


def get_columns():
    return [
        {"label":"Date",          "fieldname":"posting_date","fieldtype":"Date",         "width":100},
        {"label":"Voucher Type",  "fieldname":"voucher_type","fieldtype":"Data",         "width":120},
        {"label":"Voucher No",    "fieldname":"voucher_no",  "fieldtype":"Dynamic Link", "width":150,
         "options":"voucher_type"},
        {"label":"Account",       "fieldname":"account",     "fieldtype":"Link",         "width":200,
         "options":"Account"},
        {"label":"Party",         "fieldname":"party",       "fieldtype":"Data",         "width":150},
        {"label":"Debit",         "fieldname":"debit",       "fieldtype":"Currency",     "width":120},
        {"label":"Credit",        "fieldname":"credit",      "fieldtype":"Currency",     "width":120},
        {"label":"Balance",       "fieldname":"balance",     "fieldtype":"Currency",     "width":120},
        {"label":"Remarks",       "fieldname":"remarks",     "fieldtype":"Data",         "width":200},
    ]


def get_data(filters: dict) -> list[dict]:
    conditions = ["docstatus = 1", "posting_date BETWEEN %(from_date)s AND %(to_date)s"]
    if filters.get("company"):    conditions.append("company = %(company)s")
    if filters.get("account"):    conditions.append("account = %(account)s")
    if filters.get("party_type"): conditions.append("party_type = %(party_type)s")
    if filters.get("party"):      conditions.append("party = %(party)s")
    if filters.get("voucher_no"): conditions.append("voucher_no = %(voucher_no)s")

    where = " AND ".join(conditions)
    rows = frappe.db.sql(f"""
        SELECT posting_date, voucher_type, voucher_no, account, party_type, party,
               debit, credit, remarks
        FROM `tabGeneral Ledger Entry`
        WHERE {where}
        ORDER BY posting_date, creation
    """, filters, as_dict=True)

    running_balance = 0
    for row in rows:
        running_balance += flt(row.debit) - flt(row.credit)
        row["balance"] = running_balance
    return rows
