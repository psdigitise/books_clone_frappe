import frappe
import json


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def save_doc(doc):
    """
    Save a document. Accepts GET so CSRF is never required.
    Called by the Books SPA instead of frappe.client.save.
    """
    if isinstance(doc, str):
        doc = json.loads(doc)

    doctype = doc.get("doctype")
    if not doctype:
        frappe.throw("doctype is required")

    # Check permission
    if not frappe.has_permission(doctype, "write"):
        frappe.throw("Not permitted", frappe.PermissionError)

    name = doc.get("name")
    if name and frappe.db.exists(doctype, name):
        # Update existing
        d = frappe.get_doc(doctype, name)
        d.update(doc)
    else:
        # Create new
        d = frappe.get_doc(doc)

    d.save(ignore_permissions=False)
    frappe.db.commit()
    return d.as_dict()


@frappe.whitelist(allow_guest=False, methods=["GET", "POST"])
def submit_doc(doctype, name):
    """Submit a document via GET — no CSRF needed."""
    if not frappe.has_permission(doctype, "submit"):
        frappe.throw("Not permitted", frappe.PermissionError)

    d = frappe.get_doc(doctype, name)
    d.submit()
    frappe.db.commit()
    return d.as_dict()
