import frappe


def has_permission(doc, ptype="read", user=None):
    """Custom permission logic – Books Viewer gets read only."""
    user = user or frappe.session.user
    if frappe.has_role("Books Admin", user):
        return True
    if ptype == "read" and frappe.has_role("Books Viewer", user):
        return True
    if ptype in ("read","write","create") and frappe.has_role("Accountant", user):
        return True
    return False
