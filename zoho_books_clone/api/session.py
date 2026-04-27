import frappe
import frappe.sessions

# Users who are always treated as experienced (never show tutorial)
_SYSTEM_USERS = {"Administrator", "Guest"}


def _get_company(user: str) -> str:
    """
    Resolve the active company for this specific user in priority order:
    1. Per-user default set via frappe.defaults (DB-persisted, isolated per user)
    2. Books Settings.default_company (global fallback for fresh sites)
    3. Empty string (UI shows setup prompt)

    Note: This app does not have a `Company` DocType. Company is stored as a
    Data string on Books Settings and on doctype `company` Data fields.
    """
    try:
        val = frappe.defaults.get_user_default("company", user)
        if val:
            return val
    except Exception:
        pass

    try:
        val = frappe.db.get_single_value("Books Settings", "default_company")
        if val:
            return val
    except Exception:
        pass

    return ""


def _is_new_user(user: str) -> bool:
    """True when this user has never completed the Books tutorial."""
    if user in _SYSTEM_USERS:
        return False
    try:
        return not frappe.defaults.get_user_default("books_tutorial_done", user)
    except Exception:
        return False


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

    try:
        csrf = frappe.sessions.get_csrf_token()
    except Exception:
        csrf = ""

    return {
        "user":        user,
        "fullname":    fullname,
        "csrf_token":  csrf,
        "company":     _get_company(user),
        "is_new_user": _is_new_user(user),
    }


@frappe.whitelist(methods=["POST"])
def mark_tutorial_done():
    """Called from the SPA when the user dismisses the tutorial."""
    user = frappe.session.user
    if user and user not in _SYSTEM_USERS:
        try:
            frappe.defaults.set_user_default("books_tutorial_done", "1", user)
            frappe.db.commit()
        except Exception:
            pass
    return {"ok": True}
