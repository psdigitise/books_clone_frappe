"""
Administration API — users, roles, profile, notifications, audit log.
All endpoints require an authenticated session (allow_guest=False by default).
"""
import frappe
from frappe import _
from frappe.utils import today, now_datetime, getdate, flt
from frappe.utils.password import update_password, check_password


# ─── Users ────────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_users_list():
    """Return all non-system users with their Books role."""
    frappe.only_for("Books Admin")
    users = frappe.get_all(
        "User",
        filters=[
            ["name", "not in", ["Guest", "Administrator"]],
            ["user_type", "=", "System User"],
        ],
        fields=["name", "full_name", "email", "enabled", "last_login",
                "creation", "user_image"],
        order_by="full_name asc",
        limit=200,
    )
    BOOKS_ROLES = {"Books Admin", "Books Manager", "Accountant", "Books Viewer"}
    for u in users:
        roles = frappe.get_all(
            "Has Role",
            filters={"parent": u["name"], "role": ["in", list(BOOKS_ROLES)]},
            fields=["role"],
        )
        u["books_role"] = roles[0]["role"] if roles else "—"
        u["enabled"] = bool(u.get("enabled"))
    return users


@frappe.whitelist()
def invite_user(email, first_name, last_name="", role="Books Viewer"):
    """Create a new user and assign a Books role, then send welcome email."""
    frappe.only_for("Books Admin")
    email = email.strip().lower()
    if frappe.db.exists("User", email):
        frappe.throw(_("User {0} already exists").format(email))

    allowed = {"Books Admin", "Books Manager", "Accountant", "Books Viewer"}
    if role not in allowed:
        frappe.throw(_("Invalid role: {0}").format(role))

    user = frappe.new_doc("User")
    user.email = email
    user.first_name = first_name.strip()
    user.last_name = (last_name or "").strip()
    user.user_type = "System User"
    user.send_welcome_email = 1
    user.append("roles", {"role": role})
    user.insert(ignore_permissions=True)
    frappe.db.commit()
    return {"success": True, "user": user.name}


@frappe.whitelist()
def update_user_role(user, role):
    """Replace all Books roles on a user with the given role."""
    frappe.only_for("Books Admin")
    allowed = {"Books Admin", "Books Manager", "Accountant", "Books Viewer"}
    if role not in allowed:
        frappe.throw(_("Invalid role"))

    doc = frappe.get_doc("User", user)
    doc.roles = [r for r in doc.roles if r.role not in allowed]
    doc.append("roles", {"role": role})
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    return {"success": True}


@frappe.whitelist()
def toggle_user_active(user, enabled):
    """Enable or disable a user account."""
    frappe.only_for("Books Admin")
    if user in ("Administrator", "Guest"):
        frappe.throw(_("Cannot disable this user"))
    enabled_int = 1 if str(enabled).lower() in ("1", "true") else 0
    frappe.db.set_value("User", user, "enabled", enabled_int)
    frappe.db.commit()
    return {"success": True}


# ─── Profile ──────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_profile():
    """Return the current user's profile fields."""
    user = frappe.session.user
    doc = frappe.get_doc("User", user)
    return {
        "email": doc.email,
        "first_name": doc.first_name or "",
        "last_name": doc.last_name or "",
        "full_name": doc.full_name or "",
        "phone": doc.phone or "",
        "mobile_no": doc.mobile_no or "",
        "user_image": doc.user_image or "",
        "language": doc.language or "en",
        "time_zone": doc.time_zone or "",
    }


@frappe.whitelist()
def update_profile(first_name, last_name="", phone="", mobile_no=""):
    """Update the current user's profile."""
    user = frappe.session.user
    doc = frappe.get_doc("User", user)
    doc.first_name = first_name.strip()
    doc.last_name = (last_name or "").strip()
    doc.phone = phone or ""
    doc.mobile_no = mobile_no or ""
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    return {"success": True, "full_name": doc.full_name}


@frappe.whitelist()
def change_password(old_password, new_password):
    """Change the current user's password after verifying the old one."""
    user = frappe.session.user
    try:
        check_password(user, old_password)
    except Exception:
        frappe.throw(_("Current password is incorrect"))
    if len(new_password) < 8:
        frappe.throw(_("New password must be at least 8 characters"))
    update_password(user, new_password)
    frappe.db.commit()
    return {"success": True}


