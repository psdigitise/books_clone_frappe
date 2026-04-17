import frappe
from frappe import _
from frappe.utils import flt
from frappe.model.document import Document


class Account(Document):
    def validate(self):
        self.validate_parent()
        if not self.parent_account and not self.is_group:
            frappe.throw(_("Root Account must be a group account"))
        self._lock_after_usage()

    def validate_parent(self):
        if self.parent_account:
            parent = frappe.get_doc("Account", self.parent_account)
            if not parent.is_group:
                frappe.throw(_("Parent Account {0} must be a group").format(self.parent_account))

    def _lock_after_usage(self):
        """Prevent renaming account_type or account_name once GL entries exist."""
        if self.is_new():
            return
        old = self.get_doc_before_save()
        if not old:
            return
        if not self._has_gl_entries():
            return
        locked_fields = {
            "account_name": "Account Name",
            "account_type": "Account Type",
            "currency": "Currency",
            "is_group": "Is Group",
        }
        for field, label in locked_fields.items():
            if getattr(old, field, None) != getattr(self, field, None):
                frappe.throw(_(
                    "Cannot change '{0}' on account <b>{1}</b> because it already has "
                    "General Ledger entries. Create a new account instead."
                ).format(label, self.name))

    def before_delete(self):
        """Block deletion of accounts that have GL entries."""
        if self._has_gl_entries():
            frappe.throw(_(
                "Cannot delete account <b>{0}</b> because it has General Ledger entries. "
                "You can disable it instead."
            ).format(self.name))

    def _has_gl_entries(self):
        return frappe.db.exists("General Ledger Entry", {"account": self.name})

    def on_update(self):
        self._update_parent_balance()

    def _update_parent_balance(self):
        if not self.parent_account:
            return
        children = frappe.get_all("Account", {"parent_account": self.parent_account}, ["balance"])
        total = sum(flt(c.balance) for c in children)
        frappe.db.set_value("Account", self.parent_account, "balance", total)

    @frappe.whitelist()
    def get_account_balance(self):
        res = frappe.db.sql("""
            SELECT SUM(debit) AS d, SUM(credit) AS c
            FROM `tabGeneral Ledger Entry`
            WHERE account = %s AND docstatus = 1
        """, self.name, as_dict=True)[0]
        debit, credit = flt(res.d), flt(res.c)
        return {"debit": debit, "credit": credit, "balance": debit - credit}
