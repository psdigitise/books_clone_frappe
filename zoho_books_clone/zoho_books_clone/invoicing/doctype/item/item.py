import frappe
from frappe import _
from frappe.model.document import Document

class Item(Document):
    def validate(self):
        if not self.item_code:
            frappe.throw(_("Item Code is required"))
        if not self.stock_uom:
            self.stock_uom = "Nos"
        self.item_code = self.item_code.strip()

    def on_update(self):
        pass

    @frappe.whitelist(methods=["GET", "POST"])
    def get_item_details(self, price_list=None, company=None):
        """Return item details for use in invoice line items."""
        return {
            "item_name":       self.item_name,
            "description":     self.description or self.item_name,
            "stock_uom":       self.stock_uom,
            "standard_rate":   self.standard_rate or 0,
            "income_account":  self.income_account,
            "expense_account": self.expense_account,
            "tax_code":        self.tax_code,
            "hsn_code":        self.hsn_code,
        }
