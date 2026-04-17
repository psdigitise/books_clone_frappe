import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class CurrencyExchange(Document):
    def validate(self):
        if self.from_currency == self.to_currency:
            frappe.throw(_("From Currency and To Currency cannot be the same."))
        if flt(self.exchange_rate) <= 0:
            frappe.throw(_("Exchange Rate must be greater than 0."))
