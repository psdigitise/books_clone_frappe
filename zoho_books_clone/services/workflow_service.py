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
from frappe.utils import flt, today


# ─── Sales Workflow ───────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def confirm_sales_order(sales_order: str) -> dict:
    """
    Transition a Sales Order from Draft → Confirmed.
    Validates stock availability and reserves inventory for the order.
    Returns the updated document.
    """
    doc = _get_doc("Sales Order", sales_order, required_status="Draft")
    _check_stock_for_order(doc)
    frappe.db.set_value("Sales Order", sales_order, "status", "Confirmed", update_modified=True)
    doc.status = "Confirmed"
    # Reserve inventory: increment reserved_qty for each stock item
    wh = _default_warehouse(doc.company)
    if wh:
        for row in (doc.items or []):
            if _is_stock_item(row.item_code):
                _update_bin_reserved_qty(row.item_code, wh, flt(row.qty))
    return _order_summary(doc)


@frappe.whitelist(allow_guest=False)
def cancel_sales_order(sales_order: str) -> dict:
    """Cancel a Sales Order and release any reserved inventory."""
    doc = _get_doc("Sales Order", sales_order)
    if doc.status == "Cancelled":
        frappe.throw(_("Sales Order {0} is already cancelled.").format(sales_order))
    wh = _default_warehouse(doc.company)
    if wh and doc.status == "Confirmed":
        for row in (doc.items or []):
            if _is_stock_item(row.item_code):
                _update_bin_reserved_qty(row.item_code, wh, -flt(row.qty))
    frappe.db.set_value("Sales Order", sales_order, "status", "Cancelled", update_modified=True)
    return {"sales_order": sales_order, "status": "Cancelled"}


@frappe.whitelist(allow_guest=False)
def create_delivery_from_order(
    sales_order: str,
    warehouse: str = None,
    items_to_deliver: list | str = None,
) -> dict:
    """
    Create a Stock Entry (Material Issue) from a confirmed Sales Order.
    Supports partial delivery — pass items_to_deliver as a list of
    {item_code, qty} dicts to deliver specific quantities.
    If omitted, delivers the remaining undelivered qty for each item.

    Returns {stock_entry, sales_order, items_delivered, fully_delivered}.
    """
    doc = _get_doc("Sales Order", sales_order)

    if doc.status in ("Cancelled",):
        frappe.throw(_(
            "Sales Order {0} cannot be delivered — current status is '{1}'."
        ).format(sales_order, doc.status))
    if doc.status == "Draft":
        frappe.throw(_(
            "Sales Order {0} must be Confirmed before delivery."
        ).format(sales_order))

    wh = warehouse or _default_warehouse(doc.company)
    if not wh:
        frappe.throw(_("No warehouse specified and no default warehouse configured in Books Settings."))

    # Parse items_to_deliver if passed as JSON string
    if isinstance(items_to_deliver, str):
        import json
        items_to_deliver = json.loads(items_to_deliver)

    # Build a map of already-delivered qty per item from prior stock entries
    delivered_map = _get_delivered_qty_map("Sales Order", sales_order)

    # Build delivery qty map from explicit input or remaining balance
    deliver_map = {}
    if items_to_deliver:
        for row in items_to_deliver:
            deliver_map[row["item_code"]] = flt(row.get("qty", 0))
    else:
        for row in (doc.items or []):
            if not _is_stock_item(row.item_code):
                continue
            remaining = flt(row.qty) - flt(delivered_map.get(row.item_code, 0))
            if remaining > 0:
                deliver_map[row.item_code] = remaining

    items = []
    for row in (doc.items or []):
        if row.item_code not in deliver_map:
            continue
        qty = flt(deliver_map[row.item_code])
        if qty <= 0:
            continue
        # Validate not over-delivering
        already = flt(delivered_map.get(row.item_code, 0))
        if already + qty > flt(row.qty):
            frappe.throw(_(
                "Cannot deliver {0} units of {1} — only {2} remaining (ordered {3}, already delivered {4})."
            ).format(qty, row.item_code, flt(row.qty) - already, flt(row.qty), already))
        items.append({
            "item_code":   row.item_code,
            "item_name":   row.item_name or row.item_code,
            "qty":         qty,
            "basic_rate":  flt(row.rate),
            "s_warehouse": wh,
        })

    if not items:
        frappe.msgprint(_("No items to deliver — all stock items have been fully delivered or none exist."), alert=True)
        return {"stock_entry": None, "sales_order": sales_order, "items_delivered": 0, "fully_delivered": True}

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
    se.name = "SEC-" + frappe.generate_hash(txt=f"so{sales_order}{frappe.utils.now()}", length=8).upper()
    se.flags.ignore_permissions = True
    se.flags.ignore_links = True
    se.flags.ignore_mandatory = True
    se.insert()
    se.submit()

    # Check if fully delivered now
    fully_delivered = _is_fully_delivered("Sales Order", sales_order, doc)
    new_status = "Delivered" if fully_delivered else "Partly Delivered"
    frappe.db.set_value("Sales Order", sales_order, "status", new_status, update_modified=True)

    # Release reservation for delivered items
    for row in items:
        _update_bin_reserved_qty(row["item_code"], wh, -flt(row["qty"]))

    return {
        "stock_entry":      se.name,
        "sales_order":      sales_order,
        "items_delivered":  len(items),
        "fully_delivered":  fully_delivered,
    }


