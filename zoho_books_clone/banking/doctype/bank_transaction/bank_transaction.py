import frappe
from frappe.model.document import Document

class BankTransaction(Document):
    def validate(self):
        self.set_balance()

    def set_balance(self):
        from frappe.utils import flt
        last = frappe.db.sql("""
            SELECT balance FROM `tabBank Transaction`
            WHERE bank_account=%s AND date<=%s AND name!=%s AND docstatus=1
            ORDER BY date DESC, creation DESC LIMIT 1
        """, (self.bank_account, self.date, self.name or ""), as_dict=True)
        prev = flt(last[0].balance) if last else 0
        self.balance = prev + flt(self.credit) - flt(self.debit)
