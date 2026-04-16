import frappe
from frappe import _
from frappe.model.document import Document


class PriceList(Document):
    def validate(self):
        if not self.price_list_name:
            frappe.throw(_("Price List Name is required"))
        if not self.selling and not self.buying:
            frappe.throw(_("Price List must be for Selling, Buying, or both."))
