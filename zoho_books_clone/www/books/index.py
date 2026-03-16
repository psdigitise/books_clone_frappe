import frappe

def get_context(context):
    # Redirect guests to login
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/books"
        raise frappe.Redirect

    context.no_cache       = 1
    context.title          = "Books"
    context.no_header      = 1
    context.no_breadcrumbs = 1
    context.no_sidebar     = 1
    context.show_sidebar   = 0

    # Safe session values — no DB calls here
    context.csrf_token    = frappe.session.csrf_token or ""
    context.session_user  = frappe.session.user or ""
    try:
        context.user_fullname = frappe.utils.get_fullname(frappe.session.user) or ""
    except Exception:
        context.user_fullname = frappe.session.user or ""
