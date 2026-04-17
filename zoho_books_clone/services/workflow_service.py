"""
Workflow Service — Missing Business Logic Layer (Audit Part 3).

This module is the single orchestration layer that coordinates the
end-to-end business flow across Accounting, Inventory, and Payments:

  Sales flow:    Quotation → Sales Order → Delivery → Sales Invoice → Payment
  Purchase flow: Purchase Order → Material Receipt → Purchase Invoice → Payment

All functions here are whitelisted so the SPA can drive state transitions
directly via API calls.  The underlying controllers (StockEntry, GL engine,
PaymentEntry) handle the atomic sub-operations — this service just wires
them together and enforces the permitted transitions.

State machine for Sales:
  Draft → Confirmed (Sales Order)
        → Delivered  (Delivery / Stock Entry auto-created)
        → Invoiced   (Sales Invoice auto-created or linked)
        → Paid       (Payment Entry linked)
        → Cancelled  (reversal of all above)
"""

import frappe
from frappe import _
from frappe.utils import flt, today, getdate


# ─── Sales Workflow ───────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def confirm_sales_order(sales_order: str) -> dict:
    """
    Transition a Sales Order from Draft → Confirmed (submit it).
    Validates stock availability before confirming.
    Returns the updated document.
    """
    doc = _get_doc("Sales Order", sales_order, required_status="Draft")
    _check_stock_for_order(doc)
    doc.submit()
    return _order_summary(doc)


@frappe.whitelist(allow_guest=False)
def create_delivery_from_order(sales_order: str, warehouse: str = None) -> dict:
    """
    Create a Stock Entry (Material Issue) from a confirmed Sales Order,
    effectively recording delivery of goods to the customer.

    Returns {stock_entry, sales_order, items_delivered}.
    """
    doc = _get_doc("Sales Order", sales_order, required_docstatus=1)

    if doc.status not in ("Submitted", "To Deliver"):
        frappe.throw(_(
            "Sales Order {0} cannot be delivered — current status is '{1}'."
        ).format(sales_order, doc.status))

    wh = warehouse or _default_warehouse(doc.company)
    if not wh:
        frappe.throw(_("No warehouse specified and no default warehouse configured in Books Settings."))

    items = []
    for row in (doc.items or []):
        if not _is_stock_item(row.item_code):
            continue
        items.append({
            "item_code":   row.item_code,
            "item_name":   row.item_name or row.item_code,
            "qty":         flt(row.qty),
            "basic_rate":  flt(row.rate),
            "s_warehouse": wh,
        })

    if not items:
        frappe.msgprint(_("No stock items found on this order — no delivery entry created."), alert=True)
        return {"stock_entry": None, "sales_order": sales_order, "items_delivered": 0}

    se = frappe.get_doc({
        "doctype":           "Stock Entry",
        "stock_entry_type":  "Material Issue",
        "posting_date":      today(),
        "company":           doc.company,
        "remarks":           _("Delivery for Sales Order {0}").format(sales_order),
        "reference_doctype": "Sales Order",
        "reference_name":    sales_order,
        "items":             items,
    })
    se.flags.ignore_permissions = True
    se.insert()
    se.submit()

    # Mark order as delivered
    frappe.db.set_value("Sales Order", sales_order, "status", "Delivered", update_modified=True)

    return {
        "stock_entry":     se.name,
        "sales_order":     sales_order,
        "items_delivered": len(items),
    }


@frappe.whitelist(allow_guest=False)
def create_invoice_from_order(sales_order: str) -> dict:
    """
    Create a Sales Invoice from a confirmed/delivered Sales Order.
    Copies customer, items, and totals.  Returns the new invoice name.
    """
    so = _get_doc("Sales Order", sales_order, required_docstatus=1)

    inv = frappe.get_doc({
        "doctype":        "Sales Invoice",
        "customer":       so.customer,
        "posting_date":   today(),
        "company":        so.company,
        "currency":       getattr(so, "currency", "INR"),
        "sales_order":    sales_order,
        "items": [
            {
                "item_code":  row.item_code,
                "item_name":  row.item_name or row.item_code,
                "qty":        flt(row.qty),
                "rate":       flt(row.rate),
                "amount":     flt(row.qty) * flt(row.rate),
            }
            for row in (so.items or [])
        ],
    })
    inv.flags.ignore_permissions = True
    inv.insert()

    frappe.db.set_value("Sales Order", sales_order, "status", "Invoiced", update_modified=True)
    return {"sales_invoice": inv.name, "sales_order": sales_order}


