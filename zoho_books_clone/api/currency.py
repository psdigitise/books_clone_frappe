"""
Currency & Exchange Rate API — Audit: Multi-Currency Incomplete.

Provides:
  - Exchange rate storage and lookup (Currency Exchange DocType)
  - Conversion helpers used by GL posting and invoice controllers
  - Whitelisted endpoints called by the Books SPA for currency dropdowns
    and rate lookups.

Exchange Rate storage model:
  - DocType: Currency Exchange
  - Fields: from_currency, to_currency, exchange_rate, date
  - The most-recent rate on or before the transaction date is used.
  - If no rate exists, falls back to 1.0 (same-currency assumption).

GL multi-currency approach:
  - Every GL entry stores: currency, exchange_rate, debit/credit (base).
  - The transaction-currency amounts (debit_in_account_currency,
    credit_in_account_currency) are derived by dividing base amounts
    by the exchange rate.
  - This keeps existing reporting (which uses base amounts) unchanged
    while adding currency traceability.
"""

import frappe
from frappe import _
from frappe.utils import flt, getdate, today


# ─── Whitelisted endpoints ────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_exchange_rate(from_currency: str, to_currency: str, date: str = None) -> dict:
    """
    Return the effective exchange rate between two currencies on a given date.
    Falls back to 1.0 if currencies are the same or no rate is configured.

    Response: {from_currency, to_currency, date, exchange_rate, source}
    """
    date = date or today()

    if from_currency == to_currency:
        return {
            "from_currency":  from_currency,
            "to_currency":    to_currency,
            "date":           date,
            "exchange_rate":  1.0,
            "source":         "same_currency",
        }

    rate, source = _lookup_rate(from_currency, to_currency, date)
    return {
        "from_currency":  from_currency,
        "to_currency":    to_currency,
        "date":           date,
        "exchange_rate":  rate,
        "source":         source,
    }


@frappe.whitelist(allow_guest=False)
def save_exchange_rate(from_currency: str, to_currency: str,
                       exchange_rate: float, date: str = None):
    """
    Store a manual exchange rate.  Creates a new Currency Exchange record.
    Returns the created document name.
    """
    date = date or today()
    rate = flt(exchange_rate)
    if rate <= 0:
        frappe.throw(_("Exchange rate must be greater than 0."))

    doc = frappe.get_doc({
        "doctype":       "Currency Exchange",
        "from_currency": from_currency,
        "to_currency":   to_currency,
        "exchange_rate": rate,
        "date":          date,
    })
    doc.flags.ignore_permissions = True
    doc.insert()
    frappe.db.commit()
    return {"name": doc.name, "exchange_rate": rate}


@frappe.whitelist(allow_guest=False)
def get_currency_list():
    """Return all enabled currencies for dropdowns."""
    return frappe.get_all(
        "Currency",
        filters={"enabled": 1},
        fields=["name", "currency_name", "currency_symbol"],
        order_by="currency_name asc",
    )


@frappe.whitelist(allow_guest=False)
def convert_amount(amount: float, from_currency: str,
                   to_currency: str, date: str = None) -> dict:
    """
    Convert an amount from one currency to another using the stored rate.
    Returns {original_amount, converted_amount, exchange_rate}.
    """
    date = date or today()
    rate, _ = _lookup_rate(from_currency, to_currency, date)
    converted = flt(amount) * flt(rate)
    return {
        "original_amount":  flt(amount),
        "from_currency":    from_currency,
        "to_currency":      to_currency,
        "exchange_rate":    rate,
        "converted_amount": round(converted, 2),
        "date":             date,
    }


@frappe.whitelist(allow_guest=False)
def get_rate_history(from_currency: str, to_currency: str,
                     from_date: str = None, to_date: str = None) -> list:
    """Return historical exchange rates for a currency pair."""
    filters = {
        "from_currency": from_currency,
        "to_currency":   to_currency,
    }
    if from_date:
        filters["date"] = [">=", from_date]

    rows = frappe.get_all(
        "Currency Exchange",
        filters=filters,
        fields=["name", "date", "exchange_rate"],
        order_by="date desc",
        limit=200,
    )
    if to_date:
        rows = [r for r in rows if getdate(r.date) <= getdate(to_date)]
    return rows


# ─── Internal helpers (used by accounting_engine and stock_entry) ─────────────

def get_rate(from_currency: str, to_currency: str, date: str = None) -> float:
    """
    Public helper for internal code — returns just the float rate.
    Use this from accounting_engine / stock_entry when posting multi-currency GL.
    """
    if from_currency == to_currency:
        return 1.0
    rate, _ = _lookup_rate(from_currency, to_currency, date or today())
    return rate


def to_base_currency(amount: float, currency: str,
                     base_currency: str, date: str = None) -> float:
    """
    Convert transaction-currency amount to base currency.
    Returns the base-currency amount (what goes into GL debit/credit).
    """
    rate = get_rate(currency, base_currency, date)
    return round(flt(amount) * flt(rate), 2)


def _lookup_rate(from_currency: str, to_currency: str, date: str) -> tuple[float, str]:
    """
    Find the most recent Currency Exchange record on or before `date`.
    Returns (rate, source_string).
    """
    # Try direct pair
    result = frappe.db.sql("""
        SELECT exchange_rate FROM `tabCurrency Exchange`
        WHERE from_currency = %(fc)s
          AND to_currency   = %(tc)s
          AND date          <= %(date)s
        ORDER BY date DESC
        LIMIT 1
    """, {"fc": from_currency, "tc": to_currency, "date": date}, as_dict=True)

    if result:
        return flt(result[0].exchange_rate), "stored_rate"

    # Try inverse pair (1 / rate)
    inverse = frappe.db.sql("""
        SELECT exchange_rate FROM `tabCurrency Exchange`
        WHERE from_currency = %(tc)s
          AND to_currency   = %(fc)s
          AND date          <= %(date)s
        ORDER BY date DESC
        LIMIT 1
    """, {"fc": from_currency, "tc": to_currency, "date": date}, as_dict=True)

    if inverse and flt(inverse[0].exchange_rate):
        return round(1.0 / flt(inverse[0].exchange_rate), 6), "inverse_rate"

    # No rate found — default to 1.0 and log a warning
    frappe.log_error(
        f"No exchange rate found for {from_currency} → {to_currency} on {date}. "
        "Defaulting to 1.0. Please add a rate in Currency Exchange.",
        "Multi-Currency Warning",
    )
    return 1.0, "default_no_rate"
