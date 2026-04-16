import frappe
from frappe import _
from frappe.utils import flt, nowdate
from frappe.model.document import Document
from zoho_books_clone.accounts.accounting_engine import post_payment_entry, reverse_voucher
from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import recompute_outstanding_from_gl
from zoho_books_clone.db.validators import validate_account_company, validate_account_type


class PaymentEntry(Document):

    def validate(self):
        if flt(self.paid_amount) <= 0:
            frappe.throw(_("Paid Amount must be greater than 0"))
        if not self.payment_date:
            self.payment_date = nowdate()
        self.validate_accounts()
        self.validate_references()

    def validate_accounts(self):
        if self.paid_from and not frappe.db.exists("Account", self.paid_from):
            frappe.throw(_("'Paid From' account {0} does not exist").format(self.paid_from))
        if self.paid_to and not frappe.db.exists("Account", self.paid_to):
            frappe.throw(_("'Paid To' account {0} does not exist").format(self.paid_to))

        # P1/Issue 7 — enforce correct account types per payment direction
        if self.company:
            for acct in filter(None, [self.paid_from, self.paid_to]):
                validate_account_company(acct, self.company)

        if self.paid_from and self.paid_to:
            if self.payment_type == "Receive":
                # Customer pays us: paid_from = Receivable, paid_to = Bank/Cash
                validate_account_type(self.paid_from, ["Receivable"])
                validate_account_type(self.paid_to,   ["Bank", "Cash"])
            elif self.payment_type == "Pay":
                # We pay supplier: paid_from = Bank/Cash, paid_to = Payable
                validate_account_type(self.paid_from, ["Bank", "Cash"])
                validate_account_type(self.paid_to,   ["Payable"])

    def validate_references(self):
        total_allocated = sum(flt(r.allocated_amount) for r in (self.references or []))
        if total_allocated > flt(self.paid_amount):
            frappe.throw(_(
                "Total allocated {0} exceeds paid amount {1}"
            ).format(total_allocated, self.paid_amount))
        for ref in (self.references or []):
            outstanding = frappe.db.get_value(
                ref.reference_doctype, ref.reference_name, "outstanding_amount"
            )
            if outstanding is None:
                frappe.throw(_("Invoice {0} not found").format(ref.reference_name))
            if flt(ref.allocated_amount) > flt(outstanding):
                frappe.throw(_(
                    "Allocated amount {0} exceeds outstanding {1} for {2}"
                ).format(ref.allocated_amount, outstanding, ref.reference_name))

    def on_submit(self):
        post_payment_entry(self)
        self._update_invoice_outstanding(cancel=False)

    def on_cancel(self):
        reverse_voucher(self.doctype, self.name)
        self._update_invoice_outstanding(cancel=True)

    def _update_invoice_outstanding(self, cancel: bool = False):
        for ref in (self.references or []):
            dt  = ref.reference_doctype
            dn  = ref.reference_name

            # P2/Issue 4 — recompute from GL so the value is always consistent
            # with actual ledger entries rather than accumulated arithmetic.
            try:
                new_amt = recompute_outstanding_from_gl(dt, dn)
            except Exception:
                # Fallback to arithmetic update if GL recompute fails
                # (e.g. during first-time setup before GL entries are committed)
                amt = flt(ref.allocated_amount)
                current = flt(frappe.db.get_value(dt, dn, "outstanding_amount"))
                new_amt = (current + amt) if cancel else (current - amt)
                new_amt = max(0.0, new_amt)
                frappe.db.set_value(dt, dn, "outstanding_amount", new_amt,
                                    update_modified=False)

            _refresh_invoice_status(dt, dn, new_amt)


def _refresh_invoice_status(doctype: str, docname: str, outstanding: float):
    """Update status field on the linked invoice without triggering full save."""
    from frappe.utils import getdate, today
    doc = frappe.get_doc(doctype, docname)
    grand_total = flt(doc.grand_total)

    if outstanding <= 0:
        new_status = "Paid"
    elif outstanding < grand_total:
        new_status = "Partly Paid"
    elif doc.due_date and getdate(doc.due_date) < getdate(today()):
        new_status = "Overdue"
    else:
        new_status = "Submitted"

    frappe.db.set_value(doctype, docname, "status", new_status, update_modified=False)
