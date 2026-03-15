from frappe.model.document import Document
from frappe.utils import flt

class SalesInvoiceItem(Document):
    def validate(self):
        self.amount = round(flt(self.qty) * flt(self.rate), 2)
