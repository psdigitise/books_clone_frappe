import frappe
from frappe.model.document import Document


class BooksSettings(Document):
    def validate(self):
        if self.reconcile_tolerance and float(self.reconcile_tolerance) < 0:
            frappe.throw("Reconciliation Tolerance cannot be negative")

        # Auto-detect default_company from existing Account records when not set
        if not self.default_company:
            detected = self._detect_company()
            if detected:
                self.default_company = detected
                frappe.msgprint(
                    f"Default Company auto-set to <b>{detected}</b> based on existing accounts. "
                    "You can change this in Books Settings.",
                    indicator="blue",
                    alert=True,
                )
            else:
                frappe.msgprint(
                    "Default Company is not set. Most Books features will not work correctly. "
                    "Please set a Default Company in Books Settings.",
                    indicator="orange",
                    alert=True,
                )

    def _detect_company(self) -> str:
        """Return the first company found in Account records, or empty string."""
        try:
            row = frappe.db.sql(
                "SELECT company FROM `tabAccount` "
                "WHERE company IS NOT NULL AND company != '' LIMIT 1",
                as_dict=True,
            )
            return row[0].get("company", "") if row else ""
        except Exception:
            return ""
