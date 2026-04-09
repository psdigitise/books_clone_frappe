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
        "from_email": frappe.session.user,
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
    Save (create or update) a document.
    Called by the Books SPA via POST so large payloads don't hit URL limits.
    """
    if isinstance(doc, str):
        doc = json.loads(doc)

    doctype = doc.get("doctype")
    if not doctype:
        frappe.throw("doctype is required")

    if not frappe.has_permission(doctype, "write"):
        frappe.throw("Not permitted", frappe.PermissionError)

    # Strip stale child-row identity fields so Frappe replaces rows cleanly
    # instead of trying to look up rows by old hash names that may no longer exist.
    _CHILD_META_KEYS = ("name", "parent", "parenttype", "parentfield", "owner",
                        "creation", "modified", "modified_by")
    for key, val in doc.items():
        if isinstance(val, list):
            for row in val:
                if isinstance(row, dict):
                    for mk in _CHILD_META_KEYS:
                        row.pop(mk, None)

    name = doc.get("name")
    if name and frappe.db.exists(doctype, name):
        d = frappe.get_doc(doctype, name)
        is_submitted = d.docstatus == 1
        d.update(doc)
        if is_submitted:
            # Submitted documents are normally immutable in Frappe.
            # This flag bypasses field-level and child-row validation so the
            # Books SPA can freely edit any invoice regardless of status.
            # child rows added via d.update() have no DB name yet, so
            # validate_update_after_submit would throw DoesNotExistError on them.
            d.flags.ignore_validate_update_after_submit = True
    else:
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

@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def delete_doc(doctype, name):
    """Delete a document via GET — no CSRF needed."""
    if not frappe.has_permission(doctype, "delete"):
        frappe.throw("Not permitted", frappe.PermissionError)
        
    frappe.delete_doc(doctype, name, ignore_permissions=False)
    frappe.db.commit()
    return {"message": "deleted"}

@frappe.whitelist(allow_guest=True)
def get_accounts():
    """Safely fetch accounts filtered by company, bypassing REST get_list overrides."""
    company = frappe.form_dict.get("company") or ""

    # Resolve company from Books Settings when not supplied by caller
    if not company:
        try:
            company = frappe.db.get_single_value("Books Settings", "default_company") or ""
        except Exception:
            pass

    def get_list_by_type(account_type=None, scope_company=None):
        """Return leaf accounts matching the given type.

        scope_company controls company filtering:
          - truthy str  → filter by that company
          - ""          → no company filter (global fallback)
          - None        → use the outer `company` variable
        """
        effective = company if scope_company is None else scope_company
        f = {"is_group": 0, "disabled": 0}
        if effective:
            f["company"] = effective
        if account_type:
            f["account_type"] = account_type
        try:
            return [
                {"name": a.name, "account_type": a.account_type}
                for a in frappe.get_all("Account", filters=f, fields=["name", "account_type"])
            ]
        except Exception:
            return []

    # Primary query — scoped to the resolved company
    res = {
        "ar":     get_list_by_type(account_type="Receivable"),
        "income": get_list_by_type(account_type="Income"),
        "bank":   get_list_by_type(account_type=["in", ["Bank", "Cash"]]),
        "ap":     get_list_by_type(account_type="Payable"),
    }

    # Fallback 1: category empty → try all accounts for the same company (no type filter)
    all_accs = None
    for key in res:
        if not res[key]:
            if all_accs is None:
                all_accs = get_list_by_type()
            res[key] = all_accs

    # Fallback 2: if the company itself had no accounts (stale/wrong company name),
    # retry the entire query without any company filter so the UI is never blank.
    if not any(res.values()):
        res = {
            "ar":     get_list_by_type(account_type="Receivable", scope_company=""),
            "income": get_list_by_type(account_type="Income",      scope_company=""),
            "bank":   get_list_by_type(account_type=["in", ["Bank", "Cash"]], scope_company=""),
            "ap":     get_list_by_type(account_type="Payable",     scope_company=""),
        }
        all_global = None
        for key in res:
            if not res[key]:
                if all_global is None:
                    all_global = get_list_by_type(scope_company="")
                res[key] = all_global

    return res
