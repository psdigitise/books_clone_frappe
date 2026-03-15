import frappe
from frappe import _
from frappe.utils import flt, today, getdate
from frappe.model.document import Document
from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import make_gl_entries


class PurchaseInvoice(Document):
    def validate(self):
        if not self.items:
            frappe.throw(_("Please add at least one item"))
        self.calculate_totals()
        self.set_status()

    def calculate_totals(self):
        net = sum(flt(i.qty) * flt(i.rate) for i in self.items)
        tax = sum(flt(t.tax_amount) for t in (self.taxes or []))
        self.net_total        = round(net, 2)
        self.total_tax        = round(tax, 2)
        self.grand_total      = round(net + tax, 2)
        self.outstanding_amount = self.outstanding_amount or self.grand_total

    def set_status(self):
        if self.docstatus == 0:   self.status = "Draft"
        elif self.docstatus == 2: self.status = "Cancelled"
        elif flt(self.outstanding_amount) <= 0: self.status = "Paid"
        elif flt(self.outstanding_amount) < flt(self.grand_total): self.status = "Partly Paid"
        elif self.due_date and getdate(self.due_date) < getdate(today()): self.status = "Overdue"
        else: self.status = "Submitted"

    def on_submit(self):
        self.status = "Submitted"
        self._make_gl_entries()

    def on_cancel(self):
        self.status = "Cancelled"
        make_gl_entries([{"voucher_type":"Purchase Invoice","voucher_no":self.name}], cancel=True)

    def _make_gl_entries(self):
        if not self.credit_to or not self.expense_account:
            frappe.throw(_("Please set Credit To and Expense Account"))
        gl_map = [
            {"account": self.expense_account, "debit": self.grand_total, "credit": 0,
             "voucher_type":"Purchase Invoice","voucher_no":self.name,
             "posting_date":self.posting_date,"company":self.company},
            {"account": self.credit_to, "debit": 0, "credit": self.grand_total,
             "voucher_type":"Purchase Invoice","voucher_no":self.name,
             "posting_date":self.posting_date,"party_type":"Supplier","party":self.supplier,
             "company":self.company},
        ]
        make_gl_entries(gl_map)


def on_submit(doc, method=None): doc._make_gl_entries()
def on_cancel(doc, method=None):
    make_gl_entries([{"voucher_type":"Purchase Invoice","voucher_no":doc.name}], cancel=True)
