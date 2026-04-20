import frappe
from frappe.utils import flt, today
from frappe.model.document import Document


class BankAccount(Document):

    def after_insert(self):
        self._post_opening_gl()

    def on_update(self):
        # Only post opening GL once — when a gl_account is newly linked
        if self.gl_account and not frappe.db.exists(
            "General Ledger Entry",
            {"voucher_type": "Bank Account", "voucher_no": self.name}
        ):
            self._post_opening_gl()

    def _post_opening_gl(self):
        opening = flt(self.opening_balance)
        if not opening or not self.gl_account:
            return

        # Suspense / Equity account for the other leg
        suspense = frappe.db.get_value(
            "Account",
            {"account_type": ["in", ["Equity", "Temporary", "Stock Adjustment"]], "is_group": 0, "company": self.company or ""},
            "name"
        ) or self.gl_account  # self-balancing fallback

        gl_map = [
            {
                "account":      self.gl_account,
                "debit":        opening,
                "credit":       0,
                "voucher_type": "Bank Account",
                "voucher_no":   self.name,
                "posting_date": today(),
                "company":      self.company or "",
                "remarks":      f"Opening balance — {self.account_name or self.name}",
            },
            {
                "account":      suspense,
                "debit":        0,
                "credit":       opening,
                "voucher_type": "Bank Account",
                "voucher_no":   self.name,
                "posting_date": today(),
                "company":      self.company or "",
                "remarks":      f"Opening balance contra — {self.account_name or self.name}",
            },
        ]
        try:
            from zoho_books_clone.accounts.doctype.general_ledger_entry.general_ledger_entry import make_gl_entries
            make_gl_entries(gl_map)
        except Exception as e:
            frappe.log_error(f"Bank Account {self.name}: opening GL failed — {e}", "Bank GL")
