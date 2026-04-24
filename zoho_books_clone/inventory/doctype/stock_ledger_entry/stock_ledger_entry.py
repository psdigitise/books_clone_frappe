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
        """
        Create or update the Bin for this item+warehouse combination.

        Audit-6: Uses SELECT ... FOR UPDATE row-level locking so that concurrent
        SLE inserts for the same item+warehouse don't race and produce an incorrect
        Bin balance.  The lock is held for the duration of the current DB transaction
        and released automatically on commit/rollback.
        """
        bin_name = frappe.db.get_value("Bin", {"item_code": self.item_code, "warehouse": self.warehouse})

        if bin_name:
            # Acquire an exclusive row lock before reading current qty.
            # This serialises concurrent updates to the same Bin row.
            frappe.db.sql(
                "SELECT name FROM `tabBin` WHERE name = %s FOR UPDATE",
                (bin_name,),
            )
            bin_doc = frappe.get_doc("Bin", bin_name)
        else:
            # INSERT path — race-safe because the unique constraint on
            # (item_code, warehouse) will cause a duplicate-key error if two
            # threads try to create the same Bin simultaneously; the second
            # thread retries via get_value below.
            try:
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
                bin_doc.flags.ignore_links = True
                bin_doc.flags.ignore_mandatory = True
                bin_doc.insert(ignore_permissions=True)
                # Lock the newly inserted row immediately
                frappe.db.sql(
                    "SELECT name FROM `tabBin` WHERE name = %s FOR UPDATE",
                    (bin_doc.name,),
                )
            except Exception:
                # Another thread created the Bin between our get_value check and
                # our INSERT — fetch it and lock it instead.
                bin_name = frappe.db.get_value(
                    "Bin", {"item_code": self.item_code, "warehouse": self.warehouse}
                )
                frappe.db.sql(
                    "SELECT name FROM `tabBin` WHERE name = %s FOR UPDATE",
                    (bin_name,),
                )
                bin_doc = frappe.get_doc("Bin", bin_name)

        # Apply the delta (now holding the exclusive lock)
        new_qty = flt(bin_doc.actual_qty) + flt(self.actual_qty)
        total_value = flt(new_qty) * flt(self.valuation_rate) if new_qty > 0 else 0

        bin_doc.actual_qty = new_qty
        bin_doc.valuation_rate = flt(self.valuation_rate) if new_qty > 0 else flt(bin_doc.valuation_rate)
        bin_doc.stock_value = total_value
        bin_doc.projected_qty = flt(new_qty) + flt(bin_doc.ordered_qty) - flt(bin_doc.reserved_qty)
        bin_doc.flags.ignore_links = True
        bin_doc.flags.ignore_mandatory = True
        bin_doc.save(ignore_permissions=True)
