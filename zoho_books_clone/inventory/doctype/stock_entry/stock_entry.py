"""
Stock Entry — records every physical stock movement.
On submit: creates Stock Ledger Entries → Bin is updated automatically.
On cancel: reverses all SLEs (sets is_cancelled=1 and creates mirror entries).

Audit fixes applied:
  - Negative stock blocked in _validate_items (P2/Audit-1)
  - GL entries posted on submit for Material Issue/Receipt (P2/Audit-4)
"""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, today


SE_TYPE_DIRECTION = {
    "Material Receipt":  {"s": False, "t": True},
    "Material Issue":    {"s": True,  "t": False},
    "Material Transfer": {"s": True,  "t": True},
    "Opening Stock":     {"s": False, "t": True},
    "Manufacture":       {"s": True,  "t": True},
    "Stock Adjustment":  {"s": False, "t": True},  # manual correction; qty can be +/-
}


class StockEntry(Document):

    # ── Validate ──────────────────────────────────────────────────────────────

    def validate(self):
        self._set_defaults()
        self._validate_items()
        self._calculate_totals()

    def _set_defaults(self):
        if not self.posting_date:
            self.posting_date = today()
        if not self.company:
            self.company = (
                frappe.db.get_single_value("Books Settings", "default_company")
                or frappe.defaults.get_default("company")
                or ""
            )

    def _validate_items(self):
        if not self.items:
            frappe.throw(_("At least one item is required in the Stock Entry."))

        direction = SE_TYPE_DIRECTION.get(self.stock_entry_type, {})

        for i, row in enumerate(self.items, start=1):
            if not row.item_code:
                frappe.throw(_(f"Row {i}: Item Code is required."))

            # Auto-fill item name if blank
            if not row.item_name:
                row.item_name = frappe.db.get_value("Item", row.item_code, "item_name") or row.item_code

            # Auto-fill warehouses from header defaults
            if direction.get("s") and not row.s_warehouse:
                row.s_warehouse = self.from_warehouse
            if direction.get("t") and not row.t_warehouse:
                row.t_warehouse = self.to_warehouse

            # Validate warehouse requirements
            if direction.get("s") and not row.s_warehouse:
                frappe.throw(_(f"Row {i}: Source Warehouse is required for {self.stock_entry_type}."))
            if direction.get("t") and not row.t_warehouse:
                frappe.throw(_(f"Row {i}: Target Warehouse is required for {self.stock_entry_type}."))

            # Validate qty: Stock Adjustment allows negative (stock reduction correction)
            if self.stock_entry_type == "Stock Adjustment":
                if flt(row.qty) == 0:
                    frappe.throw(_(f"Row {i}: Qty cannot be zero for Stock Adjustment."))
            else:
                if flt(row.qty) <= 0:
                    frappe.throw(_(f"Row {i}: Qty must be greater than 0."))

            # Audit-1: Block negative stock — check available qty before outgoing movements
            if direction.get("s") and row.s_warehouse:
                available = flt(frappe.db.get_value(
                    "Bin",
                    {"item_code": row.item_code, "warehouse": row.s_warehouse},
                    "actual_qty",
                ) or 0)
                if available < flt(row.qty):
                    frappe.throw(_(
                        "Row {0}: Insufficient stock for item <b>{1}</b> in warehouse <b>{2}</b>. "
                        "Available: {3}, Required: {4}."
                    ).format(i, row.item_code, row.s_warehouse,
                             frappe.bold(available), frappe.bold(flt(row.qty))))

            # Use FIFO cost for Material Issue if rate not explicitly set
            if self.stock_entry_type == "Material Issue" and not flt(row.basic_rate) and row.s_warehouse:
                try:
                    from zoho_books_clone.inventory.utils import get_fifo_cost
                    fifo_rate = get_fifo_cost(row.item_code, row.s_warehouse, flt(row.qty))
                    if fifo_rate:
                        row.basic_rate = fifo_rate
                except Exception:
                    pass  # fall back to 0

            # Calculate row amount
            row.amount = flt(row.qty) * flt(row.basic_rate)

    def _calculate_totals(self):
        direction = SE_TYPE_DIRECTION.get(self.stock_entry_type, {})
        outgoing = sum(flt(r.amount) for r in self.items if direction.get("s"))
        incoming = sum(flt(r.amount) for r in self.items if direction.get("t"))
        self.total_outgoing_value = outgoing
        self.total_incoming_value = incoming
        self.value_difference = incoming - outgoing

    # ── Submit ────────────────────────────────────────────────────────────────

    def on_submit(self):
        self._make_sle()
        self._post_gl_entries()   # Audit-4: link inventory to accounting

    def _make_sle(self):
        direction = SE_TYPE_DIRECTION.get(self.stock_entry_type, {})

        for row in self.items:
            rate = flt(row.basic_rate)

            # Outgoing SLE (from source warehouse)
            if direction.get("s") and row.s_warehouse:
                self._create_sle(
                    item_code=row.item_code,
                    warehouse=row.s_warehouse,
                    actual_qty=-flt(row.qty),
                    incoming_rate=0,
                    valuation_rate=rate,
                    stock_value_difference=-flt(row.amount),
                )

            # Incoming SLE (into target warehouse)
            if direction.get("t") and row.t_warehouse:
                self._create_sle(
                    item_code=row.item_code,
                    warehouse=row.t_warehouse,
                    actual_qty=flt(row.qty),
                    incoming_rate=rate,
                    valuation_rate=rate,
                    stock_value_difference=flt(row.amount),
                )

        frappe.db.commit()

    def _create_sle(self, item_code, warehouse, actual_qty,
                    incoming_rate, valuation_rate, stock_value_difference):
        # Compute qty_after_transaction from current Bin
        current_qty = flt(
            frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse}, "actual_qty")
        )
        qty_after = current_qty + actual_qty

        sle = frappe.get_doc({
            "doctype": "Stock Ledger Entry",
            "item_code": item_code,
            "warehouse": warehouse,
            "posting_date": self.posting_date,
            "posting_time": self.posting_time or "00:00:00",
            "voucher_type": "Stock Entry",
            "voucher_no": self.name,
            "company": self.company,
            "actual_qty": actual_qty,
            "qty_after_transaction": qty_after,
            "incoming_rate": incoming_rate,
            "valuation_rate": valuation_rate,
            "stock_value": flt(qty_after) * flt(valuation_rate),
            "stock_value_difference": stock_value_difference,
            "is_cancelled": 0,
        })
        # Pre-set name so Frappe skips the naming_series autoname lookup entirely
        sle.name = frappe.generate_hash(txt=f"{item_code}{warehouse}{frappe.utils.now()}", length=10)
        sle.flags.ignore_links = True
        sle.flags.ignore_mandatory = True
        sle.insert(ignore_permissions=True)
        self._sync_bin(item_code, warehouse, qty_after, valuation_rate)

    def _sync_bin(self, item_code, warehouse, new_qty, valuation_rate, _=None):
        """Create or update the Bin record for item+warehouse after an SLE."""
        bin_name = frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse})
        new_value = flt(new_qty) * flt(valuation_rate)
        if bin_name:
            old_reserved = flt(frappe.db.get_value("Bin", bin_name, "reserved_qty"))
            old_ordered  = flt(frappe.db.get_value("Bin", bin_name, "ordered_qty"))
            frappe.db.set_value("Bin", bin_name, {
                "actual_qty":     new_qty,
                "stock_value":    new_value,
                "valuation_rate": valuation_rate if new_qty else 0,
                "projected_qty":  new_qty + old_ordered - old_reserved,
            }, update_modified=True)
        else:
            b = frappe.get_doc({
                "doctype":        "Bin",
                "item_code":      item_code,
                "warehouse":      warehouse,
                "actual_qty":     new_qty,
                "reserved_qty":   0,
                "ordered_qty":    0,
                "projected_qty":  new_qty,
                "valuation_rate": valuation_rate if new_qty else 0,
                "stock_value":    new_value,
            })
            b.flags.ignore_links = True
            b.flags.ignore_mandatory = True
            b.insert(ignore_permissions=True)

        # Trigger reorder check after every bin update
        try:
            from zoho_books_clone.inventory.utils import check_reorder
            check_reorder(item_code, warehouse)
        except Exception:
            pass

    def _post_gl_entries(self):
        """
        Audit-4: Post GL entries so inventory movements reflect in accounting.
        Material Issue:    DR COGS / CR Inventory Asset   (stock leaves)
        Material Receipt:  DR Inventory Asset / CR Stock Adjustment  (stock arrives)
        Material Transfer: no net GL impact (value stays in inventory).
        """
        if self.stock_entry_type not in ("Material Issue", "Material Receipt", "Stock Adjustment"):
            return

        inventory_account = self._get_account_by_type("Stock")
        if not inventory_account:
            frappe.log_error(
                f"Stock Entry {self.name}: no Stock-type account found for company "
                f"'{self.company}'. GL entries skipped.",
                "Inventory GL Posting"
            )
            return

        if self.stock_entry_type == "Material Issue":
            # Stock leaving — debit COGS, credit Inventory
            # Try: "Cost of Goods Sold" → "Expense" → skip with log
            cogs_account = (
                self._get_account_by_type("Cost of Goods Sold")
                or self._get_account_by_type("Expense")
            )
            if not cogs_account:
                frappe.log_error(
                    f"Stock Entry {self.name}: no COGS or Expense account found for company "
                    f"'{self.company}'. GL entries skipped. "
                    "Create an account with type 'Cost of Goods Sold' or 'Expense'.",
                    "Inventory GL Posting"
                )
                return
            gl_map = [
                {
                    "account":      cogs_account,
                    "debit":        flt(self.total_outgoing_value),
                    "credit":       0,
                    "voucher_type": "Stock Entry",
                    "voucher_no":   self.name,
                    "posting_date": self.posting_date,
                    "company":      self.company,
                    "remarks":      f"COGS — Stock Issue {self.name}",
                },
                {
                    "account":      inventory_account,
                    "debit":        0,
                    "credit":       flt(self.total_outgoing_value),
                    "voucher_type": "Stock Entry",
                    "voucher_no":   self.name,
                    "posting_date": self.posting_date,
                    "company":      self.company,
                    "remarks":      f"Inventory reduction — Stock Issue {self.name}",
                },
            ]
        else:
            # Material Receipt — debit Inventory, credit Stock Adjustment
            adj_account = (
                self._get_account_by_type("Stock Adjustment")
                or self._get_account_by_type("Temporary")
                or inventory_account   # fallback: self-balancing on same account
            )
            gl_map = [
                {
                    "account":      inventory_account,
                    "debit":        flt(self.total_incoming_value),
                    "credit":       0,
                    "voucher_type": "Stock Entry",
                    "voucher_no":   self.name,
                    "posting_date": self.posting_date,
                    "company":      self.company,
                    "remarks":      f"Inventory addition — Stock Receipt {self.name}",
                },
                {
                    "account":      adj_account,
                    "debit":        0,
                    "credit":       flt(self.total_incoming_value),
                    "voucher_type": "Stock Entry",
                    "voucher_no":   self.name,
                    "posting_date": self.posting_date,
                    "company":      self.company,
                    "remarks":      f"Stock received — {self.name}",
                },
            ]

        try:
            from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import (
                make_gl_entries,
            )
            make_gl_entries(gl_map)
        except Exception as exc:
            # GL failure must not roll back the stock movement itself.
            # Log and alert; the accountant can reconcile manually.
            frappe.log_error(
                f"Stock Entry {self.name}: GL posting failed — {exc}",
                "Inventory GL Posting"
            )
            frappe.msgprint(
                _(
                    "Stock updated, but GL entries could not be posted automatically. "
                    "Please post a Journal Entry manually for {0}."
                ).format(self.name),
                indicator="orange",
                alert=True,
            )

    def _get_account_by_type(self, account_type: str) -> str | None:
        """Return the name of the first leaf account of the given type for this company."""
        row = frappe.db.get_value(
            "Account",
            {"account_type": account_type, "company": self.company, "is_group": 0},
            "name",
        )
        return row or None

    # ── Cancel ────────────────────────────────────────────────────────────────

    def on_cancel(self):
        self._reverse_sle()
        # Reverse GL entries that were posted on submit
        try:
            from zoho_books_clone.accounts.accounting_engine import reverse_voucher
            reverse_voucher("Stock Entry", self.name)
        except Exception:
            pass   # GL reversal is best-effort; stock reversal is the primary action

    def _reverse_sle(self):
        sles = frappe.get_all(
            "Stock Ledger Entry",
            filters={"voucher_type": "Stock Entry", "voucher_no": self.name, "is_cancelled": 0},
            fields=["name", "item_code", "warehouse", "actual_qty", "valuation_rate",
                    "stock_value_difference", "posting_date"],
        )
        for sle in sles:
            # Mark original as cancelled
            frappe.db.set_value("Stock Ledger Entry", sle.name, "is_cancelled", 1)

            # Create reversal entry
            current_qty = flt(
                frappe.db.get_value("Bin", {"item_code": sle.item_code, "warehouse": sle.warehouse}, "actual_qty")
            )
            rev_qty = -flt(sle.actual_qty)
            qty_after = current_qty + rev_qty

            rev = frappe.get_doc({
                "doctype": "Stock Ledger Entry",
                "item_code": sle.item_code,
                "warehouse": sle.warehouse,
                "posting_date": sle.posting_date,
                "posting_time": "00:00:01",
                "voucher_type": "Stock Entry",
                "voucher_no": self.name,
                "company": self.company,
                "actual_qty": rev_qty,
                "qty_after_transaction": qty_after,
                "incoming_rate": 0,
                "valuation_rate": flt(sle.valuation_rate),
                "stock_value": flt(qty_after) * flt(sle.valuation_rate),
                "stock_value_difference": -flt(sle.stock_value_difference),
                "is_cancelled": 0,
            })
            rev.name = frappe.generate_hash(txt=f"{sle.item_code}{sle.warehouse}{frappe.utils.now()}rev", length=10)
            rev.flags.ignore_links = True
            rev.flags.ignore_mandatory = True
            rev.insert(ignore_permissions=True)
            self._sync_bin(sle.item_code, sle.warehouse, qty_after, flt(sle.valuation_rate))

        frappe.db.commit()
