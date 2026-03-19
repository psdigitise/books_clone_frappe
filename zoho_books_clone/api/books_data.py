import frappe
import json
from frappe.utils import get_url


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def get_invoice_email_defaults(invoice_name):
    """
    Return pre-filled To, Subject, and body for the Send Email dialog.
    Uses the customer's email_id and the invoice's grand_total / due_date.
    """
    inv = frappe.get_doc("Sales Invoice", invoice_name)
    customer_email = frappe.db.get_value("Customer", inv.customer, "email_id") or ""

    subject = f"Invoice {inv.name} from {inv.company or frappe.defaults.get_default('company') or ''}"

    body = (
        f"Dear {inv.customer_name or inv.customer},<br><br>"
        f"Please find your invoice <b>{inv.name}</b> details below:<br><br>"
        f"<table style='border-collapse:collapse;font-size:14px'>"
        f"<tr><td style='padding:4px 12px 4px 0;color:#666'>Invoice #</td><td><b>{inv.name}</b></td></tr>"
        f"<tr><td style='padding:4px 12px 4px 0;color:#666'>Amount</td><td><b>₹{inv.grand_total:,.2f}</b></td></tr>"
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
    """
    Send invoice email using Frappe's configured outgoing email account.
    Attaches a PDF of the invoice.
    """
    if not to:
        frappe.throw("Recipient email (To) is required.")

    # Validate invoice exists and user has permission
    if not frappe.has_permission("Sales Invoice", "read", invoice_name):
        frappe.throw("Not permitted", frappe.PermissionError)

    inv = frappe.get_doc("Sales Invoice", invoice_name)

    # Build recipient list (support comma-separated)
    recipients = [e.strip() for e in to.split(",") if e.strip()]
    cc_list = [e.strip() for e in (cc or "").split(",") if e.strip()]

    # Attach PDF of the invoice
    try:
        pdf_attachment = frappe.attach_print(
            inv.doctype,
            inv.name,
            print_format="Sales Invoice",
            print_letterhead=True,
        )
        attachments = [pdf_attachment]
    except Exception:
        # If print format not found, send without attachment
        attachments = []

    # Send using Frappe's configured email account
    frappe.sendmail(
        recipients=recipients,
        cc=cc_list,
        subject=subject,
        message=body,
        attachments=attachments,
        reference_doctype="Sales Invoice",
        reference_name=invoice_name,
        now=True,  # send immediately (not queued)
    )

    # Log a communication record so it appears in the timeline
    comm = frappe.get_doc({
        "doctype": "Communication",
        "communication_type": "Communication",
        "communication_medium": "Email",
        "sent_or_received": "Sent",
        "email_status": "Sent",
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

    return {"status": "sent", "to": to, "invoice": invoice_name}


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def save_doc(doc):
    """
    Save a document. Accepts GET so CSRF is never required.
    Called by the Books SPA instead of frappe.client.save.
    """
    if isinstance(doc, str):
        doc = json.loads(doc)

    doctype = doc.get("doctype")
    if not doctype:
        frappe.throw("doctype is required")

    # Check permission
    if not frappe.has_permission(doctype, "write"):
        frappe.throw("Not permitted", frappe.PermissionError)

    name = doc.get("name")
    if name and frappe.db.exists(doctype, name):
        # Update existing
        d = frappe.get_doc(doctype, name)
        d.update(doc)
    else:
        # Create new
        d = frappe.get_doc(doc)

    d.save(ignore_permissions=False)
    frappe.db.commit()
    return d.as_dict()


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def submit_doc(doctype, name):
    """Submit a document via GET — no CSRF needed."""
    if not frappe.has_permission(doctype, "submit"):
        frappe.throw("Not permitted", frappe.PermissionError)

    d = frappe.get_doc(doctype, name)
    d.submit()
    frappe.db.commit()
    return d.as_dict()
import frappe
import json
from frappe.utils import nowdate, flt


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def get_payment_defaults(invoice_name):
    """
    Return pre-filled data for the Record Payment dialog.
    Mirrors what Zoho Books shows when you click 'Record Payment' on an invoice.
    """
    inv = frappe.get_doc("Sales Invoice", invoice_name)

    # Get next payment number
    last_payment = frappe.db.sql("""
        SELECT MAX(CAST(reference_no AS UNSIGNED))
        FROM `tabPayment Entry`
        WHERE reference_doctype = 'Sales Invoice'
        AND reference_name = %s
    """, invoice_name)
    next_num = (last_payment[0][0] or 0) + 1

    # Balance due = grand_total - paid amount
    balance_due = flt(inv.grand_total) - flt(inv.advance_paid)

    # Get bank accounts for deposit
    bank_accounts = frappe.get_all(
        "Account",
        filters={
            "account_type": ["in", ["Bank", "Cash"]],
            "is_group": 0,
            "company": inv.company or frappe.defaults.get_default("company"),
        },
        fields=["name", "account_type"],
        order_by="account_type desc",  # Cash first
    )

    # Payment modes from fixtures
    payment_modes = frappe.get_all(
        "Mode of Payment",
        fields=["name"],
        order_by="name",
    )

    return {
        "invoice_name": inv.name,
        "customer_name": inv.customer_name or inv.customer,
        "customer": inv.customer,
        "grand_total": flt(inv.grand_total),
        "balance_due": balance_due,
        "currency": inv.currency or "INR",
        "payment_number": str(next_num),
        "payment_date": nowdate(),
        "bank_accounts": bank_accounts,
        "payment_modes": [m.name for m in payment_modes],
        "company": inv.company or frappe.defaults.get_default("company"),
    }


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def record_payment(
    invoice_name,
    amount_received,
    payment_date,
    payment_mode="Cash",
    deposit_to=None,
    bank_charges=0,
    reference_no=None,
    notes=None,
    tds_deducted=0,
    tds_amount=0,
    save_as_draft=False,
):
    """
    Create a Payment Entry against a Sales Invoice.
    Mirrors Zoho Books 'Record Payment' behavior:
      - Creates Payment Entry (linked to the invoice)
      - Optionally saves as Draft or submits immediately
    """
    if isinstance(save_as_draft, str):
        save_as_draft = save_as_draft.lower() in ("true", "1", "yes")

    amount_received = flt(amount_received)
    bank_charges = flt(bank_charges)
    tds_amount = flt(tds_amount)

    if not frappe.has_permission("Sales Invoice", "write", invoice_name):
        frappe.throw("Not permitted", frappe.PermissionError)

    inv = frappe.get_doc("Sales Invoice", invoice_name)

    company = inv.company or frappe.defaults.get_default("company")
    currency = inv.currency or "INR"

    # Resolve deposit_to account
    if not deposit_to:
        if payment_mode == "Cash":
            deposit_to = frappe.db.get_value(
                "Account",
                {"account_type": "Cash", "company": company, "is_group": 0},
                "name",
            )
        else:
            deposit_to = frappe.db.get_value(
                "Account",
                {"account_type": "Bank", "company": company, "is_group": 0},
                "name",
            )

    # Receivable account from invoice
    debtors_account = inv.debit_to or frappe.db.get_value(
        "Company", company, "default_receivable_account"
    )

    # Build Payment Entry
    pe = frappe.new_doc("Payment Entry")
    pe.payment_type = "Receive"
    pe.company = company
    pe.posting_date = payment_date
    pe.mode_of_payment = payment_mode
    pe.party_type = "Customer"
    pe.party = inv.customer
    pe.party_name = inv.customer_name or inv.customer
    pe.paid_from = debtors_account
    pe.paid_to = deposit_to
    pe.paid_amount = amount_received
    pe.received_amount = amount_received
    pe.source_exchange_rate = 1
    pe.target_exchange_rate = 1
    pe.paid_from_account_currency = currency
    pe.paid_to_account_currency = currency
    pe.reference_no = reference_no or pe.name
    pe.reference_date = payment_date
    pe.remarks = notes or f"Payment against {invoice_name}"

    # Link to invoice
    pe.append("references", {
        "reference_doctype": "Sales Invoice",
        "reference_name": invoice_name,
        "due_date": inv.due_date,
        "bill_no": inv.po_no or "",
        "bill_date": inv.po_date or None,
        "total_amount": flt(inv.grand_total),
        "outstanding_amount": flt(inv.outstanding_amount),
        "allocated_amount": amount_received,
    })

    # Bank charges deduction
    if bank_charges > 0:
        bank_charges_account = frappe.db.get_value(
            "Account",
            {"account_type": "Bank", "company": company, "is_group": 0},
            "name",
        )
        pe.append("deductions", {
            "account": bank_charges_account or debtors_account,
            "cost_center": frappe.db.get_value("Company", company, "cost_center"),
            "amount": bank_charges,
        })

    pe.insert(ignore_permissions=False)

    if not save_as_draft:
        pe.submit()

    frappe.db.commit()

    return {
        "status": "draft" if save_as_draft else "submitted",
        "payment_entry": pe.name,
        "invoice": invoice_name,
        "amount": amount_received,
    }
