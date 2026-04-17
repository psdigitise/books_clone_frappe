"""
clear_data.py
Run with:
  bench --site site1.local execute zoho_books_clone.scripts.clear_data.execute

Deletes ALL transactional data (invoices, payments, GL entries, stock, customers,
vendors, etc.) while keeping the app installed with its schema and seeded
reference data (COA, UOMs, currencies, warehouses, item groups, payment modes).
"""

import frappe


# Tables to truncate — order matters: children before parents, and
# GL/Stock ledgers before the docs that created them.
TABLES = [
    # ── GL ────────────────────────────────────────────────────────────────────
    "General Ledger Entry",

    # ── Stock Ledger ──────────────────────────────────────────────────────────
    "Stock Ledger Entry",

    # ── Payment child ─────────────────────────────────────────────────────────
    "Payment Entry Reference",

    # ── Journal Entry child ───────────────────────────────────────────────────
    "Journal Entry Account",

    # ── Invoice children ──────────────────────────────────────────────────────
    "Sales Invoice Item",
    "Purchase Invoice Item",
    "Credit Note Item",

    # ── Tax lines (child table shared across invoice types) ───────────────────
    "Tax Line",
    "Sales Taxes and Charges",
    "Purchase Taxes and Charges",

    # ── Stock Entry child ─────────────────────────────────────────────────────
    "Stock Entry Detail",

    # ── Quotation / Order children ────────────────────────────────────────────
    "Quotation Item",
    "Sales Order Item",
    "Purchase Order Item",

    # ── Expense claim child ───────────────────────────────────────────────────
    "Expense Claim Detail",

    # ── Parent transactional documents ────────────────────────────────────────
    "Sales Invoice",
    "Purchase Invoice",
    "Payment Entry",
    "Journal Entry",
    "Credit Note",
    "Debit Note",
    "Stock Entry",
    "Quotation",
    "Sales Order",
    "Purchase Order",
    "Expense",
    "Expense Claim",
    "Bank Transaction",
    "E-Way Bill",

    # ── Contacts / Parties ────────────────────────────────────────────────────
    "Customer",
    "Supplier",

    # ── Item Prices (transactional, not master) ───────────────────────────────
    "Item Price",
]


def execute():
    """Entry point for bench execute."""
    frappe.flags.in_migrate = True  # suppress some hooks

    deleted_counts = {}

    for doctype in TABLES:
        table = f"`tab{doctype}`"
        try:
            count = frappe.db.sql(f"SELECT COUNT(*) FROM {table}")[0][0]
            frappe.db.sql(f"DELETE FROM {table}")
            deleted_counts[doctype] = count
            print(f"  ✅  Cleared {count:>6,} rows  →  {doctype}")
        except Exception as err:
            msg = str(err)
            # Table may not exist if the doctype is optional / not yet installed
            if "doesn't exist" in msg or "doesn't exist" in msg.lower():
                print(f"  ⚪  Skipped (table missing)  →  {doctype}")
            else:
                print(f"  ⚠️   Error clearing {doctype}: {msg}")

    # ── Reset Bin quantities to zero (keep the Bin records, just zero them) ───
    try:
        count = frappe.db.sql("SELECT COUNT(*) FROM `tabBin`")[0][0]
        frappe.db.sql("""
            UPDATE `tabBin`
            SET actual_qty    = 0,
                reserved_qty  = 0,
                ordered_qty   = 0,
                projected_qty = 0,
                stock_value   = 0,
                valuation_rate = 0
        """)
        print(f"  ✅  Reset    {count:>6,} rows  →  Bin (quantities zeroed)")
    except Exception as err:
        print(f"  ⚠️   Error resetting Bin: {err}")

    # ── Reset cached Account balances to zero ─────────────────────────────────
    try:
        frappe.db.sql("UPDATE `tabAccount` SET balance = 0")
        print("  ✅  Reset Account.balance → 0 for all accounts")
    except Exception as err:
        print(f"  ⚠️   Error resetting Account balances: {err}")

    # ── Reset Naming Series counters ──────────────────────────────────────────
    series_prefixes = [
        "INV-.YYYY.-.#####.",
        "PINV-.YYYY.-.#####.",
        "PAY-.YYYY.-.#####.",
        "BTXN-.YYYY.-.#####.",
        "CUST-.YYYY.-.#####.",
        "SUPP-.YYYY.-.#####.",
    ]
    for prefix in series_prefixes:
        try:
            frappe.db.sql(
                "UPDATE `tabSeries` SET current = 0 WHERE name = %s", prefix
            )
        except Exception:
            pass
    print("  ✅  Reset naming series counters")

    frappe.db.commit()

    total_deleted = sum(deleted_counts.values())
    print(f"\n🎉  Done! {total_deleted:,} total rows removed. App is now fresh.\n")
