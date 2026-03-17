"""
Patch: create performance indexes on high-traffic tables.
Run once on first migrate.
"""
import frappe


def execute():
    _idx("tabGeneral Ledger Entry", "gl_account_date",      ["account", "posting_date"])
    _idx("tabGeneral Ledger Entry", "gl_voucher",           ["voucher_type", "voucher_no"])
    _idx("tabGeneral Ledger Entry", "gl_company_date",      ["company", "posting_date"])
    _idx("tabGeneral Ledger Entry", "gl_party",             ["party_type", "party"])
    _idx("tabSales Invoice",        "si_customer_status",   ["customer", "status"])
    _idx("tabSales Invoice",        "si_posting_date",      ["posting_date"])
    _idx("tabSales Invoice",        "si_outstanding",       ["outstanding_amount"])
    _idx("tabPurchase Invoice",     "pi_supplier_status",   ["supplier", "status"])
    _idx("tabPurchase Invoice",     "pi_posting_date",      ["posting_date"])
    _idx("tabPayment Entry",        "pe_party",             ["party_type", "party"])
    _idx("tabPayment Entry",        "pe_date",              ["payment_date"])
    _idx("tabBank Transaction",     "bt_account_date",      ["bank_account", "date"])
    _idx("tabBank Transaction",     "bt_status",            ["status"])
    _idx("tabAccount",              "acc_company_type",     ["company", "account_type"])
    frappe.db.commit()
    print("✅ Indexes created")


def _idx(table: str, name: str, cols: list[str]) -> None:
    """Create index if it does not already exist."""
    existing = frappe.db.sql(
        f"SHOW INDEX FROM `{table}` WHERE Key_name = %s", name
    )
    if existing:
        return
    col_str = ", ".join(f"`{c}`" for c in cols)
    frappe.db.sql(f"ALTER TABLE `{table}` ADD INDEX `{name}` ({col_str})")
    print(f"   ↳ {table}.{name}")
