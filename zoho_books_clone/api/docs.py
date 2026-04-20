import frappe
import json
from frappe.utils import flt, today


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
        d.save(ignore_permissions=False)
    else:
        # New document: must call insert() explicitly.
        # frappe.get_doc(dict) with name already set does NOT mark the doc as
        # new (is_new() returns False), so save() would call db_update() and
        # raise DoesNotExistError.  insert() always creates a new row.
        d = frappe.get_doc(doc)
        d.insert(ignore_permissions=False)
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

@frappe.whitelist(allow_guest=False)
def get_party_last_items(party_type, party, limit=10):
    """
    Return the items from the most recent submitted document for a customer or vendor.
    party_type: "Customer" → searches Sales Invoice then Quotation
    party_type: "Supplier" → searches Purchase Invoice then Purchase Order
    Returns list of {item_name, item_code, description, qty, rate} dicts.
    """
    limit = int(limit)

    if party_type == "Customer":
        # Try Sales Invoice first, then Quotation
        for doctype, item_doctype, party_field in [
            ("Sales Invoice", "Sales Invoice Item", "customer"),
            ("Quotation",     "Quotation Item",     "customer"),
            ("Sales Order",   "Sales Order Item",   "customer"),
        ]:
            row = frappe.db.sql("""
                SELECT name FROM `tab{dt}`
                WHERE `{pf}` = %(party)s AND docstatus = 1
                ORDER BY modified DESC LIMIT 1
            """.format(dt=doctype, pf=party_field), {"party": party}, as_dict=True)
            if not row:
                row = frappe.db.sql("""
                    SELECT name FROM `tab{dt}`
                    WHERE `{pf}` = %(party)s
                    ORDER BY modified DESC LIMIT 1
                """.format(dt=doctype, pf=party_field), {"party": party}, as_dict=True)
            if row:
                items = frappe.db.sql("""
                    SELECT item_name, item_code, description, qty, rate
                    FROM `tab{idt}`
                    WHERE parent = %(parent)s
                    ORDER BY idx ASC LIMIT %(limit)s
                """.format(idt=item_doctype), {"parent": row[0].name, "limit": limit}, as_dict=True)
                if items:
                    return {"source": row[0].name, "source_doctype": doctype, "items": items}

    elif party_type == "Supplier":
        for doctype, item_doctype, party_field in [
            ("Purchase Invoice", "Purchase Invoice Item", "supplier"),
            ("Purchase Order",   "Purchase Order Item",   "supplier"),
        ]:
            row = frappe.db.sql("""
                SELECT name FROM `tab{dt}`
                WHERE `{pf}` = %(party)s AND docstatus = 1
                ORDER BY modified DESC LIMIT 1
            """.format(dt=doctype, pf=party_field), {"party": party}, as_dict=True)
            if not row:
                row = frappe.db.sql("""
                    SELECT name FROM `tab{dt}`
                    WHERE `{pf}` = %(party)s
                    ORDER BY modified DESC LIMIT 1
                """.format(dt=doctype, pf=party_field), {"party": party}, as_dict=True)
            if row:
                items = frappe.db.sql("""
                    SELECT item_name, item_code, description, qty, rate
                    FROM `tab{idt}`
                    WHERE parent = %(parent)s
                    ORDER BY idx ASC LIMIT %(limit)s
                """.format(idt=item_doctype), {"parent": row[0].name, "limit": limit}, as_dict=True)
                if items:
                    return {"source": row[0].name, "source_doctype": doctype, "items": items}

    return {"source": None, "items": []}


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def create_debit_note():
    """
    Create and submit a Debit Note (Purchase Invoice with is_return=1).
    Posts correct GL: DR Accounts Payable / CR Expense (or Inventory if goods returned).
    If reason is 'Goods Returned' and a warehouse is given, also creates a
    Material Issue Stock Entry to physically reduce inventory.
    Reads all params from frappe.form_dict to handle nested items JSON.
    """
    fd = frappe.form_dict
    vendor       = fd.get("vendor") or ""
    against_bill = fd.get("against_bill") or None
    date         = fd.get("date") or today()
    reason       = fd.get("reason") or ""
    notes        = fd.get("notes") or ""
    warehouse    = fd.get("warehouse") or ""
    items_raw    = fd.get("items") or "[]"

    if isinstance(items_raw, str):
        items_raw = json.loads(items_raw)

    if not vendor:
        frappe.throw("Vendor is required")
    if not reason:
        frappe.throw("Reason is required")
    if not items_raw:
        frappe.throw("At least one item is required")

    company = (
        frappe.db.get_single_value("Books Settings", "default_company")
        or frappe.defaults.get_default("company") or ""
    )

    ap_account = frappe.db.get_value(
        "Account", {"account_type": "Payable", "company": company, "is_group": 0}, "name"
    )
    expense_account = frappe.db.get_value(
        "Account", {"account_type": "Expense", "company": company, "is_group": 0}, "name"
    )

    pi_items = [
        {
            "item_code":   it.get("item_name") or it.get("item_code") or "",
            "item_name":   it.get("item_name") or "",
            "description": it.get("description") or "",
            "qty":         flt(it.get("qty", 1)),
            "rate":        flt(it.get("rate", 0)),
            "amount":      flt(it.get("amount", 0)),
        }
        for it in items_raw if (it.get("item_name") or it.get("item_code"))
    ]

    pi = frappe.get_doc({
        "doctype":        "Purchase Invoice",
        "is_return":      1,
        "company":        company,
        "supplier":       vendor,
        "return_against": against_bill,
        "posting_date":   date,
        "remark":         reason,
        "credit_to":      ap_account,
        "expense_account": expense_account,
        "items":          pi_items,
    })
    pi.name = "DN-" + frappe.generate_hash(
        txt=f"{vendor}{frappe.utils.now()}", length=8
    ).upper()
    pi.flags.ignore_permissions = True
    pi.flags.ignore_links = True
    pi.flags.ignore_mandatory = True
    pi.insert()
    pi.submit()
    frappe.db.commit()

    # If goods physically returned, create a Material Issue to remove from stock
    se_name = None
    if reason == "Goods Returned" and warehouse:
        se_items = [
            {
                "item_code":   it.get("item_name") or it.get("item_code") or "",
                "item_name":   it.get("item_name") or "",
                "qty":         flt(it.get("qty", 1)),
                "basic_rate":  flt(it.get("rate", 0)),
                "s_warehouse": warehouse,
            }
            for it in items_raw if (it.get("item_name") or it.get("item_code"))
        ]
        if se_items:
            try:
                se = frappe.get_doc({
                    "doctype":          "Stock Entry",
                    "stock_entry_type": "Material Issue",
                    "posting_date":     date,
                    "company":          company,
                    "from_warehouse":   warehouse,
                    "remarks":          f"Goods returned to vendor — Debit Note {pi.name}",
                    "items":            se_items,
                })
                se.name = "SE-DN-" + frappe.generate_hash(
                    txt=f"{pi.name}{frappe.utils.now()}", length=8
                ).upper()
                se.flags.ignore_permissions = True
                se.flags.ignore_links = True
                se.flags.ignore_mandatory = True
                se.insert()
                se.submit()
                frappe.db.commit()
                se_name = se.name
            except Exception as exc:
                frappe.log_error(
                    f"Debit Note {pi.name}: Stock Entry failed — {exc}",
                    "Debit Note Stock Movement"
                )
                frappe.msgprint(
                    f"Debit Note issued, but stock movement failed: {exc}",
                    indicator="orange", alert=True
                )

    return {
        "debit_note":  pi.name,
        "stock_entry": se_name,
        "return_type": "inventory" if reason == "Goods Returned" else "expense",
    }


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def create_credit_note():
    """
    Create and submit a Credit Note.
    Posts correct GL via CreditNote.on_submit(): DR Income / CR AR.
    If reason is 'Goods Returned' and a warehouse is given, also creates a
    Material Receipt Stock Entry to bring goods back into stock.
    """
    fd = frappe.form_dict
    customer    = fd.get("customer") or ""
    against_inv = fd.get("against_invoice") or None
    date        = fd.get("date") or today()
    reason      = fd.get("reason") or ""
    notes       = fd.get("notes") or ""
    warehouse   = fd.get("warehouse") or ""
    items_raw   = json.loads(fd.get("items") or "[]")
    taxes_raw   = json.loads(fd.get("taxes") or "[]")

    if not customer:
        frappe.throw("Customer is required")
    if not items_raw:
        frappe.throw("At least one item is required")

    company = (
        frappe.db.get_single_value("Books Settings", "default_company")
        or frappe.defaults.get_default("company") or ""
    )

    ar_account = frappe.db.get_value(
        "Account", {"account_type": "Receivable", "company": company, "is_group": 0}, "name"
    )
    income_account = frappe.db.get_value(
        "Account", {"account_type": "Income", "company": company, "is_group": 0}, "name"
    )

    cn_items = [
        {
            "item_code":   it.get("item_name") or it.get("item_code") or "",
            "item_name":   it.get("item_name") or "",
            "description": it.get("description") or "",
            "qty":         flt(it.get("qty", 1)),
            "rate":        flt(it.get("rate", 0)),
            "amount":      flt(it.get("amount", 0)),
        }
        for it in items_raw if (it.get("item_name") or it.get("item_code"))
    ]

    cn_taxes = [
        {
            "charge_type":  "On Net Total",
            "description":  t.get("description") or t.get("tax_type") or "Tax",
            "account_head": t.get("tax_type") or "",
            "rate":         flt(t.get("rate", 0)),
        }
        for t in taxes_raw
    ]

    cn = frappe.get_doc({
        "doctype":        "Credit Note",
        "company":        company,
        "customer":       customer,
        "return_against": against_inv,
        "posting_date":   date,
        "reason":         (reason + (" — " + notes if notes else "")),
        "debit_to":       ar_account,
        "income_account": income_account,
        "items":          cn_items,
        "taxes":          cn_taxes,
    })
    cn.name = "CN-" + frappe.generate_hash(
        txt=f"{customer}{frappe.utils.now()}", length=8
    ).upper()
    cn.flags.ignore_permissions = True
    cn.flags.ignore_links = True
    cn.flags.ignore_mandatory = True
    cn.insert()
    cn.submit()
    frappe.db.commit()

    # If goods returned by customer, create Material Receipt to restock
    se_name = None
    if reason == "Goods Returned" and warehouse:
        se_items = [
            {
                "item_code":   it.get("item_name") or it.get("item_code") or "",
                "item_name":   it.get("item_name") or "",
                "qty":         flt(it.get("qty", 1)),
                "basic_rate":  flt(it.get("rate", 0)),
                "t_warehouse": warehouse,
            }
            for it in items_raw if (it.get("item_name") or it.get("item_code"))
        ]
        if se_items:
            try:
                se = frappe.get_doc({
                    "doctype":          "Stock Entry",
                    "stock_entry_type": "Material Receipt",
                    "posting_date":     date,
                    "company":          company,
                    "to_warehouse":     warehouse,
                    "remarks":          f"Customer return — Credit Note {cn.name}",
                    "items":            se_items,
                })
                se.name = "SE-CN-" + frappe.generate_hash(
                    txt=f"{cn.name}{frappe.utils.now()}", length=8
                ).upper()
                se.flags.ignore_permissions = True
                se.flags.ignore_links = True
                se.flags.ignore_mandatory = True
                se.insert()
                se.submit()
                frappe.db.commit()
                se_name = se.name
            except Exception as exc:
                frappe.log_error(
                    f"Credit Note {cn.name}: Stock Entry failed — {exc}",
                    "Credit Note Stock Movement"
                )
                frappe.msgprint(
                    f"Credit note issued, but stock receipt failed: {exc}",
                    indicator="orange", alert=True
                )

    return {
        "credit_note": cn.name,
        "stock_entry": se_name,
        "return_type": "inventory" if reason == "Goods Returned" else "adjustment",
    }


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
