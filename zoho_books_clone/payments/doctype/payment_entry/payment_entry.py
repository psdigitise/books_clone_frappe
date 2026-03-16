import frappe
from frappe import _
from frappe.utils import flt, nowdate
from frappe.model.document import Document
from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import make_gl_entries


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
        self._make_gl_entries()
        self._update_invoice_outstanding(cancel=False)

    def on_cancel(self):
        make_gl_entries([{"voucher_type": self.doctype, "voucher_no": self.name}], cancel=True)
        self._update_invoice_outstanding(cancel=True)

    def _make_gl_entries(self):
        if not self.paid_from:
            frappe.throw(_("Please set the 'Paid From' account"))
        if not self.paid_to:
            frappe.throw(_("Please set the 'Paid To' account"))

        if self.payment_type == "Receive":
            # Money comes IN: debit bank/cash, credit receivable
            gl_map = [
                {
                    "account":      self.paid_to,          # Bank / Cash
                    "debit":        self.paid_amount,
                    "credit":       0,
                    "voucher_type": self.doctype,
                    "voucher_no":   self.name,
                    "posting_date": self.payment_date,
                    "company":      self.company,
                    "remarks":      f"Payment received — {self.name}",
                },
                {
                    "account":      self.paid_from,        # Receivable
                    "debit":        0,
                    "credit":       self.paid_amount,
                    "voucher_type": self.doctype,
                    "voucher_no":   self.name,
                    "posting_date": self.payment_date,
                    "party_type":   self.party_type,
                    "party":        self.party,
                    "company":      self.company,
                    "remarks":      f"Payment received from {self.party} — {self.name}",
                },
            ]
        elif self.payment_type == "Pay":
            # Money goes OUT: debit payable, credit bank/cash
            gl_map = [
                {
                    "account":      self.paid_to,          # Payable
                    "debit":        self.paid_amount,
                    "credit":       0,
                    "voucher_type": self.doctype,
                    "voucher_no":   self.name,
                    "posting_date": self.payment_date,
                    "party_type":   self.party_type,
                    "party":        self.party,
                    "company":      self.company,
                    "remarks":      f"Payment to {self.party} — {self.name}",
                },
                {
                    "account":      self.paid_from,        # Bank / Cash
                    "debit":        0,
                    "credit":       self.paid_amount,
                    "voucher_type": self.doctype,
                    "voucher_no":   self.name,
                    "posting_date": self.payment_date,
                    "company":      self.company,
                    "remarks":      f"Payment made — {self.name}",
                },
            ]
        else:
            frappe.throw(_("Payment type '{0}' not supported").format(self.payment_type))

        make_gl_entries(gl_map)

    def _update_invoice_outstanding(self, cancel: bool = False):
        for ref in (self.references or []):
            dt  = ref.reference_doctype
            dn  = ref.reference_name
            amt = flt(ref.allocated_amount)

            current = flt(frappe.db.get_value(dt, dn, "outstanding_amount"))
            new_amt = (current + amt) if cancel else (current - amt)
            new_amt = max(0, new_amt)  # never go below 0

            frappe.db.set_value(dt, dn, "outstanding_amount", new_amt, update_modified=False)

            # Update status on the invoice
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
