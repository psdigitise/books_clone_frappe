import frappe
from frappe.model.document import Document

class Currency(Document):
    def validate(self):
        if not self.currency_name:
            frappe.throw("Currency Name is required")
        self.currency_name = self.currency_name.strip().upper()
