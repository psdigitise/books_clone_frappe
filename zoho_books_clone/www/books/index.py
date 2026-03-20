import frappe

no_cache = 1
no_sitemap = 1

def get_context(context):
    # Redirect guests to login
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/books"
        raise frappe.Redirect

    # Suppress Frappe's default layout (navbar, sidebar, footer)
    context.no_cache = 1
    context.show_sidebar = False
    context.parents = []
    context.title = "Books"
