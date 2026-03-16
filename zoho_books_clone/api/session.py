import frappe

@frappe.whitelist(allow_guest=False)
def get_books_session():
    """
    Returns session info needed to bootstrap the Books Vue SPA.
    Called from index.html before Vue mounts.
    """
    user = frappe.session.user
    if not user or user == "Guest":
        frappe.throw("Not permitted", frappe.PermissionError)

    try:
        fullname = frappe.utils.get_fullname(user) or user
    except Exception:
        fullname = user

    try:
        company = (
            frappe.defaults.get_user_default("company") or
            frappe.db.get_single_value("Global Defaults", "default_company") or ""
        )
    except Exception:
        company = ""

    return {
        "user":       user,
        "fullname":   fullname,
        "csrf_token": frappe.session.csrf_token or "",
        "company":    company,
    }
