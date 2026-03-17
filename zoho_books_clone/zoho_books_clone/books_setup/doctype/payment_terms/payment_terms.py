import frappe
from frappe import _
from frappe.utils import add_days, add_months, get_last_day
from frappe.model.document import Document

class PaymentTerms(Document):
    def validate(self):
        if self.credit_days < 0:
            frappe.throw(_("Credit Days cannot be negative"))

def get_due_date(payment_terms_name: str, posting_date: str) -> str:
    """Calculate due date from payment terms."""
    if not payment_terms_name:
        return posting_date
    pt = frappe.get_doc("Payment Terms", payment_terms_name)
    basis = pt.due_date_based_on or "Day(s) after invoice date"
    if "after invoice date" in basis:
        return add_days(posting_date, int(pt.credit_days or 30))
    elif "end of the invoice month" in basis and "Day" in basis:
        return add_days(get_last_day(posting_date), int(pt.credit_days or 0))
    elif "Month" in basis:
        return add_months(get_last_day(posting_date), int(pt.credit_months or 1))
    return add_days(posting_date, int(pt.credit_days or 30))
