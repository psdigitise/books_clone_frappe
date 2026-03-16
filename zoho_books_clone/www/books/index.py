import frappe

def get_context(context):
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.throw("Not permitted", frappe.PermissionError)
    context.no_cache = 1
    context.title    = "Books"
