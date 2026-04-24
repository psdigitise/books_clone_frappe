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
    # Use LOWER() so we find accounts regardless of company name casing in the DB
    bank_accounts = frappe.db.sql(
        """SELECT name, account_type FROM `tabAccount`
           WHERE account_type IN ('Bank','Cash') AND is_group = 0
             AND LOWER(company) = LOWER(%s)
           ORDER BY account_type DESC""",
        (company,), as_dict=True
    )
    # Prefer our own Books Payment Mode; fall back to Frappe's Mode of Payment
    try:
        payment_mode_docs = frappe.get_all(
            "Books Payment Mode", filters={"enabled": 1}, fields=["mode_of_payment"], order_by="mode_of_payment"
        )
        payment_modes = [m.mode_of_payment for m in payment_mode_docs]
    except Exception:
        try:
            payment_mode_docs = frappe.get_all("Mode of Payment", fields=["name"], order_by="name")
            payment_modes = [m.name for m in payment_mode_docs]
        except Exception:
            payment_modes = ["Cash", "Bank Transfer", "UPI", "NEFT", "RTGS", "Cheque"]

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
        "payment_modes": payment_modes,
        "company": company,
    }


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def record_payment(
    invoice_name=None, amount_received=None, payment_date=None,
    payment_mode="Cash", deposit_to=None, bank_charges=0,
    reference_no=None, notes=None, tds_deducted=0, tds_amount=0, save_as_draft=False,
):
    if not invoice_name:
        frappe.throw("invoice_name is required to record a payment.")
    if amount_received is None:
        frappe.throw("amount_received is required.")
    if not payment_date:
        payment_date = frappe.utils.nowdate()
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

    # Resolve deposit_to first so we can derive the canonical company name from it.
    # Frappe validates that every account on a Payment Entry shares the same company
    # with a case-sensitive comparison, so the company on the Payment Entry MUST
    # exactly match the company stored on each account record.
    if not deposit_to:
        acct_type = "Cash" if payment_mode == "Cash" else "Bank"
        deposit_to = frappe.db.sql(
            """SELECT name FROM `tabAccount`
               WHERE account_type = %s AND LOWER(company) = LOWER(%s)
                 AND is_group = 0 AND disabled = 0
               LIMIT 1""",
            (acct_type, company), as_dict=True
        )
        deposit_to = deposit_to[0]["name"] if deposit_to else None

    if not deposit_to:
        frappe.throw("Could not find a Cash/Bank account. Please set one up under Accounts.")

    # Use the deposit_to account's own company as the canonical company name.
    # This is the authoritative value — the account itself knows its company.
    company = frappe.db.get_value("Account", deposit_to, "company") or company

    # Resolve Accounts Receivable — look up using the same canonical company.
    debtors_account = getattr(inv, "debit_to", None)
    if debtors_account:
        # Verify the invoice's debit_to account belongs to the same company
        # using case-insensitive comparison; if not, fall back to lookup.
        ar_company = frappe.db.get_value("Account", debtors_account, "company")
        if ar_company and ar_company.lower() != company.lower():
            debtors_account = None

    if not debtors_account:
        rows = frappe.db.sql(
            """SELECT name FROM `tabAccount`
               WHERE account_type = 'Receivable' AND LOWER(company) = LOWER(%s)
                 AND is_group = 0
               LIMIT 1""",
            (company,), as_dict=True
        )
        debtors_account = rows[0]["name"] if rows else None

    if not debtors_account:
        frappe.throw(
            f"No Receivable account found for company '{company}'. "
            "Please ensure the Chart of Accounts is set up under Accounts."
        )

    outstanding_amount = flt(getattr(inv, "outstanding_amount", None)) or (
        flt(inv.grand_total) - flt(getattr(inv, "advance_paid", 0))
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
        # Resolve Cost Center from our own DocType — not the built-in Company DocType
        cost_center = frappe.db.get_value(
            "Cost Center", {"company": company, "is_group": 0}, "name"
        )
        pe.append("deductions", {
            "account":     charges_account,
            "cost_center": cost_center or "",
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

# ─── AI Workflow Automator — Rule-based command parser (no API key needed) ───

@frappe.whitelist(allow_guest=False, methods=["POST"])
def ai_chat(messages, system=None):
    """
    Rule-based command parser for the Books AI Automator.
    Parses natural language commands and returns structured action JSON.
    No external API required.
    """
    import re

    if isinstance(messages, str):
        messages = json.loads(messages)

    # Get the latest user message
    user_msg = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            user_msg = m.get("content", "").strip()
            break

    if not user_msg:
        return {"text": '{"action":"unknown","message":"No command received."}'}

    cmd = user_msg.lower()

    # ── CREATE INVOICE ──────────────────────────────────────────────────────
    # Patterns: "create invoice for hari laptop 50000"
    #           "invoice prasath ₹80,000"
    #           "new invoice for customer Raju item Laptop qty 2 rate 25000"
    create_patterns = [
        r"(?:create|make|new|add)\s+(?:an?\s+)?invoice\s+(?:for\s+)?(.+)",
        r"invoice\s+(?:for\s+)?(.+)",
        r"bill\s+(?:for\s+)?(.+)",
    ]
    for pat in create_patterns:
        m = re.search(pat, cmd, re.IGNORECASE)
        if m:
            rest = m.group(1).strip()

            # Extract amount — ₹1,00,000 or 50000 or rs.5000
            amt_match = re.search(r"(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)|(?:^|\s)([\d,]+(?:\.\d+)?)(?:\s|$)", rest, re.IGNORECASE)
            amount = 0
            if amt_match:
                raw_amt = (amt_match.group(1) or amt_match.group(2) or "0").replace(",", "")
                amount = float(raw_amt)

            # Extract qty — "qty 2" or "2 units" or "2x"
            qty = 1
            qty_match = re.search(r"(?:qty|quantity|x)\s*(\d+)|(\d+)\s*(?:qty|units?|pcs?|nos?)", rest, re.IGNORECASE)
            if qty_match:
                qty = int(qty_match.group(1) or qty_match.group(2))

            # Extract item name — keywords that suggest an item
            item_keywords = ["laptop", "computer", "phone", "mobile", "service", "product",
                             "item", "work", "design", "consulting", "development", "repair",
                             "maintenance", "software", "hardware", "table", "chair", "ac",
                             "printer", "scanner", "camera", "tv", "monitor", "keyboard"]
            item_name = "Service"
            for kw in item_keywords:
                if kw in cmd:
                    item_name = kw.title()
                    break
            # Also try to find explicit item= or item:
            item_explicit = re.search(r"item[:\s]+([a-z][a-z\s]+?)(?:\s+(?:qty|rate|₹|rs|for|\d)|$)", rest, re.IGNORECASE)
            if item_explicit:
                item_name = item_explicit.group(1).strip().title()

            # Extract customer — everything before the item/amount keywords
            # Remove amount, qty, item mentions to isolate customer name
            customer_text = rest
            customer_text = re.sub(r"(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d+)?", "", customer_text, flags=re.IGNORECASE)
            customer_text = re.sub(r"(?:qty|quantity|x)\s*\d+|\d+\s*(?:qty|units?|pcs?)", "", customer_text, flags=re.IGNORECASE)
            customer_text = re.sub(r"\b(?:item|product|service|for|an?|the|of|with|at|rate|price)\b", "", customer_text, flags=re.IGNORECASE)
            for kw in item_keywords:
                customer_text = re.sub(r"\b" + kw + r"\b", "", customer_text, flags=re.IGNORECASE)
            customer_text = re.sub(r"\s+", " ", customer_text).strip().strip(",")

            # Use first word(s) as customer if still messy
            customer = customer_text.title() if len(customer_text) > 1 else "Customer"

            # Calculate rate
            rate = amount / qty if qty > 0 and amount > 0 else amount

            return {"text": json.dumps({
                "action": "create_invoice",
                "customer": customer,
                "items": [{"item_name": item_name, "qty": qty, "rate": rate, "amount": amount}],
                "due_date": nowdate(),
                "notes": ""
            })}

    # ── OVERDUE INVOICES ────────────────────────────────────────────────────
    if any(w in cmd for w in ["overdue", "over due", "past due", "late", "unpaid overdue"]):
        return {"text": json.dumps({"action": "show_overdue"})}

    # ── FIND / SEARCH CUSTOMER INVOICES ─────────────────────────────────────
    find_match = re.search(
        r"(?:find|search|show|get|list)\s+(?:invoices?\s+)?(?:for|of|by)\s+(.+)|"
        r"(?:invoices?\s+(?:for|of|by))\s+(.+)|"
        r"(.+?)(?:'s)?\s+invoices?",
        cmd, re.IGNORECASE
    )
    if find_match and any(w in cmd for w in ["find", "search", "show", "list", "invoice"]):
        customer = (find_match.group(1) or find_match.group(2) or find_match.group(3) or "").strip().title()
        if customer and customer.lower() not in ("all", "my", "the", ""):
            return {"text": json.dumps({"action": "find_invoices", "customer": customer})}

    # ── OUTSTANDING / TOTAL ──────────────────────────────────────────────────
    if any(w in cmd for w in ["outstanding", "total due", "total unpaid", "receivables", "how much owed"]):
        return {"text": json.dumps({"action": "show_outstanding"})}

    # ── ALL INVOICES / LIST ──────────────────────────────────────────────────
    if any(w in cmd for w in ["all invoices", "list invoices", "show invoices", "show all"]):
        return {"text": json.dumps({"action": "show_overdue"})}

    # ── GREETINGS ────────────────────────────────────────────────────────────
    greetings = ["hi", "hello", "hey", "good morning", "good afternoon", "good evening",
                 "howdy", "hola", "namaste", "vanakkam", "sup", "yo", "greetings"]
    if cmd.strip() in greetings or any(cmd.strip().startswith(g) for g in greetings):
        user_name = frappe.session.user.split("@")[0].title() if frappe.session.user else ""
        return {"text": json.dumps({
            "action": "reply",
            "message": f"Hello{', ' + user_name if user_name and user_name != 'Administrator' else ''}! How can I help you today?\n\nHere's what I can do:\n• Create a sales invoice\n• Show overdue invoices\n• Find invoices by customer\n• Show total outstanding amount"
        })}

    # ── HELP ─────────────────────────────────────────────────────────────────
    if any(w in cmd for w in ["help", "what can you do", "commands", "options", "how to", "?"]):
        return {"text": json.dumps({
            "action": "reply",
            "message": "Here's what I can do:\n\n• Create invoice for [customer] ₹[amount]\n• Create invoice for [customer] [item] ₹[rate]\n• Show overdue invoices\n• Find invoices for [customer]\n• Show total outstanding\n\nJust type naturally — I'll understand!"
        })}

    # ── HOW ARE YOU / THANKS ─────────────────────────────────────────────────
    if any(w in cmd for w in ["how are you", "how r u", "what's up", "whats up", "thank", "thanks", "ok", "okay", "great", "nice", "cool", "good", "awesome"]):
        return {"text": json.dumps({
            "action": "reply",
            "message": "All good! Ready to help. What would you like to do?\n\nTry: \"Create invoice for Prasath ₹50,000\" or \"Show overdue invoices\""
        })}

    # ── UNKNOWN ──────────────────────────────────────────────────────────────
    return {"text": json.dumps({
        "action": "reply",
        "message": f"I can help with invoicing tasks. Here's what I understand:\n\n• \"Create invoice for [customer] ₹[amount]\"\n• \"Show overdue invoices\"\n• \"Find invoices for [customer]\"\n• \"Show total outstanding\"\n\nTry one of these!"
    })}


# ── CHART OF ACCOUNTS ─────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def get_chart_of_accounts(company=None):
    """Return all non-disabled accounts.
    Dynamically checks which columns exist in tabAccount so it works
    on plain Frappe installations that may not have root_type / opening_balance etc."""

    # ── 1. Discover available columns via SHOW COLUMNS ──────────────────────
    try:
        col_rows = frappe.db.sql("SHOW COLUMNS FROM `tabAccount`", as_dict=True)
        available = {r.get("Field") or r.get("field", "") for r in col_rows}
    except Exception:
        available = set()

    # Always-safe fields that exist in every Frappe Account doctype
    fields = ["name", "account_name", "account_number", "account_type",
              "is_group", "parent_account"]

    # Optional fields — only include if the column exists in this installation
    for opt in ["root_type", "opening_balance", "balance_must_be", "lft", "rgt", "disabled"]:
        if not available or opt in available:   # include if we couldn't detect columns
            fields.append(opt)

    # ── 2. Determine sort order ──────────────────────────────────────────────
    order_by = "lft asc" if ("lft" in fields) else "account_name asc"

    # ── 3. Build filters ─────────────────────────────────────────────────────
    filters = {}
    if "disabled" in fields:
        filters["disabled"] = 0
    if company:
        try:
            if frappe.db.has_column("Account", "company"):
                filters["company"] = company
        except Exception:
            pass

    # ── 4. Query ─────────────────────────────────────────────────────────────
    try:
        accounts = frappe.db.get_all(
            "Account",
            filters=filters,
            fields=fields,
            order_by=order_by,
            limit=1000
        )
    except Exception as e:
        frappe.log_error(title="get_chart_of_accounts SQL error", message=str(e))
        # Last-resort: try with only the minimal safe fields
        try:
            accounts = frappe.db.get_all(
                "Account",
                fields=["name", "account_name", "account_type", "is_group", "parent_account"],
                order_by="account_name asc",
                limit=1000
            )
        except Exception:
            accounts = []

    return accounts


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def save_account(op, name=None, account_name=None, account_number=None,
                 root_type=None, account_type=None, parent_account=None,
                 is_group=0, opening_balance=0, balance_must_be="Debit",
                 company=None):
    """Create or update an Account document.
    op = 'create' | 'update' | 'delete'
    (named 'op' instead of 'action' — Frappe v15 strips 'action' from form_dict)
    """
    if not company:
        try:
            company = frappe.db.get_single_value("Books Settings", "default_company") or ""
        except Exception:
            company = ""

    # Discover which optional fields exist in tabAccount
    _has = {}
    def _col_exists(col):
        if col not in _has:
            try:
                _has[col] = frappe.db.has_column("Account", col)
            except Exception:
                _has[col] = False
        return _has[col]

    if op == "create":
        if not account_name:
            frappe.throw("Account name is required")
        doc_dict = {
            "doctype": "Account",
            "account_name": account_name,
            "account_type": account_type or "",
            "is_group": int(is_group or 0),
        }
        if account_number and _col_exists("account_number"):
            doc_dict["account_number"] = account_number
        if root_type and _col_exists("root_type"):
            doc_dict["root_type"] = root_type
        if parent_account and _col_exists("parent_account"):
            doc_dict["parent_account"] = parent_account
        if opening_balance is not None and _col_exists("opening_balance"):
            doc_dict["opening_balance"] = float(opening_balance or 0)
        if balance_must_be and _col_exists("balance_must_be"):
            doc_dict["balance_must_be"] = balance_must_be
        if company and _col_exists("company"):
            doc_dict["company"] = company
        doc = frappe.get_doc(doc_dict)
        doc.insert(ignore_permissions=True)
        frappe.db.commit()
        return {"name": doc.name, "status": "created"}

    elif op == "update":
        if not name:
            frappe.throw("Account name (document name) is required for update")
        doc = frappe.get_doc("Account", name)
        if account_name is not None:
            doc.account_name = account_name
        if account_number is not None and _col_exists("account_number"):
            doc.account_number = account_number
        if root_type is not None and _col_exists("root_type"):
            doc.root_type = root_type
        if account_type is not None:
            doc.account_type = account_type
        if parent_account is not None and _col_exists("parent_account"):
            doc.parent_account = parent_account
        if is_group is not None:
            doc.is_group = int(is_group)
        if opening_balance is not None and _col_exists("opening_balance"):
            doc.opening_balance = float(opening_balance)
        if balance_must_be is not None and _col_exists("balance_must_be"):
            doc.balance_must_be = balance_must_be
        doc.save(ignore_permissions=True)
        frappe.db.commit()
        return {"name": doc.name, "status": "updated"}

    elif op == "delete":
        if not name:
            frappe.throw("Account name is required for delete")
        frappe.delete_doc("Account", name, ignore_permissions=True)
        frappe.db.commit()
        return {"status": "deleted"}


# ── GSTR / ITC Report endpoints (P3/Issue 9) ──────────────────────────────────

@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def get_gstr_summary(company=None, from_date=None, to_date=None):
    """
    Return a GSTR-3B style summary:
      output  — taxes collected on Sales Invoices
      itc     — input tax credit from Purchase Invoices
      net     — output - ITC per tax type
      totals  — aggregate figures
    """
    from zoho_books_clone.db.queries import get_gstr_summary as _gstr
    from frappe.utils import nowdate

    if not company:
        company = frappe.db.get_single_value("Books Settings", "default_company") or ""
    if not from_date:
        from_date = nowdate()[:8] + "01"      # first of current month
    if not to_date:
        to_date = nowdate()

    if not company:
        frappe.throw("Company is required")

    return _gstr(company=company, from_date=from_date, to_date=to_date)


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def get_itc_ledger(company=None, from_date=None, to_date=None):
    """
    Line-by-line ITC ledger from Purchase Invoices — for GSTR-2A reconciliation.
    """
    from zoho_books_clone.db.queries import get_itc_ledger as _itc
    from frappe.utils import nowdate

    if not company:
        company = frappe.db.get_single_value("Books Settings", "default_company") or ""
    if not from_date:
        from_date = nowdate()[:8] + "01"
    if not to_date:
        to_date = nowdate()

    if not company:
        frappe.throw("Company is required")

    rows = _itc(company=company, from_date=from_date, to_date=to_date)
    return [dict(r) for r in rows]


# ─── Company Name Normalisation ───────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def normalize_company_names():
    """
    One-time migration: pick the most-frequently used casing of the company
    name from tabAccount and normalise every other record to match it.

    Run via: bench execute zoho_books_clone.api.books_data.normalize_company_names
    Or call via the API (System Manager only).
    """
    if "System Manager" not in frappe.get_roles(frappe.session.user):
        frappe.throw("Only System Managers can run this migration.")

    # Find the canonical company name (most common casing in Account records)
    rows = frappe.db.sql(
        """SELECT company, COUNT(*) AS cnt
           FROM `tabAccount`
           WHERE company IS NOT NULL AND company != ''
           GROUP BY company
           ORDER BY cnt DESC
           LIMIT 1""",
        as_dict=True,
    )
    if not rows:
        return {"message": "No accounts found — nothing to normalise."}

    canonical = rows[0]["company"]

    # Tables and fields to normalise
    targets = [
        ("tabAccount",          "company"),
        ("tabSales Invoice",    "company"),
        ("tabPurchase Invoice", "company"),
        ("tabPayment Entry",    "company"),
        ("tabJournal Entry",    "company"),
        ("tabStock Entry",      "company"),
        ("tabGeneral Ledger Entry", "company"),
        ("tabStock Ledger Entry",   "company"),
        ("tabWarehouse",        "company"),
        ("tabCost Center",      "company"),
    ]

    updated = {}
    for table, field in targets:
        try:
            frappe.db.sql(
                f"UPDATE `{table}` SET `{field}` = %s "
                f"WHERE LOWER(`{field}`) = LOWER(%s) AND `{field}` != %s",
                (canonical, canonical, canonical),
            )
            count = frappe.db.sql("SELECT ROW_COUNT()")[0][0]
            if count:
                updated[table] = count
        except Exception:
            pass  # Table may not exist on this install

    frappe.db.commit()
    return {
        "canonical_company": canonical,
        "rows_updated": updated,
        "message": f"Normalised company name to '{canonical}' across {len(updated)} tables.",
    }


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def get_invoice_payments(invoice_name):
    """Return all submitted payment entries linked to a Sales Invoice."""
    rows = frappe.db.sql("""
        SELECT pe.name, pe.posting_date, pe.payment_mode,
               per.allocated_amount, pe.reference_no
          FROM `tabPayment Entry` pe
          JOIN `tabPayment Entry Reference` per ON per.parent = pe.name
         WHERE per.reference_name = %s AND pe.docstatus = 1
         ORDER BY pe.posting_date
    """, invoice_name, as_dict=True)
    return rows
