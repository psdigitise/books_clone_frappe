import frappe
from frappe import _
from frappe.utils import flt, today, getdate
from frappe.model.document import Document
from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import make_gl_entries


class SalesInvoice(Document):
    # ── Validation ─────────────────────────────────────────────────────────
    def validate(self):
        self.validate_items()
        self.calculate_totals()
        self.set_status()
        self.set_due_date()

    def validate_items(self):
        if not self.items:
            frappe.throw(_("Please add at least one item"))
        for item in self.items:
            if flt(item.qty) <= 0:
                frappe.throw(_("Qty must be greater than 0 for item {0}").format(item.item_name))
            if flt(item.rate) < 0:
                frappe.throw(_("Rate cannot be negative for item {0}").format(item.item_name))

    def calculate_totals(self):
        net = sum(flt(i.qty) * flt(i.rate) for i in self.items)
        tax = sum(flt(t.tax_amount) for t in (self.taxes or []))
        self.net_total        = round(net, 2)
        self.total_tax        = round(tax, 2)
        self.grand_total      = round(net + tax, 2)
        self.outstanding_amount = self.outstanding_amount or self.grand_total

    def set_status(self):
        if self.docstatus == 0:
            self.status = "Draft"
        elif self.docstatus == 2:
            self.status = "Cancelled"
        elif flt(self.outstanding_amount) <= 0:
            self.status = "Paid"
        elif flt(self.outstanding_amount) < flt(self.grand_total):
            self.status = "Partly Paid"
        elif self.due_date and getdate(self.due_date) < getdate(today()):
            self.status = "Overdue"
        else:
            self.status = "Submitted"

    def set_due_date(self):
        if not self.due_date:
            self.due_date = self.posting_date

    # ── Submit / Cancel ────────────────────────────────────────────────────
    def on_submit(self):
        self.status = "Submitted"
        self.make_gl_entries()

    def on_cancel(self):
        self.status = "Cancelled"
        self.cancel_gl_entries()

    def make_gl_entries(self):
        if not self.debit_to or not self.income_account:
            frappe.throw(_("Please set Debit To and Income Account before submitting"))

        gl_map = [
            {   # Debit Accounts Receivable
                "account":      self.debit_to,
                "debit":        self.grand_total,
                "credit":       0,
                "voucher_type": "Sales Invoice",
                "voucher_no":   self.name,
                "posting_date": self.posting_date,
                "party_type":   "Customer",
                "party":        self.customer,
                "company":      self.company,
                "remarks":      f"Invoice {self.name}",
            },
            {   # Credit Income
                "account":      self.income_account,
                "debit":        0,
                "credit":       self.net_total,
                "voucher_type": "Sales Invoice",
                "voucher_no":   self.name,
                "posting_date": self.posting_date,
                "company":      self.company,
                "remarks":      f"Invoice {self.name}",
            },
        ]
        # Tax entries
        for tax in (self.taxes or []):
            if flt(tax.tax_amount):
                gl_map.append({
                    "account":      tax.account_head,
                    "debit":        0,
                    "credit":       flt(tax.tax_amount),
                    "voucher_type": "Sales Invoice",
                    "voucher_no":   self.name,
                    "posting_date": self.posting_date,
                    "company":      self.company,
                    "remarks":      f"Tax – {tax.description}",
                })
        make_gl_entries(gl_map)

    def cancel_gl_entries(self):
        make_gl_entries(
            [{"voucher_type": "Sales Invoice", "voucher_no": self.name}],
            cancel=True,
        )

    # ── Whitelisted APIs ───────────────────────────────────────────────────
    @frappe.whitelist()
    def send_invoice_email(self):
        """Send invoice PDF to customer email."""
        customer_email = frappe.db.get_value("Customer", self.customer, "email_id")
        if not customer_email:
            frappe.throw(_("Customer does not have an email address"))
        frappe.sendmail(
            recipients=[customer_email],
            subject=f"Invoice {self.name}",
            message=f"Dear {self.customer_name},<br>Please find your invoice attached.",
            attachments=[frappe.attach_print(self.doctype, self.name, print_format="Sales Invoice")],
        )
        frappe.msgprint(_("Invoice sent to {0}").format(customer_email))


# ── Module-level hooks (called from hooks.py) ──────────────────────────────
def on_submit(doc, method=None):
    doc.make_gl_entries()

def on_cancel(doc, method=None):
    doc.cancel_gl_entries()