@frappe.whitelist(allow_guest=False)
def create_invoice_from_order(sales_order: str) -> dict:
    """
    Create a Sales Invoice from a confirmed/delivered Sales Order.
    Copies customer, items, and totals.  Returns the new invoice name.
    """
    so = _get_doc("Sales Order", sales_order)
    if so.status in ("Cancelled", "Draft"):
        frappe.throw(_("Sales Order {0} must be Confirmed before invoicing.").format(sales_order))

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
    """Confirm a Purchase Order (Draft → Confirmed) and track ordered qty."""
    doc = _get_doc("Purchase Order", purchase_order)
    if doc.status == "Cancelled":
        frappe.throw(_("Purchase Order {0} is cancelled.").format(purchase_order))
    if doc.status != "Draft":
        return {"purchase_order": doc.name, "status": doc.status}
    frappe.db.set_value("Purchase Order", purchase_order, "status", "Confirmed", update_modified=True)
    frappe.db.commit()
    # Track ordered qty so projected_qty reflects incoming stock
    wh = _default_warehouse(doc.company)
    if wh:
        for row in (doc.items or []):
            if _is_stock_item(row.item_code):
                _update_bin_ordered_qty(row.item_code, wh, flt(row.qty))
    return {"purchase_order": doc.name, "status": "Confirmed"}


