import frappe
from frappe import _
from frappe.model.document import Document

class Supplier(Document):
    def validate(self):
        if not self.supplier_name:
            frappe.throw(_("Supplier Name is required"))
        if self.email_id and "@" not in self.email_id:
            frappe.throw(_("Please enter a valid email address"))

    @frappe.whitelist(methods=["GET", "POST"])
    def get_outstanding_bills(self):
        return frappe.get_all(
            "Purchase Invoice",
            filters={"supplier": self.name, "docstatus": 1, "outstanding_amount": [">", 0]},
            fields=["name", "posting_date", "due_date", "grand_total", "outstanding_amount"],
            order_by="due_date asc",
        )
