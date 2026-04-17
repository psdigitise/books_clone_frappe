"""
Stock Link — Audit fixes P2/Audit-2 and P2/Audit-3.

Wires Sales Invoice and Purchase Invoice on_submit events (via hooks.py)
to automatically create Stock Entries that keep inventory in sync with
invoicing.

  Audit-2: Sales Invoice submit  → Material Issue  (stock deducted)
  Audit-3: Purchase Invoice submit → Material Receipt (stock added)

If an item has no warehouse resolved, or is not a stock item, that row is
silently skipped so that non-inventory invoices continue to work.  If the
entire invoice has no stock items the hook returns without creating any entry.
"""

import frappe
from frappe import _
from frappe.utils import flt, today


# ─── Public hook entry points ─────────────────────────────────────────────────

def on_sales_invoice_submit(doc, method=None):
    """
    Audit-2: Deduct stock for every stock item on a submitted Sales Invoice.
    Creates a 'Material Issue' Stock Entry linked back to the invoice.
    """
    rows = _stock_rows(doc, direction="issue")
    if not rows:
        return

    se = _build_stock_entry(
        entry_type="Material Issue",
        posting_date=doc.posting_date or today(),
        company=doc.company,
        remarks=_("Auto stock deduction — Sales Invoice {0}").format(doc.name),
        rows=rows,
        ref_doctype=doc.doctype,
        ref_docname=doc.name,
    )
    frappe.msgprint(
        _("Stock deducted automatically via {0}.").format(
            frappe.bold(se.name)
        ),
        indicator="green",
        alert=True,
    )


def on_sales_invoice_cancel(doc, method=None):
    """Reverse the auto-issue Stock Entry when a Sales Invoice is cancelled."""
    _cancel_linked_entries(doc.doctype, doc.name)


def on_purchase_invoice_submit(doc, method=None):
    """
    Audit-3: Receive stock for every stock item on a submitted Purchase Invoice.
    Creates a 'Material Receipt' Stock Entry linked back to the invoice.
    """
    rows = _stock_rows(doc, direction="receipt")
    if not rows:
        return

    se = _build_stock_entry(
        entry_type="Material Receipt",
        posting_date=doc.posting_date or today(),
        company=doc.company,
        remarks=_("Auto stock receipt — Purchase Invoice {0}").format(doc.name),
        rows=rows,
        ref_doctype=doc.doctype,
        ref_docname=doc.name,
    )
    frappe.msgprint(
        _("Stock received automatically via {0}.").format(
            frappe.bold(se.name)
        ),
        indicator="green",
        alert=True,
    )


def on_purchase_invoice_cancel(doc, method=None):
    """Reverse the auto-receipt Stock Entry when a Purchase Invoice is cancelled."""
    _cancel_linked_entries(doc.doctype, doc.name)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _stock_rows(doc, direction: str) -> list[dict]:
    """
    Return a list of dicts (one per item row) for items that:
      - have a non-zero qty
      - are marked as stock items in the Item master
      - have a resolved warehouse (row-level > doc-level > default)

    direction: "issue" = outgoing (Sales), "receipt" = incoming (Purchase)
    """
    default_warehouse = _default_warehouse(doc.company)
    rows = []

    for row in (doc.items or []):
        item_code = getattr(row, "item_code", None)
        qty       = flt(getattr(row, "qty", 0))
        if not item_code or qty <= 0:
            continue

        # Only process stock items
        is_stock = frappe.db.get_value("Item", item_code, "is_stock_item")
        if not is_stock:
            continue

        warehouse = (
            getattr(row, "warehouse", None)
            or getattr(doc, "set_warehouse", None)
            or default_warehouse
        )
        if not warehouse:
            frappe.msgprint(
                _(
                    "No warehouse found for item {0} — skipped from auto stock entry. "
                    "Set a default warehouse in Books Settings."
                ).format(frappe.bold(item_code)),
                indicator="orange",
                alert=True,
            )
            continue

        rows.append({
            "item_code":  item_code,
            "item_name":  getattr(row, "item_name", None) or item_code,
            "qty":        qty,
            "basic_rate": flt(getattr(row, "rate", 0)),
            "warehouse":  warehouse,
        })

    return rows


def _build_stock_entry(
    entry_type: str,
    posting_date: str,
    company: str,
    remarks: str,
    rows: list[dict],
    ref_doctype: str,
    ref_docname: str,
) -> "frappe.Document":
    """Create, insert, and submit a Stock Entry; returns the submitted document."""
    warehouse_key = "t_warehouse" if entry_type == "Material Receipt" else "s_warehouse"

    items = [
        {
            "item_code":    r["item_code"],
            "item_name":    r["item_name"],
            "qty":          r["qty"],
            "basic_rate":   r["basic_rate"],
            warehouse_key:  r["warehouse"],
        }
        for r in rows
    ]

    se = frappe.get_doc({
        "doctype":          "Stock Entry",
        "stock_entry_type": entry_type,
        "posting_date":     posting_date,
        "company":          company,
        "remarks":          remarks,
        # Store the originating voucher for traceability
        "reference_doctype": ref_doctype,
        "reference_name":    ref_docname,
        "items":            items,
    })
    se.flags.ignore_permissions = True
    se.insert()
    se.submit()
    return se


def _cancel_linked_entries(ref_doctype: str, ref_docname: str) -> None:
    """Cancel any submitted Stock Entries that were auto-created for a voucher."""
    linked = frappe.get_all(
        "Stock Entry",
        filters={
            "reference_doctype": ref_doctype,
            "reference_name":    ref_docname,
            "docstatus":         1,   # submitted only
        },
        fields=["name"],
    )
    for row in linked:
        se = frappe.get_doc("Stock Entry", row.name)
        se.flags.ignore_permissions = True
        se.cancel()


def _default_warehouse(company: str | None) -> str | None:
    """Return the default warehouse configured in Books Settings, if any."""
    try:
        return frappe.db.get_single_value("Books Settings", "default_warehouse") or None
    except Exception:
        return None
