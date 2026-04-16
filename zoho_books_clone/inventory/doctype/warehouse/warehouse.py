import frappe
from frappe import _
from frappe.model.document import Document


class Warehouse(Document):
    def validate(self):
        if not self.warehouse_name:
            frappe.throw(_("Warehouse Name is required"))
        self.warehouse_name = self.warehouse_name.strip()

    def before_save(self):
        # Ensure a Bin record exists for any items already associated with this warehouse
        pass

    def on_trash(self):
        # Prevent deletion if stock exists
        if frappe.db.exists("Bin", {"warehouse": self.name, "actual_qty": [">", 0]}):
            frappe.throw(
                _("Cannot delete Warehouse '{0}' — it has stock. Clear all stock first.").format(self.name)
            )

    @frappe.whitelist()
    def get_stock_summary(self):
        """Return all Bins for this warehouse with current stock."""
        return frappe.get_all(
            "Bin",
            filters={"warehouse": self.name, "actual_qty": [">", 0]},
            fields=["item_code", "actual_qty", "valuation_rate", "stock_value"],
            order_by="item_code asc",
        )
