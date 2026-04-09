import frappe
import frappe.sessions


def _get_company() -> str:
    """
    Resolve the active company for the Books SPA in priority order:
    1. Books Settings.default_company  (authoritative setting)
    2. First Account record's company  (data-driven fallback)
    3. Empty string                    (UI shows setup prompt — never the site name)
    """
    # 1. Authoritative setting
    try:
        val = frappe.db.get_single_value("Books Settings", "default_company")
        if val:
            return val
    except Exception:
        pass

    # 2. Infer from existing Account records — avoids using the site name as a company
    try:
        row = frappe.db.sql(
            "SELECT company FROM `tabAccount` WHERE company IS NOT NULL AND company != '' LIMIT 1",
            as_dict=True,
        )
        if row and row[0].get("company"):
            return row[0]["company"]
    except Exception:
        pass

    # 3. Nothing configured — return empty string so the UI can prompt setup
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
        "csrf_token": frappe.sessions.get_csrf_token(),
        "company":    _get_company(),
    }
