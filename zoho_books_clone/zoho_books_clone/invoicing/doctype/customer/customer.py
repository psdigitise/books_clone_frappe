import frappe
from frappe import _
from frappe.model.document import Document

class Customer(Document):
    def validate(self):
        if not self.customer_name:
            frappe.throw(_("Customer Name is required"))
        if self.email_id and "@" not in self.email_id:
            frappe.throw(_("Please enter a valid email address"))

    def after_insert(self):
        # Ensure a naming series counter exists
        pass

    @frappe.whitelist()
    def get_outstanding_invoices(self):
        return frappe.get_all(
            "Sales Invoice",
            filters={"customer": self.name, "docstatus": 1, "outstanding_amount": [">", 0]},
            fields=["name", "posting_date", "due_date", "grand_total", "outstanding_amount"],
            order_by="due_date asc",
        )