# ─── Notifications ────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_notifications():
    """Return a list of actionable notifications for the current user."""
    notifs = []
    company = frappe.db.get_single_value("Books Settings", "default_company") or ""

    # Overdue Sales Invoices
    overdue = frappe.get_all(
        "Sales Invoice",
        filters=[
            ["docstatus", "=", 1],
            ["outstanding_amount", ">", 0],
            ["due_date", "<", today()],
            ["company", "=", company] if company else [],
        ],
        fields=["name", "customer_name", "outstanding_amount", "due_date"],
        limit=5,
    )
    for inv in overdue:
        notifs.append({
            "type": "overdue_invoice",
            "icon": "alert",
            "color": "#C92A2A",
            "bg": "#FFF5F5",
            "title": "Overdue Invoice",
            "body": f"{inv['name']} — {inv['customer_name']} — ₹{flt(inv['outstanding_amount']):,.2f}",
            "link": f"#/invoices/{inv['name']}",
            "date": str(inv["due_date"]),
        })

    # Bills due today or overdue
    bills_due = frappe.get_all(
        "Purchase Invoice",
        filters=[
            ["docstatus", "=", 1],
            ["outstanding_amount", ">", 0],
            ["due_date", "<=", today()],
            ["company", "=", company] if company else [],
        ],
        fields=["name", "supplier_name", "outstanding_amount", "due_date"],
        limit=5,
    )
    for bill in bills_due:
        notifs.append({
            "type": "bill_due",
            "icon": "purchase",
            "color": "#E67700",
            "bg": "#FFF8F0",
            "title": "Bill Due",
            "body": f"{bill['name']} — {bill['supplier_name']} — ₹{flt(bill['outstanding_amount']):,.2f}",
            "link": "#/purchases",
            "date": str(bill["due_date"]),
        })

    # Reorder alerts — items below reorder level
    try:
        reorder = frappe.db.sql("""
            SELECT b.item_code, b.warehouse, b.actual_qty, i.reorder_level
            FROM `tabBin` b
            JOIN `tabItem` i ON i.name = b.item_code
            WHERE i.reorder_level > 0 AND b.actual_qty <= i.reorder_level
            LIMIT 3
        """, as_dict=True)
        for r in reorder:
            notifs.append({
                "type": "reorder",
                "icon": "bell",
                "color": "#1971C2",
                "bg": "#E7F5FF",
                "title": "Low Stock Alert",
                "body": f"{r['item_code']} — Qty: {flt(r['actual_qty']):.0f} (Reorder at {flt(r['reorder_level']):.0f})",
                "link": "#/inventory/reorder-alerts",
                "date": today(),
            })
    except Exception:
        pass

    return notifs


# ─── Audit Log ────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_audit_log(page=0, page_len=50):
    """Return recent document activity from Frappe's Activity Log."""
    frappe.only_for("Books Admin")
    page = int(page)
    page_len = min(int(page_len), 200)

    logs = frappe.db.sql("""
        SELECT
            al.name, al.user, al.creation,
            al.reference_doctype as doctype,
            al.reference_name as doc_name,
            al.operation,
            al.status
        FROM `tabActivity Log` al
        WHERE al.reference_doctype IN (
            'Sales Invoice','Purchase Invoice','Customer','Supplier',
            'Payment Entry','Journal Entry','Sales Order',
            'Purchase Order','Credit Note','Stock Entry'
        )
        ORDER BY al.creation DESC
        LIMIT %(len)s OFFSET %(off)s
    """, {"len": page_len, "off": page * page_len}, as_dict=True)

    return logs


# ─── Company Settings ─────────────────────────────────────────────────────────

@frappe.whitelist()
def get_company_settings():
    """Return Books Settings plus company address fields."""
    try:
        settings = frappe.get_doc("Books Settings", "Books Settings")
        result = {
            "default_company": settings.get("default_company") or "",
            "default_currency": settings.get("default_currency") or "INR",
            "fiscal_year_start_month": settings.get("fiscal_year_start_month") or "April",
            "invoice_prefix": settings.get("invoice_prefix") or "INV",
            "gstin": settings.get("gstin") or "",
            "gst_state": settings.get("gst_state") or "",
            "logo_url": settings.get("logo_url") or "",
            "company_address": settings.get("company_address") or "",
            "company_city": settings.get("company_city") or "",
            "company_state": settings.get("company_state") or "",
            "company_pincode": settings.get("company_pincode") or "",
            "company_phone": settings.get("company_phone") or "",
            "company_email": settings.get("company_email") or "",
            "company_website": settings.get("company_website") or "",
            "auto_send_invoice": settings.get("auto_send_invoice") or 0,
            "send_payment_reminders": settings.get("send_payment_reminders") or 0,
            "reminder_days_before": settings.get("reminder_days_before") or 3,
            "reminder_days_after": settings.get("reminder_days_after") or 7,
            "auto_reconcile": settings.get("auto_reconcile") or 0,
        }
    except Exception:
        result = {}
    return result


@frappe.whitelist()
def save_company_settings(**kwargs):
    """Save Books Settings fields including new logo/address fields."""
    frappe.only_for("Books Admin")
    try:
        settings = frappe.get_doc("Books Settings", "Books Settings")
    except Exception:
        settings = frappe.new_doc("Books Settings")

    allowed_fields = [
        "default_company", "default_currency", "fiscal_year_start_month",
        "invoice_prefix", "gstin", "gst_state",
        "logo_url", "company_address", "company_city", "company_state",
        "company_pincode", "company_phone", "company_email", "company_website",
        "auto_send_invoice", "send_payment_reminders",
        "reminder_days_before", "reminder_days_after", "auto_reconcile",
    ]
    for f in allowed_fields:
        if f in kwargs:
            settings.set(f, kwargs[f])
    settings.save(ignore_permissions=True)
    frappe.db.commit()
    return {"success": True}


# ─── SMTP / Email Settings ────────────────────────────────────────────────────

@frappe.whitelist()
def get_email_settings():
    """Return the default outgoing email account settings."""
    frappe.only_for("Books Admin")
    try:
        accts = frappe.get_all(
            "Email Account",
            filters={"enable_outgoing": 1},
            fields=["name", "email_id", "smtp_server", "smtp_port",
                    "use_tls", "use_ssl", "login_id", "email_account_name"],
            limit=5,
        )
        return {"accounts": accts}
    except Exception:
        return {"accounts": []}


@frappe.whitelist()
def send_test_email(to_email):
    """Send a test email using the configured SMTP."""
    frappe.only_for("Books Admin")
    frappe.sendmail(
        recipients=[to_email],
        subject="Books — Test Email",
        message="<p>This is a test email from your Zoho Books Clone installation. SMTP is configured correctly.</p>",
    )
    return {"success": True}
