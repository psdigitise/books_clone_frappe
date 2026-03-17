import frappe
from frappe import _
from frappe.model.document import Document


class FiscalYear(Document):
    def validate(self):
        if self.year_start_date >= self.year_end_date:
            frappe.throw(_("End Date must be after Start Date"))
        self.validate_overlap()

    def validate_overlap(self):
        overlap = frappe.db.sql("""
            SELECT name FROM `tabFiscal Year`
            WHERE name != %s
              AND company = %s
              AND is_closed = 0
              AND year_start_date <= %s
              AND year_end_date >= %s
        """, (self.name, self.company, self.year_end_date, self.year_start_date))
        if overlap:
            frappe.throw(_("Fiscal Year overlaps with {0}").format(overlap[0][0]))
