# Copyright (c) 2026
import frappe
from frappe import _
from frappe.utils import flt
from frappe.model.document import Document
from zoho_books_clone.accounts.accounting_engine import post_journal_entry, reverse_voucher


class JournalEntry(Document):

    def validate(self):
        if not self.accounts:
            frappe.throw(_("Journal Entry must have at least one account row."))
        total_debit  = sum(flt(r.debit)  for r in self.accounts)
        total_credit = sum(flt(r.credit) for r in self.accounts)
        if abs(total_debit - total_credit) > 0.01:
            frappe.throw(_(
                "Journal Entry is not balanced — "
                "Total Debit {0} ≠ Total Credit {1}."
            ).format(
                frappe.bold(f"₹{total_debit:,.2f}"),
                frappe.bold(f"₹{total_credit:,.2f}"),
            ))

    def on_submit(self):
        post_journal_entry(self)
        self.db_set("status", "Submitted", update_modified=False)

    def on_cancel(self):
        reverse_voucher(self.doctype, self.name)
        self.db_set("status", "Cancelled", update_modified=False)
