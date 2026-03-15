import frappe
from frappe import _
from frappe.utils import flt
from frappe.model.document import Document
from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import make_gl_entries


class PaymentEntry(Document):
    def validate(self):
        if flt(self.paid_amount) <= 0:
            frappe.throw(_("Paid Amount must be greater than 0"))
        self.validate_references()

    def validate_references(self):
        total_allocated = sum(flt(r.allocated_amount) for r in (self.references or []))
        if total_allocated > flt(self.paid_amount):
            frappe.throw(_("Total allocated amount {0} cannot exceed paid amount {1}").format(
                total_allocated, self.paid_amount))

    def on_submit(self):
        self._make_gl_entries()
        self._update_invoice_outstanding()

    def on_cancel(self):
        make_gl_entries([{"voucher_type":"Payment Entry","voucher_no":self.name}], cancel=True)
        self._update_invoice_outstanding(cancel=True)

    def _make_gl_entries(self):
        gl_map = []
        if self.payment_type == "Receive":
            gl_map = [
                {"account":self.paid_to,"debit":self.paid_amount,"credit":0,
                 "voucher_type":"Payment Entry","voucher_no":self.name,
                 "posting_date":self.payment_date,"company":self.company},
                {"account":self.paid_from,"debit":0,"credit":self.paid_amount,
                 "voucher_type":"Payment Entry","voucher_no":self.name,
                 "posting_date":self.payment_date,"party_type":self.party_type,
                 "party":self.party,"company":self.company},
            ]
        elif self.payment_type == "Pay":
            gl_map = [
                {"account":self.paid_from,"debit":self.paid_amount,"credit":0,
                 "voucher_type":"Payment Entry","voucher_no":self.name,
                 "posting_date":self.payment_date,"party_type":self.party_type,
                 "party":self.party,"company":self.company},
                {"account":self.paid_to,"debit":0,"credit":self.paid_amount,
                 "voucher_type":"Payment Entry","voucher_no":self.name,
                 "posting_date":self.payment_date,"company":self.company},
            ]
        make_gl_entries(gl_map)

    def _update_invoice_outstanding(self, cancel=False):
        for ref in (self.references or []):
            dt  = ref.reference_doctype
            dn  = ref.reference_name
            amt = flt(ref.allocated_amount)
            current = flt(frappe.db.get_value(dt, dn, "outstanding_amount"))
            new_amt  = current + amt if cancel else current - amt
            frappe.db.set_value(dt, dn, "outstanding_amount", new_amt)
            # Update status
            doc = frappe.get_doc(dt, dn)
            doc.set_status()
            doc.db_update()


def on_submit(doc, method=None): doc._make_gl_entries(); doc._update_invoice_outstanding()
def on_cancel(doc, method=None):
    make_gl_entries([{"voucher_type":"Payment Entry","voucher_no":doc.name}], cancel=True)
    doc._update_invoice_outstanding(cancel=True)
