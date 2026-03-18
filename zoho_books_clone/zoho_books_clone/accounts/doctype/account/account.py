import frappe
from frappe import _
from frappe.utils import flt
from frappe.model.document import Document


class Account(Document):
    def validate(self):
        self.validate_parent()
        if not self.parent_account and not self.is_group:
            frappe.throw(_("Root Account must be a group account"))

    def validate_parent(self):
        if self.parent_account:
            parent = frappe.get_doc("Account", self.parent_account)
            if not parent.is_group:
                frappe.throw(_("Parent Account {0} must be a group").format(self.parent_account))

    def on_update(self):
        self._update_parent_balance()

    def _update_parent_balance(self):
        if not self.parent_account:
            return
        children = frappe.get_all("Account", {"parent_account": self.parent_account}, ["balance"])
        total = sum(flt(c.balance) for c in children)
        frappe.db.set_value("Account", self.parent_account, "balance", total)

    @frappe.whitelist(methods=["GET", "POST"])
    def get_account_balance(self):
        res = frappe.db.sql("""
            SELECT SUM(debit) AS d, SUM(credit) AS c
            FROM `tabGeneral Ledger Entry`
            WHERE account = %s AND docstatus = 1
        """, self.name, as_dict=True)[0]
        debit, credit = flt(res.d), flt(res.c)
        return {"debit": debit, "credit": credit, "balance": debit - credit}
