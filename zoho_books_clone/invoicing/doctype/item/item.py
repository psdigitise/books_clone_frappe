import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class Item(Document):
    def validate(self):
        if not self.item_code:
            frappe.throw(_("Item Code is required"))
        if not self.stock_uom:
            self.stock_uom = "Nos"
        self.item_code = self.item_code.strip()
        if not self.item_name:
            self.item_name = self.item_code

        # Default: non-stock items don't track inventory
        if self.item_type in ("Service",):
            self.is_stock_item = 0
        elif not hasattr(self, "is_stock_item") or self.is_stock_item is None:
            self.is_stock_item = 1

    def after_insert(self):
        """Post-insert: create opening stock entry if opening_stock > 0."""
        if flt(getattr(self, "opening_stock", 0)) > 0 and self.is_stock_item:
            self._create_opening_stock_entry()

    def _create_opening_stock_entry(self):
        """Create a Stock Entry (Opening Stock) for the initial quantity."""
        try:
            warehouse = (
                getattr(self, "default_warehouse", None)
                or frappe.db.get_value("Warehouse", {"warehouse_name": "Stores"})
                or frappe.db.get_value("Warehouse", {"is_group": 0, "disabled": 0})
            )
            if not warehouse:
                frappe.log_error(
                    f"No warehouse found for opening stock of {self.name}",
                    "Item Opening Stock"
                )
                return

            company = (
                frappe.db.get_single_value("Books Settings", "default_company")
                or frappe.defaults.get_default("company")
                or ""
            )

            se = frappe.get_doc({
                "doctype": "Stock Entry",
                "stock_entry_type": "Opening Stock",
                "company": company,
                "to_warehouse": warehouse,
                "items": [{
                    "item_code": self.name,
                    "item_name": self.item_name,
                    "qty": flt(self.opening_stock),
                    "basic_rate": flt(getattr(self, "standard_buying_rate", 0)) or flt(getattr(self, "standard_rate", 0)),
                    "uom": self.stock_uom or "Nos",
                    "t_warehouse": warehouse,
                }]
            })
            se.insert(ignore_permissions=True)
            se.submit()
            frappe.db.commit()
        except Exception as e:
            frappe.log_error(frappe.get_traceback(), f"Opening stock for {self.name}")

    def on_update(self):
        """Sync reorder settings to Bin records when item is updated."""
        if not self.is_stock_item:
            return
        reorder_level = flt(getattr(self, "reorder_level", 0))
        reorder_qty   = flt(getattr(self, "reorder_qty",   0))
        if reorder_level or reorder_qty:
            frappe.db.sql("""
                UPDATE `tabBin`
                SET reorder_level = %(level)s, reorder_qty = %(qty)s
                WHERE item_code = %(item)s
            """, {"level": reorder_level, "qty": reorder_qty, "item": self.name})

    @frappe.whitelist()
    def get_item_details(self, price_list=None, company=None):
        """Return item details for use in invoice line items."""
        rate = flt(self.standard_rate)
        if price_list:
            try:
                from zoho_books_clone.inventory.utils import get_item_price
                pl_rate = get_item_price(self.name, price_list)
                if pl_rate:
                    rate = pl_rate
            except Exception:
                pass

        return {
            "item_name":       self.item_name,
            "description":     self.description or self.item_name,
            "stock_uom":       self.stock_uom,
            "standard_rate":   rate,
            "income_account":  self.income_account,
            "expense_account": self.expense_account,
            "tax_code":        self.tax_code,
            "hsn_code":        self.hsn_code,
            "is_stock_item":   self.is_stock_item,
            "default_warehouse": getattr(self, "default_warehouse", None),
        }

    @frappe.whitelist()
    def get_stock_balance(self, warehouse=None):
        """Return current stock qty for this item across all (or one) warehouse(s)."""
        if not self.is_stock_item:
            return {"is_stock_item": False, "warehouses": [], "total_qty": 0}
        try:
            from zoho_books_clone.inventory.utils import get_stock_balance, get_stock_balance_bulk
            if warehouse:
                qty = get_stock_balance(self.name, warehouse)
                return {"warehouses": [{"warehouse": warehouse, "actual_qty": qty}], "total_qty": qty}

            bins = frappe.get_all(
                "Bin",
                filters={"item_code": self.name},
                fields=["warehouse", "actual_qty", "stock_value", "valuation_rate"],
            )
            return {
                "is_stock_item": True,
                "warehouses":    [{"warehouse": b.warehouse, "actual_qty": flt(b.actual_qty),
                                   "stock_value": flt(b.stock_value)} for b in bins],
                "total_qty":     sum(flt(b.actual_qty) for b in bins),
            }
        except Exception as e:
            return {"error": str(e)}
