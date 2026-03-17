import frappe
from frappe import _
from frappe.model.document import Document

class CostCenter(Document):
    def validate(self):
        if self.parent_cost_center:
            parent = frappe.get_doc("Cost Center", self.parent_cost_center)
            if not parent.is_group:
                frappe.throw(_("Parent Cost Center {0} must be a group").format(self.parent_cost_center))
        if not self.parent_cost_center and not self.is_group:
            frappe.throw(_("Root Cost Center must be a group"))