# ─── Purchase Workflow ────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def confirm_purchase_order(purchase_order: str) -> dict:
    """Submit a Purchase Order (Draft → Confirmed)."""
    doc = _get_doc("Purchase Order", purchase_order, required_status="Draft")
    doc.submit()
    return {"purchase_order": doc.name, "status": "Confirmed"}


@frappe.whitelist(allow_guest=False)
def receive_goods_from_order(purchase_order: str, warehouse: str = None) -> dict:
    """
    Create a Material Receipt Stock Entry from a submitted Purchase Order.
    Records goods arriving at the warehouse.
    """
    doc = _get_doc("Purchase Order", purchase_order, required_docstatus=1)

    wh = warehouse or _default_warehouse(doc.company)
    if not wh:
        frappe.throw(_("No warehouse specified and no default warehouse in Books Settings."))

    items = []
    for row in (doc.items or []):
        if not _is_stock_item(row.item_code):
            continue
        items.append({
            "item_code":   row.item_code,
            "item_name":   row.item_name or row.item_code,
            "qty":         flt(row.qty),
            "basic_rate":  flt(row.rate),
            "t_warehouse": wh,
        })

    if not items:
        frappe.msgprint(_("No stock items on this PO — no receipt entry created."), alert=True)
        return {"stock_entry": None, "purchase_order": purchase_order, "items_received": 0}

    se = frappe.get_doc({
        "doctype":           "Stock Entry",
        "stock_entry_type":  "Material Receipt",
        "posting_date":      today(),
        "company":           doc.company,
        "remarks":           _("Goods receipt for Purchase Order {0}").format(purchase_order),
        "reference_doctype": "Purchase Order",
        "reference_name":    purchase_order,
        "items":             items,
    })
    se.flags.ignore_permissions = True
    se.insert()
    se.submit()

    frappe.db.set_value("Purchase Order", purchase_order, "status", "Received", update_modified=True)
    return {
        "stock_entry":    se.name,
        "purchase_order": purchase_order,
        "items_received": len(items),
    }


@frappe.whitelist(allow_guest=False)
def create_bill_from_order(purchase_order: str) -> dict:
    """
    Create a Purchase Invoice from a submitted Purchase Order.
    Returns the new invoice name.
    """
    po = _get_doc("Purchase Order", purchase_order, required_docstatus=1)

    bill = frappe.get_doc({
        "doctype":         "Purchase Invoice",
        "supplier":        po.supplier,
        "posting_date":    today(),
        "company":         po.company,
        "currency":        getattr(po, "currency", "INR"),
        "purchase_order":  purchase_order,
        "items": [
            {
                "item_code": row.item_code,
                "item_name": row.item_name or row.item_code,
                "qty":       flt(row.qty),
                "rate":      flt(row.rate),
                "amount":    flt(row.qty) * flt(row.rate),
            }
            for row in (po.items or [])
        ],
    })
    bill.flags.ignore_permissions = True
    bill.insert()

    frappe.db.set_value("Purchase Order", purchase_order, "status", "Billed", update_modified=True)
    return {"purchase_invoice": bill.name, "purchase_order": purchase_order}


# ─── Payment Workflow ─────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def record_payment_for_invoice(
    invoice_doctype: str,
    invoice_name: str,
    paid_amount: float,
    payment_date: str = None,
    mode_of_payment: str = "Cash",
    paid_from: str = None,
    paid_to: str = None,
) -> dict:
    """
    Create and submit a Payment Entry for a Sales or Purchase Invoice.
    Automatically links the payment to the invoice via reference.

    invoice_doctype: "Sales Invoice" or "Purchase Invoice"
    Returns the created Payment Entry name.
    """
    if invoice_doctype not in ("Sales Invoice", "Purchase Invoice"):
        frappe.throw(_("Unsupported invoice type: {0}").format(invoice_doctype))

    inv = frappe.get_doc(invoice_doctype, invoice_name)
    if inv.docstatus != 1:
        frappe.throw(_("Invoice {0} must be submitted before recording payment.").format(invoice_name))

    is_sales    = invoice_doctype == "Sales Invoice"
    party_type  = "Customer"  if is_sales else "Supplier"
    party       = inv.customer if is_sales else inv.supplier
    ptype       = "Receive"   if is_sales else "Pay"

    pe = frappe.get_doc({
        "doctype":         "Payment Entry",
        "payment_type":    ptype,
        "party_type":      party_type,
        "party":           party,
        "paid_amount":     flt(paid_amount),
        "payment_date":    payment_date or today(),
        "company":         inv.company,
        "mode_of_payment": mode_of_payment,
        "paid_from":       paid_from or "",
        "paid_to":         paid_to or "",
        "references": [
            {
                "reference_doctype": invoice_doctype,
                "reference_name":    invoice_name,
                "allocated_amount":  flt(paid_amount),
            }
        ],
    })
    pe.flags.ignore_permissions = True
    pe.insert()
    pe.submit()

    return {
        "payment_entry": pe.name,
        "invoice":       invoice_name,
        "paid_amount":   flt(paid_amount),
    }


