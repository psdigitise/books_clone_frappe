import frappe
from frappe import _
from frappe.utils import flt, nowdate


@frappe.whitelist()
def get_outstanding_invoices(party_type: str, party: str) -> list[dict]:
    """Return all unpaid invoices for a party (any docstatus)."""
    dt = "Sales Invoice" if party_type == "Customer" else "Purchase Invoice"
    party_field = "customer" if dt == "Sales Invoice" else "supplier"
    return frappe.get_all(
        dt,
        filters={party_field: party, "outstanding_amount": [">", 0]},
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
    Uses canonical company from the deposit (paid_to) account.
    Returns the new Payment Entry name.
    """
    invoice = frappe.get_doc("Sales Invoice", source_name)

    amount = flt(paid_amount or invoice.outstanding_amount or invoice.grand_total)
    if amount <= 0:
        frappe.throw(_("Payment amount must be greater than 0"))

    inv_company = invoice.company or frappe.defaults.get_default("company") or ""

    # Resolve paid_to (bank/cash) — canonicalize company from this account
    if not paid_to:
        rows = frappe.db.sql(
            """SELECT name FROM `tabAccount`
               WHERE account_type IN ('Bank','Cash') AND LOWER(company) = LOWER(%s)
                 AND is_group = 0 AND disabled = 0
               ORDER BY account_type DESC LIMIT 1""",
            (inv_company,), as_dict=True
        )
        paid_to = rows[0]["name"] if rows else None
    if not paid_to:
        frappe.throw(_("No Bank/Cash account found for company '{0}'").format(inv_company))

    # Derive canonical company from the paid_to account
    company = frappe.db.get_value("Account", paid_to, "company") or inv_company

    # Resolve paid_from (Receivable)
    paid_from = getattr(invoice, "debit_to", None)
    if paid_from:
        ar_co = frappe.db.get_value("Account", paid_from, "company")
        if ar_co and ar_co.lower() != company.lower():
            paid_from = None
    if not paid_from:
        rows = frappe.db.sql(
            """SELECT name FROM `tabAccount`
               WHERE account_type = 'Receivable' AND LOWER(company) = LOWER(%s)
                 AND is_group = 0 LIMIT 1""",
            (company,), as_dict=True
        )
        paid_from = rows[0]["name"] if rows else None
    if not paid_from:
        frappe.throw(_("No Receivable account found for company '{0}'").format(company))

    outstanding = flt(invoice.outstanding_amount or invoice.grand_total)

    pe = frappe.new_doc("Payment Entry")
    pe.update({
        "payment_type":    "Receive",
        "payment_date":    payment_date or nowdate(),
        "party_type":      "Customer",
        "party":           invoice.customer,
        "party_name":      invoice.customer_name or invoice.customer,
        "paid_from":       paid_from,
        "paid_to":         paid_to,
        "paid_amount":     amount,
        "received_amount": amount,
        "currency":        invoice.currency or "INR",
        "paid_from_account_currency": invoice.currency or "INR",
        "paid_to_account_currency":   invoice.currency or "INR",
        "source_exchange_rate": 1,
        "target_exchange_rate": 1,
        "mode_of_payment": mode_of_payment or "Bank Transfer",
        "reference_no":    reference_no or f"PMT-{source_name}",
        "reference_date":  payment_date or nowdate(),
        "company":         company,
        "remarks":         f"Payment against Invoice {source_name}",
    })
    pe.append("references", {
        "reference_doctype":  "Sales Invoice",
        "reference_name":     source_name,
        "due_date":           invoice.due_date,
        "total_amount":       flt(invoice.grand_total),
        "outstanding_amount": outstanding,
        "allocated_amount":   amount,
    })
    pe.flags.ignore_permissions = True
    pe.insert()
    pe.submit()
    frappe.db.commit()
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
    Uses canonical company from the source (paid_from) bank account.
    Returns the new Payment Entry name.
    """
    invoice = frappe.get_doc("Purchase Invoice", source_name)

    amount = flt(paid_amount or invoice.outstanding_amount or invoice.grand_total)
    if amount <= 0:
        frappe.throw(_("Payment amount must be greater than 0"))

    inv_company = invoice.company or frappe.defaults.get_default("company") or ""

    # Resolve paid_from (bank/cash)
    if not paid_from:
        rows = frappe.db.sql(
            """SELECT name FROM `tabAccount`
               WHERE account_type IN ('Bank','Cash') AND LOWER(company) = LOWER(%s)
                 AND is_group = 0 AND disabled = 0
               ORDER BY account_type DESC LIMIT 1""",
            (inv_company,), as_dict=True
        )
        paid_from = rows[0]["name"] if rows else None
    if not paid_from:
        frappe.throw(_("No Bank/Cash account found for company '{0}'").format(inv_company))

    # Derive canonical company from the paid_from account
    company = frappe.db.get_value("Account", paid_from, "company") or inv_company

    # Resolve paid_to (Payable)
    paid_to = getattr(invoice, "credit_to", None)
    if paid_to:
        ap_co = frappe.db.get_value("Account", paid_to, "company")
        if ap_co and ap_co.lower() != company.lower():
            paid_to = None
    if not paid_to:
        rows = frappe.db.sql(
            """SELECT name FROM `tabAccount`
               WHERE account_type = 'Payable' AND LOWER(company) = LOWER(%s)
                 AND is_group = 0 LIMIT 1""",
            (company,), as_dict=True
        )
        paid_to = rows[0]["name"] if rows else None
    if not paid_to:
        frappe.throw(_("No Payable account found for company '{0}'").format(company))

    outstanding = flt(invoice.outstanding_amount or invoice.grand_total)

    pe = frappe.new_doc("Payment Entry")
    pe.update({
        "payment_type":    "Pay",
        "payment_date":    payment_date or nowdate(),
        "party_type":      "Supplier",
        "party":           invoice.supplier,
        "party_name":      getattr(invoice, "supplier_name", invoice.supplier),
        "paid_from":       paid_from,
        "paid_to":         paid_to,
        "paid_amount":     amount,
        "received_amount": amount,
        "currency":        invoice.currency or "INR",
        "paid_from_account_currency": invoice.currency or "INR",
        "paid_to_account_currency":   invoice.currency or "INR",
        "source_exchange_rate": 1,
        "target_exchange_rate": 1,
        "mode_of_payment": mode_of_payment or "Bank Transfer",
        "reference_no":    reference_no or f"PMT-{source_name}",
        "reference_date":  payment_date or nowdate(),
        "company":         company,
        "remarks":         f"Payment against Bill {source_name}",
    })
    pe.append("references", {
        "reference_doctype":  "Purchase Invoice",
        "reference_name":     source_name,
        "due_date":           getattr(invoice, "due_date", None),
        "total_amount":       flt(invoice.grand_total),
        "outstanding_amount": outstanding,
        "allocated_amount":   amount,
    })
    pe.flags.ignore_permissions = True
    pe.insert()
    pe.submit()
    frappe.db.commit()
    return pe.name
