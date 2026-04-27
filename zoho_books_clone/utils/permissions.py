import frappe


def has_permission(doc, ptype="read", user=None):
    """Custom permission logic – Books Viewer gets read only."""
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    if "Books Admin" in roles:
        return True
    if ptype == "read" and "Books Viewer" in roles:
        return True
    if ptype in ("read", "write", "create") and "Accountant" in roles:
        return True
    return False
