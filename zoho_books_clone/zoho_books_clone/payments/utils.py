import frappe
from frappe import _
from frappe.utils import flt, nowdate


@frappe.whitelist()
def get_outstanding_invoices(party_type: str, party: str) -> list[dict]:
    """Return all unpaid invoices for a party."""
    dt = "Sales Invoice" if party_type == "Customer" else "Purchase Invoice"
    party_field = "customer" if dt == "Sales Invoice" else "supplier"
    return frappe.get_all(
        dt,
        filters={party_field: party, "docstatus": 1, "outstanding_amount": [">", 0]},
        fields=["name", "grand_total", "outstanding_amount", "posting_date", "due_date"],
        order_by="due_date asc",
    )


@frappe.whitelist()
def make_payment_entry_from_invoice(
    source_name: str,
    paid_amount:     float | None = None,
    payment_date:    str   | None = None,
    mode_of_payment: str   | None = None,
    reference_no:    str   | None = None,
    paid_to:         str   | None = None,
) -> str:
    """
    Create and submit a Payment Entry for a Sales Invoice.
    Returns the new Payment Entry name.
    """
    invoice = frappe.get_doc("Sales Invoice", source_name)
    if invoice.docstatus != 1:
        frappe.throw(_("Invoice {0} must be submitted before recording a payment").format(source_name))

    amount = flt(paid_amount or invoice.outstanding_amount)
    if amount <= 0:
        frappe.throw(_("Payment amount must be greater than 0"))
    if amount > flt(invoice.outstanding_amount):
        frappe.throw(_(
            "Payment amount {0} cannot exceed outstanding amount {1}"
        ).format(amount, invoice.outstanding_amount))

    # Determine paid_from (Accounts Receivable account)
    paid_from = invoice.debit_to or frappe.db.get_value(
        "Account", {"account_type": "Receivable", "company": invoice.company, "is_group": 0}, "name"
    )
    if not paid_from:
        frappe.throw(_("No Receivable account found for company {0}").format(invoice.company))

    pe = frappe.new_doc("Payment Entry")
    pe.update({
        "payment_type":    "Receive",
        "payment_date":    payment_date or nowdate(),
        "party_type":      "Customer",
        "party":           invoice.customer,
        "party_name":      invoice.customer_name,
        "paid_from":       paid_from,
        "paid_to":         paid_to,
        "paid_amount":     amount,
        "currency":        invoice.currency or "INR",
        "mode_of_payment": mode_of_payment or "Bank Transfer",
        "reference_no":    reference_no or "",
        "company":         invoice.company,
        "remarks":         f"Payment against Invoice {source_name}",
    })
    pe.append("references", {
        "reference_doctype": "Sales Invoice",
        "reference_name":    source_name,
        "outstanding_amount": invoice.outstanding_amount,
        "allocated_amount":   amount,
    })
    pe.flags.ignore_permissions = True
    pe.insert()
    pe.submit()
    return pe.name


@frappe.whitelist()
def make_payment_entry_from_purchase_invoice(
    source_name: str,
    paid_amount:     float | None = None,
    payment_date:    str   | None = None,
    mode_of_payment: str   | None = None,
    reference_no:    str   | None = None,
    paid_from:       str   | None = None,
) -> str:
    """
    Create and submit a Payment Entry for a Purchase Invoice.
    Returns the new Payment Entry name.
    """
    invoice = frappe.get_doc("Purchase Invoice", source_name)
    if invoice.docstatus != 1:
        frappe.throw(_("Bill {0} must be submitted before recording a payment").format(source_name))

    amount = flt(paid_amount or invoice.outstanding_amount)
    if amount <= 0:
        frappe.throw(_("Payment amount must be greater than 0"))

    # Determine paid_to (Accounts Payable account)
    paid_to = invoice.credit_to or frappe.db.get_value(
        "Account", {"account_type": "Payable", "company": invoice.company, "is_group": 0}, "name"
    )
    if not paid_to:
        frappe.throw(_("No Payable account found for company {0}").format(invoice.company))

    if not paid_from:
        paid_from = frappe.db.get_value(
            "Account", {"account_type": ["in", ["Bank", "Cash"]], "company": invoice.company, "is_group": 0}, "name"
        )
        if not paid_from:
            frappe.throw(_("No Bank/Cash account found. Please specify the account to pay from."))

    pe = frappe.new_doc("Payment Entry")
    pe.update({
        "payment_type":    "Pay",
        "payment_date":    payment_date or nowdate(),
        "party_type":      "Supplier",
        "party":           invoice.supplier,
        "party_name":      invoice.supplier_name,
        "paid_from":       paid_from,
        "paid_to":         paid_to,
        "paid_amount":     amount,
        "currency":        invoice.currency or "INR",
        "mode_of_payment": mode_of_payment or "Bank Transfer",
        "reference_no":    reference_no or "",
        "company":         invoice.company,
        "remarks":         f"Payment against Bill {source_name}",
    })
    pe.append("references", {
        "reference_doctype": "Purchase Invoice",
        "reference_name":    source_name,
        "outstanding_amount": invoice.outstanding_amount,
        "allocated_amount":   amount,
    })
    pe.flags.ignore_permissions = True
    pe.insert()
    pe.submit()
    return pe.name
