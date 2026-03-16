import frappe
from frappe.model.document import Document


class BooksSettings(Document):
    def validate(self):
        if self.reconcile_tolerance and float(self.reconcile_tolerance) < 0:
            frappe.throw("Reconciliation Tolerance cannot be negative")
