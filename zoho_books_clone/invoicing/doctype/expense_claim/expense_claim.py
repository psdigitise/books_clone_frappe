import frappe
from frappe import _
from frappe.utils import flt, nowdate
from frappe.model.document import Document
from zoho_books_clone.accounts.accounting_engine import post_expense_claim, reverse_voucher


class ExpenseClaim(Document):

    def validate(self):
        if not self.claim_date:
            self.claim_date = nowdate()
        if not self.expenses:
            frappe.throw(_("Please add at least one expense line"))
        for row in self.expenses:
            if flt(row.amount) <= 0:
                frappe.throw(_("Amount in row {0} must be greater than 0").format(row.idx))
        self.total_claimed_amount = round(
            sum(flt(r.amount) for r in self.expenses), 2
        )

    def on_submit(self):
        self.db_set("status", "Submitted")
        # GL posting happens on Approve (via whitelisted API), not on submit,
        # because the claim still needs manager sign-off.

    def on_cancel(self):
        self.db_set("status", "Cancelled")
        if frappe.db.exists(
            "General Ledger Entry",
            {"voucher_type": self.doctype, "voucher_no": self.name, "is_cancelled": 0}
        ):
            reverse_voucher(self.doctype, self.name)

    @frappe.whitelist()
    def approve(self):
        """Approve the claim and post GL entries."""
        if self.status not in ("Submitted",):
            frappe.throw(_("Only Submitted claims can be approved"))
        if not self.payable_account:
            frappe.throw(_("Please set a Payable Account before approving"))
        self.db_set("status", "Approved")
        self.db_set("approved_by", frappe.session.user)
        post_expense_claim(self)

    @frappe.whitelist()
    def reject(self):
        """Reject the claim."""
        if self.status not in ("Submitted",):
            frappe.throw(_("Only Submitted claims can be rejected"))
        self.db_set("status", "Rejected")

    @frappe.whitelist()
    def mark_paid(self):
        """Mark approved claim as paid."""
        if self.status != "Approved":
            frappe.throw(_("Only Approved claims can be marked Paid"))
        self.db_set("status", "Paid")
