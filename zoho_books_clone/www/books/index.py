import frappe
import json

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

    # Pass session data to template
    context.csrf_token     = frappe.session.csrf_token
    context.session_user   = frappe.session.user
    context.user_fullname  = frappe.utils.get_fullname(frappe.session.user)
    context.company        = frappe.defaults.get_user_default("company") or \
                             frappe.db.get_single_value("Global Defaults", "default_company") or ""
