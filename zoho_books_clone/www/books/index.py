import frappe

def get_context(context):
    context.no_cache       = 1
    context.title          = "Books"
    context.no_header      = 1
    context.no_breadcrumbs = 1
    context.no_sidebar     = 1
    context.show_sidebar   = 0

    # Redirect guests — safe, no DB calls
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/books"
        raise frappe.Redirect