@frappe.whitelist(allow_guest=False)
def receive_goods_from_order(
    purchase_order: str,
    warehouse: str = None,
    items_to_receive: list | str = None,
) -> dict:
    """
    Create a Material Receipt Stock Entry from a submitted Purchase Order.
    Supports partial receipt — pass items_to_receive as a list of
    {item_code, qty} dicts. If omitted, receives remaining qty for each item.

    Returns {stock_entry, purchase_order, items_received, fully_received}.
    """
    doc = _get_doc("Purchase Order", purchase_order)
    if doc.status == "Draft":
        frappe.throw(_("Purchase Order {0} must be Confirmed before receiving goods.").format(purchase_order))
    if doc.status == "Cancelled":
        frappe.throw(_("Purchase Order {0} is cancelled.").format(purchase_order))

    wh = warehouse or _default_warehouse(doc.company)
    if not wh:
        frappe.throw(_("No warehouse specified and no default warehouse in Books Settings."))

    if isinstance(items_to_receive, str):
        import json
        items_to_receive = json.loads(items_to_receive)

    received_map = _get_received_qty_map("Purchase Order", purchase_order)

    receive_map = {}
    if items_to_receive:
        for row in items_to_receive:
            receive_map[row["item_code"]] = flt(row.get("qty", 0))
    else:
        for row in (doc.items or []):
            if not _is_stock_item(row.item_code):
                continue
            remaining = flt(row.qty) - flt(received_map.get(row.item_code, 0))
            if remaining > 0:
                receive_map[row.item_code] = remaining

    items = []
    for row in (doc.items or []):
        if row.item_code not in receive_map:
            continue
        qty = flt(receive_map[row.item_code])
        if qty <= 0:
            continue
        already = flt(received_map.get(row.item_code, 0))
        if already + qty > flt(row.qty):
            frappe.throw(_(
                "Cannot receive {0} units of {1} — only {2} remaining (ordered {3}, already received {4})."
            ).format(qty, row.item_code, flt(row.qty) - already, flt(row.qty), already))
        items.append({
            "item_code":   row.item_code,
            "item_name":   row.item_name or row.item_code,
            "qty":         qty,
            "basic_rate":  flt(row.rate),
            "t_warehouse": wh,
        })

    if not items:
        frappe.msgprint(_("No items to receive — all stock items fully received or none exist."), alert=True)
        return {"stock_entry": None, "purchase_order": purchase_order, "items_received": 0, "fully_received": True}

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
    se.name = "SEC-" + frappe.generate_hash(txt=f"po{purchase_order}{frappe.utils.now()}", length=8).upper()
    se.flags.ignore_permissions = True
    se.flags.ignore_links = True
    se.flags.ignore_mandatory = True
    se.insert()
    se.submit()

    fully_received = _is_fully_received("Purchase Order", purchase_order, doc)
    new_status = "Received" if fully_received else "Partly Received"
    frappe.db.set_value("Purchase Order", purchase_order, "status", new_status, update_modified=True)

    # Release ordered qty for received items
    for row in items:
        _update_bin_ordered_qty(row["item_code"], wh, -flt(row["qty"]))

    return {
        "stock_entry":     se.name,
        "purchase_order":  purchase_order,
        "items_received":  len(items),
        "fully_received":  fully_received,
    }


def _resolve_item_code(item_code: str) -> str:
    """Return a valid Item name for the given value, falling back to item_name lookup."""
    if frappe.db.exists("Item", item_code):
        return item_code
    found = frappe.db.get_value("Item", {"item_name": item_code}, "name")
    return found or item_code


@frappe.whitelist(allow_guest=False)
def create_bill_from_order(purchase_order: str) -> dict:
    """
    Create a Purchase Invoice from a Confirmed/Received Purchase Order.
    Returns the new invoice name.
    """
    po = _get_doc("Purchase Order", purchase_order)
    if po.status in ("Cancelled", "Draft"):
        frappe.throw(_("Purchase Order {0} must be Confirmed before billing.").format(purchase_order))

    bill = frappe.get_doc({
        "doctype":         "Purchase Invoice",
        "supplier":        po.supplier,
        "posting_date":    today(),
        "company":         po.company,
        "currency":        getattr(po, "currency", "INR"),
        "purchase_order":  purchase_order,
        "items": [
            {
                "item_code": _resolve_item_code(row.item_code),
                "item_name": row.item_name or row.item_code,
                "qty":       flt(row.qty),
                "rate":      flt(row.rate),
                "amount":    flt(row.qty) * flt(row.rate),
            }
            for row in (po.items or [])
        ],
    })
    bill.flags.ignore_permissions = True
    bill.flags.ignore_mandatory = True
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
            "order_confirmed": doc.status not in ("Draft", "Cancelled"),
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


def _default_warehouse(_company: str = None) -> str | None:
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


