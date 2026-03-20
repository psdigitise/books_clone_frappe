import frappe
import json
from frappe.utils import get_url, nowdate, flt


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def get_invoice_email_defaults(invoice_name):
    inv = frappe.get_doc("Sales Invoice", invoice_name)
    customer_email = frappe.db.get_value("Customer", inv.customer, "email_id") or ""
    subject = f"Invoice {inv.name} from {inv.company or frappe.defaults.get_default('company') or ''}"
    body = (
        f"Dear {inv.customer_name or inv.customer},<br><br>"
        f"Please find your invoice <b>{inv.name}</b> details below:<br><br>"
        f"<table style='border-collapse:collapse;font-size:14px'>"
        f"<tr><td style='padding:4px 12px 4px 0;color:#666'>Invoice #</td><td><b>{inv.name}</b></td></tr>"
        f"<tr><td style='padding:4px 12px 4px 0;color:#666'>Amount</td><td><b>Rs.{inv.grand_total:,.2f}</b></td></tr>"
        f"<tr><td style='padding:4px 12px 4px 0;color:#666'>Due Date</td><td>{inv.due_date}</td></tr>"
        f"</table><br>"
        f"Kindly make the payment by the due date.<br><br>"
        f"Thanks for your business.<br><br>"
        f"Regards,<br>{inv.company or ''}"
    )
    return {
        "to": customer_email,
        "subject": subject,
        "body": body,
        "invoice_name": inv.name,
        "customer_name": inv.customer_name or inv.customer,
    }


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def send_invoice_email(invoice_name, to, subject, body, cc=None):
    if not to:
        frappe.throw("Recipient email (To) is required.")
    if not frappe.has_permission("Sales Invoice", "read", invoice_name):
        frappe.throw("Not permitted", frappe.PermissionError)

    inv = frappe.get_doc("Sales Invoice", invoice_name)
    recipients = [e.strip() for e in to.split(",") if e.strip()]
    cc_list = [e.strip() for e in (cc or "").split(",") if e.strip()]

    # Try attaching PDF — silently skip if print format not found
    attachments = []
    try:
        pdf_attachment = frappe.attach_print(
            inv.doctype, inv.name,
            print_format="Sales Invoice",
            print_letterhead=False,
        )
        if pdf_attachment:
            attachments = [pdf_attachment]
    except Exception:
        pass

    frappe.sendmail(
        recipients=recipients,
        cc=cc_list,
        subject=subject,
        message=body,
        attachments=attachments,
        reference_doctype="Sales Invoice",
        reference_name=invoice_name,
        now=True,
    )

    # Log communication — "email_status" field does NOT exist in this Frappe version,
    # use only valid fields: sent_or_received, status
    try:
        comm = frappe.get_doc({
            "doctype": "Communication",
            "communication_type": "Communication",
            "communication_medium": "Email",
            "sent_or_received": "Sent",
            "subject": subject,
            "content": body,
            "sender": frappe.session.user,
            "recipients": to,
            "cc": cc or "",
            "reference_doctype": "Sales Invoice",
            "reference_name": invoice_name,
            "status": "Linked",
        })
        comm.insert(ignore_permissions=True)
        frappe.db.commit()
    except Exception:
        # Communication log is non-critical — don't fail the send
        frappe.db.commit()

    return {"status": "sent", "to": to, "invoice": invoice_name}


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def save_doc(doc):
    if isinstance(doc, str):
        doc = json.loads(doc)
    doctype = doc.get("doctype")
    if not doctype:
        frappe.throw("doctype is required")
    if not frappe.has_permission(doctype, "write"):
        frappe.throw("Not permitted", frappe.PermissionError)
    name = doc.get("name")
    if name and frappe.db.exists(doctype, name):
        d = frappe.get_doc(doctype, name)
        d.update(doc)
    else:
        d = frappe.get_doc(doc)
    d.save(ignore_permissions=False)
    frappe.db.commit()
    return d.as_dict()


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def submit_doc(doctype, name):
    if not frappe.has_permission(doctype, "submit"):
        frappe.throw("Not permitted", frappe.PermissionError)
    d = frappe.get_doc(doctype, name)
    d.submit()
    frappe.db.commit()
    return d.as_dict()


