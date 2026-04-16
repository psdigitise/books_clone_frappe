"""
Inventory API — whitelisted endpoints called by the Books SPA.

All endpoints return plain dicts/lists that Vue can consume directly.
Heavy queries are delegated to inventory.utils or db.queries.
"""

import frappe
from frappe import _
from frappe.utils import flt, today, getdate

from zoho_books_clone.inventory.utils import (
    get_stock_balance,
    get_stock_ledger,
    get_reorder_alerts,
    get_total_stock_value,
    get_item_price,
    get_or_create_bin,
)


# ── Stock Summary ─────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_stock_summary(warehouse=None, item_group=None, show_zero_stock=0):
    """
    Return current stock levels (from Bin) with item details.
    Optionally filter by warehouse or item_group.
    """
    filters = {}
    if warehouse:
        filters["warehouse"] = warehouse
    if not int(show_zero_stock):
        filters["actual_qty"] = [">", 0]

    bins = frappe.get_all(
        "Bin",
        filters=filters,
        fields=["item_code", "warehouse", "actual_qty", "reserved_qty",
                "ordered_qty", "projected_qty", "valuation_rate", "stock_value",
                "reorder_level", "reorder_qty", "stock_uom"],
        order_by="item_code asc",
        limit=2000,
    )

    # Enrich with item details
    item_codes = list({b.item_code for b in bins})
    item_map = {}
    if item_codes:
        items = frappe.get_all(
            "Item",
            filters={"name": ["in", item_codes]},
            fields=["name", "item_name", "item_group", "stock_uom", "disabled"],
        )
        for it in items:
            item_map[it.name] = it

    result = []
    for b in bins:
        item = item_map.get(b.item_code, {})
        if item_group and item.get("item_group") != item_group:
            continue
        result.append({
            "item_code":       b.item_code,
            "item_name":       item.get("item_name") or b.item_code,
            "item_group":      item.get("item_group") or "",
            "warehouse":       b.warehouse,
            "uom":             b.stock_uom or item.get("stock_uom") or "Nos",
            "actual_qty":      flt(b.actual_qty),
            "reserved_qty":    flt(b.reserved_qty),
            "ordered_qty":     flt(b.ordered_qty),
            "projected_qty":   flt(b.projected_qty),
            "valuation_rate":  flt(b.valuation_rate),
            "stock_value":     flt(b.stock_value),
            "reorder_level":   flt(b.reorder_level),
            "reorder_qty":     flt(b.reorder_qty),
            "below_reorder":   flt(b.actual_qty) < flt(b.reorder_level) if b.reorder_level else False,
        })

    return result


@frappe.whitelist(allow_guest=False)
def get_item_stock_detail(item_code, warehouse=None):
    """
    Return stock position for a single item across all (or one) warehouse(s).
    """
    filters = {"item_code": item_code}
    if warehouse:
        filters["warehouse"] = warehouse

    bins = frappe.get_all(
        "Bin",
        filters=filters,
        fields=["warehouse", "actual_qty", "reserved_qty", "ordered_qty",
                "projected_qty", "valuation_rate", "stock_value"],
    )

    item = frappe.get_value(
        "Item", item_code,
        ["item_name", "stock_uom", "item_group", "standard_rate"],
        as_dict=True,
    ) or {}

    return {
        "item_code":    item_code,
        "item_name":    item.get("item_name") or item_code,
        "stock_uom":    item.get("stock_uom") or "Nos",
        "item_group":   item.get("item_group") or "",
        "selling_rate": flt(item.get("standard_rate")),
        "warehouses":   [
            {
                "warehouse":     b.warehouse,
                "actual_qty":    flt(b.actual_qty),
                "reserved_qty":  flt(b.reserved_qty),
                "ordered_qty":   flt(b.ordered_qty),
                "projected_qty": flt(b.projected_qty),
                "valuation_rate":flt(b.valuation_rate),
                "stock_value":   flt(b.stock_value),
            }
            for b in bins
        ],
        "total_qty":   sum(flt(b.actual_qty) for b in bins),
        "total_value": sum(flt(b.stock_value) for b in bins),
    }


# ── Stock Ledger ──────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_stock_ledger_entries(item_code=None, warehouse=None,
                              from_date=None, to_date=None, limit=200):
    """Paginated stock movement history."""
    return get_stock_ledger(
        item_code=item_code or None,
        warehouse=warehouse or None,
        from_date=from_date or None,
        to_date=to_date or None,
        limit=int(limit),
    )