def _get_delivered_qty_map(ref_doctype: str, ref_name: str) -> dict:
    """
    Return {item_code: total_delivered_qty} from all submitted Material Issue
    Stock Entries linked to a Sales Order.
    """
    entries = frappe.get_all(
        "Stock Entry",
        filters={
            "reference_doctype": ref_doctype,
            "reference_name": ref_name,
            "stock_entry_type": "Material Issue",
            "docstatus": 1,
        },
        fields=["name"],
    )
    qty_map = {}
    for se in entries:
        items = frappe.get_all(
            "Stock Entry Detail",
            filters={"parent": se.name},
            fields=["item_code", "qty"],
        )
        for row in items:
            qty_map[row.item_code] = flt(qty_map.get(row.item_code, 0)) + flt(row.qty)
    return qty_map


def _get_received_qty_map(ref_doctype: str, ref_name: str) -> dict:
    """
    Return {item_code: total_received_qty} from all submitted Material Receipt
    Stock Entries linked to a Purchase Order.
    """
    entries = frappe.get_all(
        "Stock Entry",
        filters={
            "reference_doctype": ref_doctype,
            "reference_name": ref_name,
            "stock_entry_type": "Material Receipt",
            "docstatus": 1,
        },
        fields=["name"],
    )
    qty_map = {}
    for se in entries:
        items = frappe.get_all(
            "Stock Entry Detail",
            filters={"parent": se.name},
            fields=["item_code", "qty"],
        )
        for row in items:
            qty_map[row.item_code] = flt(qty_map.get(row.item_code, 0)) + flt(row.qty)
    return qty_map


def _is_fully_delivered(ref_doctype: str, ref_name: str, doc) -> bool:
    """Check if all stock items on a Sales Order have been fully delivered."""
    delivered = _get_delivered_qty_map(ref_doctype, ref_name)
    for row in (doc.items or []):
        if not _is_stock_item(row.item_code):
            continue
        if flt(delivered.get(row.item_code, 0)) < flt(row.qty):
            return False
    return True


def _is_fully_received(ref_doctype: str, ref_name: str, doc) -> bool:
    """Check if all stock items on a Purchase Order have been fully received."""
    received = _get_received_qty_map(ref_doctype, ref_name)
    for row in (doc.items or []):
        if not _is_stock_item(row.item_code):
            continue
        if flt(received.get(row.item_code, 0)) < flt(row.qty):
            return False
    return True


def _update_bin_reserved_qty(item_code: str, warehouse: str, delta: float) -> None:
    """Increment or decrement reserved_qty on the Bin (clamped to 0)."""
    bin_name = frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse})
    if not bin_name:
        return
    current = flt(frappe.db.get_value("Bin", bin_name, "reserved_qty"))
    actual  = flt(frappe.db.get_value("Bin", bin_name, "actual_qty"))
    ordered = flt(frappe.db.get_value("Bin", bin_name, "ordered_qty"))
    new_reserved = max(0, current + delta)
    frappe.db.set_value("Bin", bin_name, {
        "reserved_qty":  new_reserved,
        "projected_qty": actual + ordered - new_reserved,
    }, update_modified=True)


def _update_bin_ordered_qty(item_code: str, warehouse: str, delta: float) -> None:
    """Increment or decrement ordered_qty on the Bin (clamped to 0).
    Creates the Bin if it doesn't exist yet (PO confirmed before first receipt)."""
    bin_name = frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse})
    if not bin_name:
        from zoho_books_clone.inventory.utils import get_or_create_bin
        bin_name = get_or_create_bin(item_code, warehouse)
    current  = flt(frappe.db.get_value("Bin", bin_name, "ordered_qty"))
    actual   = flt(frappe.db.get_value("Bin", bin_name, "actual_qty"))
    reserved = flt(frappe.db.get_value("Bin", bin_name, "reserved_qty"))
    new_ordered = max(0, current + delta)
    frappe.db.set_value("Bin", bin_name, {
        "ordered_qty":   new_ordered,
        "projected_qty": actual + new_ordered - reserved,
    }, update_modified=True)