# ─── Record Payment ───────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def get_payment_defaults(invoice_name):
    inv = frappe.get_doc("Sales Invoice", invoice_name)
    last_payment = frappe.db.sql(
        "SELECT COUNT(*) FROM `tabPayment Entry Reference` WHERE reference_name = %s",
        invoice_name
    )
    next_num = (last_payment[0][0] or 0) + 1
    outstanding = flt(getattr(inv, "outstanding_amount", None))
    if not outstanding:
        outstanding = flt(inv.grand_total) - flt(inv.advance_paid)
    company = inv.company or frappe.defaults.get_default("company")
    bank_accounts = frappe.get_all(
        "Account",
        filters={"account_type": ["in", ["Bank", "Cash"]], "is_group": 0, "company": company},
        fields=["name", "account_type"],
        order_by="account_type desc",
    )
    payment_modes = frappe.get_all("Mode of Payment", fields=["name"], order_by="name")
    return {
        "invoice_name": inv.name,
        "customer_name": inv.customer_name or inv.customer,
        "customer": inv.customer,
        "grand_total": flt(inv.grand_total),
        "balance_due": outstanding,
        "currency": inv.currency or "INR",
        "payment_number": str(next_num),
        "payment_date": nowdate(),
        "bank_accounts": bank_accounts,
        "payment_modes": [m.name for m in payment_modes],
        "company": company,
    }


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def record_payment(
    invoice_name, amount_received, payment_date,
    payment_mode="Cash", deposit_to=None, bank_charges=0,
    reference_no=None, notes=None, tds_deducted=0, tds_amount=0, save_as_draft=False,
):
    if isinstance(save_as_draft, str):
        save_as_draft = save_as_draft.lower() in ("true", "1", "yes")

    amount_received = flt(amount_received)
    bank_charges    = flt(bank_charges)
    tds_amount      = flt(tds_amount)

    if not amount_received:
        frappe.throw("Amount Received is required and must be greater than 0.")
    if not frappe.has_permission("Sales Invoice", "write", invoice_name):
        frappe.throw("Not permitted", frappe.PermissionError)

    inv      = frappe.get_doc("Sales Invoice", invoice_name)
    company  = inv.company or frappe.defaults.get_default("company")
    currency = inv.currency or "INR"

    if not deposit_to:
        acct_type = "Cash" if payment_mode == "Cash" else "Bank"
        deposit_to = frappe.db.get_value(
            "Account", {"account_type": acct_type, "company": company, "is_group": 0}, "name"
        )
    if not deposit_to:
        frappe.throw("Could not find a Cash/Bank account. Please set one up under Accounts.")

    debtors_account = (
        getattr(inv, "debit_to", None)
        or frappe.db.get_value("Company", company, "default_receivable_account")
    )
    outstanding_amount = flt(getattr(inv, "outstanding_amount", None)) or (
        flt(inv.grand_total) - flt(inv.advance_paid)
    )

    pe = frappe.new_doc("Payment Entry")
    pe.payment_type               = "Receive"
    pe.company                    = company
    pe.posting_date               = payment_date
    pe.mode_of_payment            = payment_mode
    pe.party_type                 = "Customer"
    pe.party                      = inv.customer
    pe.party_name                 = inv.customer_name or inv.customer
    pe.paid_from                  = debtors_account
    pe.paid_to                    = deposit_to
    pe.paid_amount                = amount_received
    pe.received_amount            = amount_received
    pe.source_exchange_rate       = 1
    pe.target_exchange_rate       = 1
    pe.paid_from_account_currency = currency
    pe.paid_to_account_currency   = currency
    pe.reference_no               = reference_no or f"PMT-{invoice_name}"
    pe.reference_date             = payment_date
    pe.remarks                    = notes or f"Payment against {invoice_name}"

    pe.append("references", {
        "reference_doctype":  "Sales Invoice",
        "reference_name":     invoice_name,
        "due_date":           inv.due_date,
        "total_amount":       flt(inv.grand_total),
        "outstanding_amount": outstanding_amount,
        "allocated_amount":   amount_received,
    })

    if bank_charges > 0:
        charges_account = frappe.db.get_value(
            "Account", {"account_type": "Bank", "company": company, "is_group": 0}, "name"
        ) or debtors_account
        pe.append("deductions", {
            "account":     charges_account,
            "cost_center": frappe.db.get_value("Company", company, "cost_center"),
            "amount":      bank_charges,
        })

    pe.insert(ignore_permissions=False)
    if not save_as_draft:
        pe.submit()
    frappe.db.commit()

    return {
        "status":        "draft" if save_as_draft else "submitted",
        "payment_entry": pe.name,
        "invoice":       invoice_name,
        "amount":        amount_received,
    }
