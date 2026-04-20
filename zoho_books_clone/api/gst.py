"""
GST & TDS Compliance API — whitelisted endpoints.

Covers:
  - pay_gst: Journal Entry for GST payment (DR Output GST / CR Bank)
  - create_tds_entry: Journal Entry for TDS deduction on vendor payment
  - save_irn: Persist e-Invoice IRN to Sales Invoice notes field
"""
import frappe
from frappe import _
from frappe.utils import flt, today
from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import (
    make_gl_entries,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _find_account(company: str, account_type: str, name_like: str = None) -> str | None:
    filters = {"account_type": account_type, "company": company, "is_group": 0}
    if name_like:
        filters["account_name"] = ["like", f"%{name_like}%"]
    return frappe.db.get_value("Account", filters, "name")


# ─── Endpoints ────────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False, methods=["POST"])
def pay_gst(
    company: str,
    cgst_amount: str = "0",
    sgst_amount: str = "0",
    igst_amount: str = "0",
    bank_account: str = None,
    challan_ref: str = "",
    period: str = "",
) -> dict:
    """
    Create GL entries for GST payment to the government.

    GL Impact:
      DR Output CGST Payable  (reduce liability)
      DR Output SGST Payable  (reduce liability)
      DR Output IGST Payable  (reduce liability)
      CR Bank GL Account      (cash outflow)
    """
    cgst  = flt(cgst_amount)
    sgst  = flt(sgst_amount)
    igst  = flt(igst_amount)
    total = cgst + sgst + igst

    if total <= 0:
        frappe.throw(_("Total GST payment amount must be positive."))

    # Resolve bank GL
    bank_gl = None
    if bank_account:
        bank_gl = frappe.db.get_value("Bank Account", bank_account, "gl_account")
    if not bank_gl:
        bank_gl = _find_account(company, "Bank") or _find_account(company, "Cash")
    if not bank_gl:
        frappe.throw(_("No bank/cash GL account found for company {0}.").format(company))

    # Resolve Output GST liability accounts
    cgst_acct = _find_account(company, "Tax", "Output CGST") or _find_account(company, "Tax", "CGST")
    sgst_acct = _find_account(company, "Tax", "Output SGST") or _find_account(company, "Tax", "SGST")
    igst_acct = _find_account(company, "Tax", "Output IGST") or _find_account(company, "Tax", "IGST")

    remark = "GST payment" + (f" — {period}" if period else "") + (f" — Challan: {challan_ref}" if challan_ref else "")

    gl_map = []
    if cgst > 0 and cgst_acct:
        gl_map.append({"account": cgst_acct, "debit": cgst, "credit": 0, "remarks": remark})
    if sgst > 0 and sgst_acct:
        gl_map.append({"account": sgst_acct, "debit": sgst, "credit": 0, "remarks": remark})
    if igst > 0 and igst_acct:
        gl_map.append({"account": igst_acct, "debit": igst, "credit": 0, "remarks": remark})

    if not gl_map:
        frappe.throw(_(
            "No Output GST accounts found. Please configure CGST / SGST / IGST "
            "accounts (account_type = Tax) in the Chart of Accounts."
        ))

    gl_map.append({"account": bank_gl, "debit": 0, "credit": total, "remarks": remark})

    posting_date = today()
    voucher_no   = challan_ref or ("GST-PAY-" + today())
    for e in gl_map:
        e.update({
            "posting_date": posting_date,
            "voucher_type": "Journal Entry",
            "voucher_no": voucher_no,
            "company": company,
        })

    make_gl_entries(gl_map)
    frappe.db.commit()

    return {
        "total": total,
        "cgst": cgst,
        "sgst": sgst,
        "igst": igst,
        "bank_gl": bank_gl,
        "challan_ref": challan_ref,
        "voucher_no": voucher_no,
    }


@frappe.whitelist(allow_guest=False, methods=["POST"])
def create_tds_entry(
    company: str,
    party: str,
    expense_account: str,
    amount: str,
    tds_amount: str,
    tds_section: str = "",
    date: str = None,
    remarks: str = "",
) -> dict:
    """
    Create GL entries for TDS deduction on a vendor payment.

    GL Impact:
      DR Expense Account    (gross amount)
      CR TDS Payable        (TDS withheld for government)
      CR Accounts Payable   (net amount due to vendor)
    """
    amount_f = flt(amount)
    tds_f    = flt(tds_amount)
    net      = round(amount_f - tds_f, 2)

    if amount_f <= 0:
        frappe.throw(_("Payment amount must be positive."))
    if tds_f < 0 or tds_f > amount_f:
        frappe.throw(_("TDS amount must be between 0 and the gross amount."))

    date = date or today()

    tds_payable = (
        _find_account(company, "Tax", "TDS Payable")
        or _find_account(company, "Payable", "TDS")
        or _find_account(company, "Tax")
    )
    ap_account = _find_account(company, "Payable")

    if not tds_payable:
        frappe.throw(_("No TDS Payable account found. Create an account named 'TDS Payable' under Liabilities."))
    if not ap_account:
        frappe.throw(_("No Accounts Payable account found for company {0}.").format(company))
    if not expense_account:
        frappe.throw(_("Expense account is required."))

    remark     = remarks or f"TDS on payment to {party} — Section {tds_section}"
    voucher_no = f"TDS-{(party or '')[:10].upper().replace(' ','-')}-{date}"

    gl_map = [
        {"account": expense_account, "debit": amount_f, "credit": 0,    "remarks": remark},
        {"account": tds_payable,     "debit": 0,        "credit": tds_f, "remarks": remark},
        {"account": ap_account,      "debit": 0,        "credit": net,   "remarks": remark},
    ]
    for e in gl_map:
        e.update({
            "posting_date": date,
            "voucher_type": "Journal Entry",
            "voucher_no": voucher_no,
            "company": company,
        })

    make_gl_entries(gl_map)
    frappe.db.commit()

    return {
        "voucher_no": voucher_no,
        "gross_amount": amount_f,
        "tds_amount": tds_f,
        "net_payable": net,
    }


@frappe.whitelist(allow_guest=False, methods=["POST"])
def save_irn(
    invoice_name: str,
    irn: str,
    ack_no: str = "",
    ack_date: str = "",
) -> dict:
    """
    Persist e-Invoice IRN to the Sales Invoice notes field.
    Appends a structured tag so IRN remains queryable from the notes text.
    """
    if not invoice_name or not irn:
        frappe.throw(_("Invoice name and IRN are required."))

    doc = frappe.get_doc("Sales Invoice", invoice_name)
    irn_tag = f"[e-Invoice] IRN:{irn} ACK:{ack_no} Date:{ack_date or today()}"

    if "[e-Invoice]" not in (doc.notes or ""):
        doc.notes = ((doc.notes or "").rstrip() + "\n" + irn_tag).lstrip("\n")
        doc.flags.ignore_permissions = True
        doc.flags.ignore_validate    = True
        doc.save()
        frappe.db.commit()

    return {"invoice_name": invoice_name, "irn": irn, "saved": True}
