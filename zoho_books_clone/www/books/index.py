import frappe

no_cache = 1

def get_context(context):
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/books"
        raise frappe.Redirect

    csrf     = frappe.session.csrf_token or ""
    user     = frappe.session.user or ""
    try:
        fullname = frappe.utils.get_fullname(user) or user
    except Exception:
        fullname = user

    # Pass values to the template via context
    context.no_cache       = 1
    context.no_header      = 1
    context.no_breadcrumbs = 1
    context.no_sidebar     = 1
    context.csrf           = csrf
    context.user           = user
    context.fullname       = fullname
