import frappe
from frappe.utils import flt


def auto_match_bank_transactions():
    """Daily scheduler: try to auto-reconcile unmatched bank transactions."""
    unmatched = frappe.get_all(
        "Bank Transaction",
        filters={"status": "Unreconciled", "docstatus": 1},
        fields=["name", "reference_number", "credit", "debit", "date", "bank_account"],
    )
    matched = 0
    for txn in unmatched:
        pe = _match_by_reference(txn) or _match_by_amount_and_date(txn)
        if pe:
            frappe.db.set_value("Bank Transaction", txn["name"], {
                "status": "Reconciled",
                "payment_entry": pe,
            })
            matched += 1
    if matched:
        frappe.db.commit()
    return matched


def _match_by_reference(txn: dict) -> str | None:
    if not txn.get("reference_number"):
        return None
    return frappe.db.get_value(
        "Payment Entry",
        {"reference_no": txn["reference_number"], "docstatus": 1},
        "name",
    )


def _match_by_amount_and_date(txn: dict) -> str | None:
    amount = flt(txn.get("credit") or txn.get("debit"))
    if not amount:
        return None
    result = frappe.db.sql("""
        SELECT name FROM `tabPayment Entry`
        WHERE paid_amount = %s
          AND ABS(DATEDIFF(payment_date, %s)) <= 2
          AND docstatus = 1
          AND name NOT IN (
              SELECT payment_entry FROM `tabBank Transaction`
              WHERE payment_entry IS NOT NULL AND payment_entry != ''
          )
        LIMIT 1
    """, (amount, txn["date"]), as_dict=True)
    return result[0].name if result else None


@frappe.whitelist(methods=["GET", "POST"])
def find_matching_payment(
    bank_account: str, amount: float, date: str, reference: str | None = None
) -> list[dict]:
    """Return candidate Payment Entries for a bank transaction."""
    conditions = ["docstatus = 1", "paid_amount = %(amount)s"]
    params = {"amount": flt(amount)}

    if reference:
        conditions.append("(reference_no = %(ref)s OR reference_no LIKE %(ref_like)s)")
        params["ref"]      = reference
        params["ref_like"] = f"%{reference}%"

    where = " AND ".join(conditions)
    return frappe.db.sql(f"""
        SELECT name, payment_date, paid_amount, party, payment_type, mode_of_payment
        FROM `tabPayment Entry`
        WHERE {where}
          AND name NOT IN (
              SELECT COALESCE(payment_entry, '') FROM `tabBank Transaction`
              WHERE payment_entry IS NOT NULL
          )
        ORDER BY ABS(DATEDIFF(payment_date, %(date)s)) ASC
        LIMIT 10
    """, {**params, "date": date}, as_dict=True)


@frappe.whitelist(methods=["GET", "POST"])
def reconcile_transaction(bank_transaction: str, payment_entry: str) -> None:
    """Link a payment entry to a bank transaction and mark it reconciled."""
    if not frappe.db.exists("Payment Entry", payment_entry):
        frappe.throw(f"Payment Entry {payment_entry} not found")
    frappe.db.set_value("Bank Transaction", bank_transaction, {
        "status": "Reconciled",
        "payment_entry": payment_entry,
    })
    frappe.db.commit()
