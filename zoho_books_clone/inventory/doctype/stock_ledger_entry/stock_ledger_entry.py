import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class StockLedgerEntry(Document):
    """
    Immutable audit-trail record for every stock movement.
    Never edited after creation — cancel by setting is_cancelled=1.
    """

    def before_save(self):
        if self.is_new():
            return
        # Prevent edits after creation (except is_cancelled flag)
        old = self.get_doc_before_save()
        if old and not old.is_cancelled:
            allowed = {"is_cancelled", "modified", "modified_by"}
            changed = {k for k, v in self.as_dict().items() if str(v) != str(old.as_dict().get(k))}
            if changed - allowed:
                frappe.throw(_("Stock Ledger Entries are immutable. Cancel via Stock Entry."))

    def after_insert(self):
        self._update_bin()

    def _update_bin(self):
        """Create or update the Bin for this item+warehouse combination."""
        bin_name = frappe.db.get_value("Bin", {"item_code": self.item_code, "warehouse": self.warehouse})

        if bin_name:
            bin_doc = frappe.get_doc("Bin", bin_name)
        else:
            bin_doc = frappe.get_doc({
                "doctype": "Bin",
                "item_code": self.item_code,
                "warehouse": self.warehouse,
                "company": self.company,
                "actual_qty": 0,
                "reserved_qty": 0,
                "ordered_qty": 0,
                "stock_value": 0,
                "valuation_rate": 0,
            })
            bin_doc.insert(ignore_permissions=True)

        # Apply the delta
        new_qty = flt(bin_doc.actual_qty) + flt(self.actual_qty)
        total_value = flt(new_qty) * flt(self.valuation_rate) if new_qty > 0 else 0

        bin_doc.actual_qty = new_qty
        bin_doc.valuation_rate = flt(self.valuation_rate) if new_qty > 0 else flt(bin_doc.valuation_rate)
        bin_doc.stock_value = total_value
        bin_doc.projected_qty = flt(new_qty) + flt(bin_doc.ordered_qty) - flt(bin_doc.reserved_qty)
        bin_doc.save(ignore_permissions=True)
