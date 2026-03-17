import frappe


def _get_company() -> str:
    """Read company from Books Settings — our own DocType, always exists."""
    try:
        val = frappe.db.get_single_value("Books Settings", "default_company")
        if val:
            return val
    except Exception:
        pass
    # Fallback: use site name
    try:
        return frappe.local.site or ""
    except Exception:
        return ""


@frappe.whitelist(allow_guest=False)
def get_books_session():
    """Returns session info needed to bootstrap the Books Vue SPA."""
    user = frappe.session.user
    if not user or user == "Guest":
        frappe.throw("Not permitted", frappe.PermissionError)

    try:
        fullname = frappe.utils.get_fullname(user) or user
    except Exception:
        fullname = user

    return {
        "user":       user,
        "fullname":   fullname,
        "csrf_token": frappe.session.csrf_token or "",
        "company":    _get_company(),
    }