# ── Reorder Alerts ────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_reorder_items(company=None):
    """Return items that have fallen below their reorder level."""
    return get_reorder_alerts(company=company or None)


# ── Valuation Report ─────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_stock_valuation_report(warehouse=None, as_of_date=None):
    """
    Stock valuation summary — total value per warehouse, and grand total.
    """
    filters = {"actual_qty": [">", 0]}
    if warehouse:
        filters["warehouse"] = warehouse

    bins = frappe.get_all(
        "Bin",
        filters=filters,
        fields=["warehouse", "stock_value"],
    )

    by_warehouse: dict[str, float] = {}
    for b in bins:
        by_warehouse[b.warehouse] = by_warehouse.get(b.warehouse, 0) + flt(b.stock_value)

    grand_total = sum(by_warehouse.values())

    return {
        "as_of_date":   as_of_date or today(),
        "by_warehouse": [{"warehouse": k, "stock_value": v} for k, v in sorted(by_warehouse.items())],
        "grand_total":  grand_total,
    }


# ── Item Price ────────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_item_price_list(item_code=None, price_list=None, as_of_date=None):
    """
    Return active Item Prices, optionally filtered by item or price list.
    """
    filters = {}
    if item_code:
        filters["item_code"] = item_code
    if price_list:
        filters["price_list"] = price_list

    prices = frappe.get_all(
        "Item Price",
        filters=filters,
        fields=["name", "item_code", "item_name", "price_list",
                "uom", "currency", "valid_from", "valid_upto", "price_list_rate"],
        order_by="item_code asc, valid_from desc",
        limit=1000,
    )

    date = as_of_date or today()
    result = []
    for p in prices:
        if p.valid_from and getdate(p.valid_from) > getdate(date):
            continue
        if p.valid_upto and getdate(p.valid_upto) < getdate(date):
            continue
        result.append(p)

    return result


@frappe.whitelist(allow_guest=False)
def get_price_for_item(item_code, price_list, uom=None, as_of_date=None):
    """Return a single effective rate for an item + price list (used by invoice line-fill)."""
    return {
        "item_code":       item_code,
        "price_list":      price_list,
        "price_list_rate": get_item_price(item_code, price_list, uom=uom, as_of_date=as_of_date),
    }


# ── Warehouse List ────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_warehouses(disabled=0):
    """Return all active warehouses for dropdowns."""
    filters = {}
    if not int(disabled):
        filters["disabled"] = 0
    return frappe.get_all(
        "Warehouse",
        filters=filters,
        fields=["name", "warehouse_name", "warehouse_type", "parent_warehouse",
                "city", "is_group", "disabled"],
        order_by="warehouse_name asc",
    )


# ── Quick Stock Check ─────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def check_stock_availability(item_code, warehouse, required_qty):
    """
    Used by Sales Order / Invoice to verify stock before confirming.
    Returns {available, sufficient, shortage}.
    """
    available = get_stock_balance(item_code, warehouse)
    req = flt(required_qty)
    return {
        "item_code":    item_code,
        "warehouse":    warehouse,
        "available_qty":available,
        "required_qty": req,
        "sufficient":   available >= req,
        "shortage":     max(0, req - available),
    }


# ── Dashboard KPIs (for Inventory section) ───────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_inventory_kpis(company=None):
    """
    Return key inventory metrics for the dashboard:
    - Total stock value
    - Items below reorder level
    - Total items tracked
    - Warehouses with stock
    """
    filters = {"actual_qty": [">", 0]}
    if company:
        filters["company"] = company

    bins = frappe.get_all("Bin", filters=filters,
                          fields=["item_code", "warehouse", "stock_value"])

    unique_items = len({b.item_code for b in bins})
    unique_wh    = len({b.warehouse for b in bins})
    total_value  = sum(flt(b.stock_value) for b in bins)

    reorder = get_reorder_alerts(company=company or None)

    return {
        "total_stock_value":   total_value,
        "unique_items_in_stock": unique_items,
        "warehouses_with_stock": unique_wh,
        "reorder_alerts":      len(reorder),
        "reorder_items":       reorder[:10],   # top-10 most critical
    }
