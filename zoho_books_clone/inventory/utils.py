"""
Inventory utility functions — stock balance, valuation, reorder detection.
All business logic lives here; controllers are kept thin.
"""

import frappe
from frappe.utils import flt, getdate, today


# ── Stock Balance ─────────────────────────────────────────────────────────────

def get_stock_balance(item_code: str, warehouse: str, as_of_date: str | None = None) -> float:
    """
    Return the net stock qty for an item in a warehouse.
    Uses the Bin table for the latest balance (fastest), or
    falls back to summing Stock Ledger Entries up to a date.
    """
    if as_of_date and getdate(as_of_date) < getdate(today()):
        return _sle_balance(item_code, warehouse, as_of_date)

    qty = frappe.db.get_value(
        "Bin", {"item_code": item_code, "warehouse": warehouse}, "actual_qty"
    )
    return flt(qty)


def _sle_balance(item_code: str, warehouse: str, as_of_date: str) -> float:
    result = frappe.db.sql("""
        SELECT COALESCE(SUM(actual_qty), 0) AS qty
        FROM `tabStock Ledger Entry`
        WHERE item_code = %(item_code)s
          AND warehouse  = %(warehouse)s
          AND is_cancelled = 0
          AND posting_date <= %(date)s
    """, {"item_code": item_code, "warehouse": warehouse, "date": as_of_date}, as_dict=True)
    return flt(result[0].qty) if result else 0.0


def get_stock_balance_bulk(item_codes: list[str], warehouse: str) -> dict[str, float]:
    """Return {item_code: actual_qty} for a list of items in one warehouse."""
    if not item_codes:
        return {}
    rows = frappe.get_all(
        "Bin",
        filters={"warehouse": warehouse, "item_code": ["in", item_codes]},
        fields=["item_code", "actual_qty"],
    )
    return {r.item_code: flt(r.actual_qty) for r in rows}


# ── Valuation ─────────────────────────────────────────────────────────────────

def get_valuation_rate(item_code: str, warehouse: str) -> float:
    """Return current moving-average valuation rate from Bin."""
    rate = frappe.db.get_value(
        "Bin", {"item_code": item_code, "warehouse": warehouse}, "valuation_rate"
    )
    return flt(rate)


def get_total_stock_value(warehouse: str | None = None, company: str | None = None) -> float:
    """Sum of stock_value across all Bins, optionally filtered."""
    filters = {}
    if warehouse:
        filters["warehouse"] = warehouse
    if company:
        filters["company"] = company
    rows = frappe.get_all("Bin", filters=filters, fields=["stock_value"])
    return sum(flt(r.stock_value) for r in rows)


# ── Reorder Alerts ────────────────────────────────────────────────────────────

def get_reorder_alerts(company: str | None = None) -> list[dict]:
    """
    Return items where actual_qty < reorder_level.
    Joins Bin with Item to get reorder thresholds.
    """
    company_cond = "AND b.company = %(company)s" if company else ""
    params = {"company": company} if company else {}

    return frappe.db.sql(f"""
        SELECT
            b.item_code,
            i.item_name,
            b.warehouse,
            b.actual_qty,
            b.reorder_level,
            b.reorder_qty,
            b.stock_uom,
            b.valuation_rate,
            (b.reorder_qty - b.actual_qty) AS shortage_qty
        FROM `tabBin` b
        JOIN `tabItem` i ON i.name = b.item_code
        WHERE b.reorder_level > 0
          AND b.actual_qty < b.reorder_level
          AND (i.disabled IS NULL OR i.disabled = 0)
          {company_cond}
        ORDER BY (b.reorder_level - b.actual_qty) DESC
    """, params, as_dict=True)


# ── Item Price Lookup ─────────────────────────────────────────────────────────

def get_item_price(item_code: str, price_list: str, uom: str | None = None,
                   as_of_date: str | None = None) -> float:
    """Return effective price_list_rate for an item + price list combination."""
    from zoho_books_clone.inventory.doctype.item_price.item_price import ItemPrice
    return ItemPrice.get_price(item_code, price_list, uom=uom, as_of_date=as_of_date)


# ── Stock Ledger History ──────────────────────────────────────────────────────

def get_stock_ledger(
    item_code: str | None = None,
    warehouse: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int = 500,
) -> list[dict]:
    """Paginated stock ledger history with optional filters."""
    conditions = ["is_cancelled = 0"]
    params: dict = {}

    if item_code:
        conditions.append("item_code = %(item_code)s")
        params["item_code"] = item_code
    if warehouse:
        conditions.append("warehouse = %(warehouse)s")
        params["warehouse"] = warehouse
    if from_date:
        conditions.append("posting_date >= %(from_date)s")
        params["from_date"] = from_date
    if to_date:
        conditions.append("posting_date <= %(to_date)s")
        params["to_date"] = to_date

    where = " AND ".join(conditions)
    params["limit"] = int(limit)

    return frappe.db.sql(f"""
        SELECT
            name, item_code, warehouse, posting_date, voucher_type, voucher_no,
            actual_qty, qty_after_transaction, incoming_rate, valuation_rate,
            stock_value, stock_value_difference
        FROM `tabStock Ledger Entry`
        WHERE {where}
        ORDER BY posting_date DESC, creation DESC
        LIMIT %(limit)s
    """, params, as_dict=True)


