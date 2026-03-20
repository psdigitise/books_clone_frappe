import frappe

no_cache = 1

def get_context(context):
    # Redirect guests to login
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/books"
        raise frappe.Redirect
    # Serve the app directly at /books (no .html in URL)
    context.no_cache = 1
