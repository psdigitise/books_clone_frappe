import frappe

no_cache = 1

def get_context(context):
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/books"
        raise frappe.Redirect
    # Redirect to the static HTML file served directly by the web server
    frappe.local.flags.redirect_location = "/assets/zoho_books_clone/books.html"
    raise frappe.Redirect