# ─── Workflow Status ──────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_order_workflow_status(doctype: str, name: str) -> dict:
    """
    Return the complete workflow chain for a Sales/Purchase Order:
    which steps are done, which are pending, what documents were created.
    """
    if doctype not in ("Sales Order", "Purchase Order"):
        frappe.throw(_("Unsupported doctype: {0}").format(doctype))

    doc = frappe.get_doc(doctype, name)
    is_sales = doctype == "Sales Order"

    # Find linked Stock Entries
    stock_entries = frappe.get_all(
        "Stock Entry",
        filters={"reference_doctype": doctype, "reference_name": name, "docstatus": 1},
        fields=["name", "stock_entry_type", "posting_date"],
    )

    # Find linked Invoices
    inv_field  = "sales_order" if is_sales else "purchase_order"
    inv_dt     = "Sales Invoice" if is_sales else "Purchase Invoice"
    invoices   = frappe.get_all(
        inv_dt,
        filters={inv_field: name, "docstatus": ["!=", 2]},
        fields=["name", "docstatus", "grand_total", "outstanding_amount"],
    )

    # Find linked Payments (via invoice)
    payments = []
    for inv in invoices:
        refs = frappe.get_all(
            "Payment Entry Reference",
            filters={"reference_name": inv.name},
            fields=["parent"],
        )
        payments.extend([r.parent for r in refs])

    return {
        "doctype":       doctype,
        "name":          name,
        "status":        doc.status,
        "docstatus":     doc.docstatus,
        "workflow": {
            "order_confirmed": doc.docstatus == 1,
            "goods_moved":     len(stock_entries) > 0,
            "invoiced":        len(invoices) > 0,
            "paid":            len(payments) > 0,
        },
        "stock_entries": stock_entries,
        "invoices":      [dict(i) for i in invoices],
        "payment_entries": list(set(payments)),
    }


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _get_doc(doctype: str, name: str,
             required_status: str = None,
             required_docstatus: int = None):
    doc = frappe.get_doc(doctype, name)
    if required_status and doc.status != required_status:
        frappe.throw(_(
            "{0} {1} must be in '{2}' status (currently '{3}')."
        ).format(doctype, name, required_status, doc.status))
    if required_docstatus is not None and doc.docstatus != required_docstatus:
        frappe.throw(_(
            "{0} {1} must be submitted (docstatus={2})."
        ).format(doctype, name, required_docstatus))
    return doc


def _check_stock_for_order(doc):
    """Warn (not block) if any item is below required qty at submission."""
    from zoho_books_clone.inventory.utils import get_stock_balance
    warnings = []
    for row in (getattr(doc, "items", None) or []):
        if not _is_stock_item(row.item_code):
            continue
        wh = getattr(row, "warehouse", None) or _default_warehouse(doc.company)
        if not wh:
            continue
        available = get_stock_balance(row.item_code, wh)
        if available < flt(row.qty):
            warnings.append(
                f"• {row.item_code}: available {available}, required {flt(row.qty)}"
            )
    if warnings:
        frappe.msgprint(
            _("Stock shortage warning for the following items:\n{0}\n"
              "You can still confirm the order, but delivery may be delayed.").format(
                "\n".join(warnings)
            ),
            indicator="orange",
        )


def _is_stock_item(item_code: str) -> bool:
    return bool(frappe.db.get_value("Item", item_code, "is_stock_item"))


def _default_warehouse(company: str) -> str | None:
    try:
        return frappe.db.get_single_value("Books Settings", "default_warehouse") or None
    except Exception:
        return None


def _order_summary(doc) -> dict:
    return {
        "name":     doc.name,
        "status":   doc.status,
        "docstatus": doc.docstatus,
        "grand_total": flt(getattr(doc, "grand_total", 0)),
    }
