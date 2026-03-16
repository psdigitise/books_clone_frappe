import frappe
from frappe import _
from frappe.utils import flt, today, getdate
from frappe.model.document import Document
from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import make_gl_entries
from zoho_books_clone.db.validators import (
    validate_fiscal_year, validate_account_company, validate_account_type
)


class PurchaseInvoice(Document):

    def validate(self):
        if not self.items:
            frappe.throw(_("Please add at least one item"))
        for item in self.items:
            item.amount = round(flt(item.qty) * flt(item.rate), 2)
        self.calculate_totals()
        self.set_outstanding_amount()
        self.validate_accounts()
        self.set_status()
        if self.posting_date and self.company:
            self.fiscal_year = validate_fiscal_year(self.posting_date, self.company)

    def calculate_totals(self):
        net = sum(flt(i.qty) * flt(i.rate) for i in self.items)
        for tax in (self.taxes or []):
            if flt(tax.rate) and not flt(tax.tax_amount):
                tax.tax_amount = round(net * flt(tax.rate) / 100, 2)
        tax_total = sum(flt(t.tax_amount) for t in (self.taxes or []))
        self.net_total   = round(net, 2)
        self.total_tax   = round(tax_total, 2)
        self.grand_total = round(net + tax_total, 2)

    def set_outstanding_amount(self):
        if self.is_new() or not self.name or self.name.startswith("new-"):
            self.outstanding_amount = self.grand_total
        elif flt(self.outstanding_amount) == 0 and self.docstatus == 0:
            self.outstanding_amount = self.grand_total

    def validate_accounts(self):
        if self.credit_to:
            validate_account_company(self.credit_to, self.company)
            validate_account_type(self.credit_to, ["Payable"])
        if self.expense_account:
            validate_account_company(self.expense_account, self.company)
            validate_account_type(self.expense_account, ["Expense"])

    def set_status(self):
        if self.docstatus == 2:   self.status = "Cancelled"
        elif self.docstatus == 1:
            if flt(self.outstanding_amount) <= 0:                            self.status = "Paid"
            elif flt(self.outstanding_amount) < flt(self.grand_total):       self.status = "Partly Paid"
            elif self.due_date and getdate(self.due_date) < getdate(today()): self.status = "Overdue"
            else:                                                             self.status = "Submitted"
        else:
            self.status = "Draft"

    def on_submit(self):
        self.status = "Submitted"
        self.outstanding_amount = self.grand_total
        self._make_gl_entries()

    def _make_gl_entries(self):
        if not self.credit_to:
            frappe.throw(_("Please set the 'Credit To' (Accounts Payable) account"))
        if not self.expense_account:
            frappe.throw(_("Please set the 'Expense Account'"))
        gl_map = [
            {
                "account":      self.expense_account,
                "debit":        self.grand_total,
                "credit":       0,
                "voucher_type": self.doctype,
                "voucher_no":   self.name,
                "posting_date": self.posting_date,
                "company":      self.company,
                "fiscal_year":  self.fiscal_year,
                "remarks":      f"Expense from Bill {self.name}",
            },
            {
                "account":      self.credit_to,
                "debit":        0,
                "credit":       self.grand_total,
                "voucher_type": self.doctype,
                "voucher_no":   self.name,
                "posting_date": self.posting_date,
                "party_type":   "Supplier",
                "party":        self.supplier,
                "company":      self.company,
                "fiscal_year":  self.fiscal_year,
                "remarks":      f"Payable to {self.supplier} for Bill {self.name}",
            },
        ]
        make_gl_entries(gl_map)

    def on_cancel(self):
        self.status = "Cancelled"
        self.outstanding_amount = 0
        make_gl_entries([{"voucher_type": self.doctype, "voucher_no": self.name}], cancel=True)