# ── Bin Recalculation (Audit-5) ───────────────────────────────────────────────

def recalculate_bin(item_code: str, warehouse: str) -> dict:
    """
    Audit-5: Recompute the Bin balance from the authoritative Stock Ledger Entries
    and write it back to the Bin table.

    Use this when you suspect Bin drift (e.g., after direct DB edits, cancelled
    entries, or a concurrency incident).  Returns a dict describing what changed.

    This function is idempotent — calling it multiple times is safe.
    """
    # Sum all active SLEs for this item+warehouse
    result = frappe.db.sql("""
        SELECT
            COALESCE(SUM(actual_qty),            0) AS total_qty,
            COALESCE(SUM(stock_value_difference), 0) AS total_value
        FROM `tabStock Ledger Entry`
        WHERE item_code    = %(item_code)s
          AND warehouse    = %(warehouse)s
          AND is_cancelled = 0
    """, {"item_code": item_code, "warehouse": warehouse}, as_dict=True)

    correct_qty   = flt(result[0].total_qty)   if result else 0.0
    correct_value = flt(result[0].total_value) if result else 0.0
    correct_rate  = (correct_value / correct_qty) if correct_qty else 0.0

    bin_name = frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse})

    if not bin_name:
        # Create the Bin so future queries have a record to read
        frappe.get_doc({
            "doctype":        "Bin",
            "item_code":      item_code,
            "warehouse":      warehouse,
            "actual_qty":     correct_qty,
            "reserved_qty":   0,
            "ordered_qty":    0,
            "projected_qty":  correct_qty,
            "valuation_rate": correct_rate,
            "stock_value":    correct_value,
        }).insert(ignore_permissions=True)
        return {
            "item_code": item_code,
            "warehouse": warehouse,
            "status":    "created",
            "new_qty":   correct_qty,
            "new_value": correct_value,
        }

    old_qty   = flt(frappe.db.get_value("Bin", bin_name, "actual_qty"))
    old_value = flt(frappe.db.get_value("Bin", bin_name, "stock_value"))
    ordered   = flt(frappe.db.get_value("Bin", bin_name, "ordered_qty"))
    reserved  = flt(frappe.db.get_value("Bin", bin_name, "reserved_qty"))

    frappe.db.set_value("Bin", bin_name, {
        "actual_qty":     correct_qty,
        "stock_value":    correct_value,
        "valuation_rate": correct_rate,
        "projected_qty":  correct_qty + ordered - reserved,
    }, update_modified=True)

    return {
        "item_code":    item_code,
        "warehouse":    warehouse,
        "status":       "recalculated",
        "old_qty":      old_qty,
        "new_qty":      correct_qty,
        "qty_drift":    correct_qty - old_qty,
        "old_value":    old_value,
        "new_value":    correct_value,
        "value_drift":  correct_value - old_value,
    }


def recalculate_all_bins(warehouse: str | None = None) -> list[dict]:
    """
    Recalculate every Bin from SLEs, optionally scoped to a single warehouse.
    Also creates Bins for item+warehouse pairs that have SLEs but no Bin yet.
    Returns a list of recalculation result dicts (one per item+warehouse pair).
    """
    wh_cond = "AND warehouse = %(warehouse)s" if warehouse else ""
    params  = {"warehouse": warehouse} if warehouse else {}

    # Collect all distinct item+warehouse pairs from active SLEs
    pairs = frappe.db.sql(f"""
        SELECT DISTINCT item_code, warehouse
        FROM `tabStock Ledger Entry`
        WHERE is_cancelled = 0
        {wh_cond}
        ORDER BY item_code, warehouse
    """, params, as_dict=True)

    return [recalculate_bin(p.item_code, p.warehouse) for p in pairs]


# ── Bin Upsert (helper for controllers) ──────────────────────────────────────

def get_or_create_bin(item_code: str, warehouse: str, company: str = "") -> str:
    """Return name of Bin for item+warehouse, creating it if necessary."""
    name = frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse})
    if name:
        return name

    if not company:
        company = (
            frappe.db.get_single_value("Books Settings", "default_company")
            or frappe.defaults.get_default("company")
            or ""
        )

    uom = frappe.db.get_value("Item", item_code, "stock_uom") or "Nos"
    reorder_level = frappe.db.get_value("Item", item_code, "reorder_level") or 0
    reorder_qty   = frappe.db.get_value("Item", item_code, "reorder_qty")   or 0

    bin_doc = frappe.get_doc({
        "doctype": "Bin",
        "item_code": item_code,
        "warehouse": warehouse,
        "company": company,
        "stock_uom": uom,
        "actual_qty": 0,
        "reserved_qty": 0,
        "ordered_qty": 0,
        "projected_qty": 0,
        "stock_value": 0,
        "valuation_rate": 0,
        "reorder_level": reorder_level,
        "reorder_qty": reorder_qty,
    })
    bin_doc.insert(ignore_permissions=True)
    frappe.db.commit()
    return bin_doc.name
