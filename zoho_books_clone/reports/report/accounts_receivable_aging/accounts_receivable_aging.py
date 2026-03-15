import frappe
from frappe.utils import flt, getdate, date_diff


def execute(filters=None):
    filters = filters or {}
    return get_columns(), get_data(filters)


def get_columns():
    return [
        {"label":"Customer",    "fieldname":"customer",     "fieldtype":"Link","options":"Customer","width":200},
        {"label":"Invoice",     "fieldname":"name",         "fieldtype":"Link","options":"Sales Invoice","width":150},
        {"label":"Date",        "fieldname":"posting_date", "fieldtype":"Date","width":100},
        {"label":"Due Date",    "fieldname":"due_date",     "fieldtype":"Date","width":100},
        {"label":"Outstanding", "fieldname":"outstanding",  "fieldtype":"Currency","width":120},
        {"label":"0-30 days",   "fieldname":"bucket_0_30",  "fieldtype":"Currency","width":120},
        {"label":"31-60 days",  "fieldname":"bucket_31_60", "fieldtype":"Currency","width":120},
        {"label":"61-90 days",  "fieldname":"bucket_61_90", "fieldtype":"Currency","width":120},
        {"label":"90+ days",    "fieldname":"bucket_90plus","fieldtype":"Currency","width":120},
    ]


def get_data(filters: dict) -> list[dict]:
    invoices = frappe.get_all(
        "Sales Invoice",
        filters={"docstatus":1,"outstanding_amount":[">",0],"company":filters.get("company")},
        fields=["name","customer","posting_date","due_date","outstanding_amount"],
    )
    as_of = getdate(filters.get("as_of_date"))
    data = []
    for inv in invoices:
        days = date_diff(as_of, getdate(inv.due_date))
        amt  = flt(inv.outstanding_amount)
        row = {
            "customer":     inv.customer,
            "name":         inv.name,
            "posting_date": inv.posting_date,
            "due_date":     inv.due_date,
            "outstanding":  amt,
            "bucket_0_30":  amt if 0 <= days <= 30  else 0,
            "bucket_31_60": amt if 31 <= days <= 60 else 0,
            "bucket_61_90": amt if 61 <= days <= 90 else 0,
            "bucket_90plus":amt if days > 90         else 0,
        }
        data.append(row)
    return data
