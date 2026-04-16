import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, getdate


class ItemPrice(Document):
    def validate(self):
        if not self.item_code:
            frappe.throw(_("Item is required"))
        if not self.price_list:
            frappe.throw(_("Price List is required"))
        if flt(self.price_list_rate) <= 0:
            frappe.throw(_("Rate must be greater than 0"))
        if self.valid_from and self.valid_upto:
            if getdate(self.valid_upto) < getdate(self.valid_from):
                frappe.throw(_("Valid Upto cannot be before Valid From"))
        # Auto-fill item name
        if not self.item_name:
            self.item_name = frappe.db.get_value("Item", self.item_code, "item_name") or self.item_code

    @staticmethod
    def get_price(item_code, price_list, uom=None, as_of_date=None):
        """
        Return the active rate for an item in a given price list.
        Used by invoice line-item auto-fill.
        """
        from frappe.utils import today as frappe_today
        date = as_of_date or frappe_today()
        filters = {
            "item_code": item_code,
            "price_list": price_list,
            "docstatus": ["!=", 2],
        }
        if uom:
            filters["uom"] = uom

        prices = frappe.get_all(
            "Item Price",
            filters=filters,
            fields=["price_list_rate", "valid_from", "valid_upto", "currency"],
            order_by="valid_from desc",
        )

        for p in prices:
            if p.valid_from and getdate(p.valid_from) > getdate(date):
                continue
            if p.valid_upto and getdate(p.valid_upto) < getdate(date):
                continue
            return p.price_list_rate

        return prices[0].price_list_rate if prices else 0
