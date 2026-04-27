"""Print P&L and Balance Sheet rows."""
import frappe
from frappe.utils import today, add_days
frappe.connect(site="site1.local")
frappe.set_user("halenjosh1928@gmail.com")

filters = {"company": "Eiffele gaming", "from_date": add_days(today(),-30),
           "to_date": add_days(today(),30), "as_of_date": today()}

for path in [
    "zoho_books_clone.reports.report.profit_and_loss.profit_and_loss",
    "zoho_books_clone.reports.report.balance_sheet.balance_sheet",
    "zoho_books_clone.reports.report.general_ledger.general_ledger",
]:
    label = path.rsplit(".",1)[1]
    print(f"\n=== {label} ===")
    cols, rows = frappe.get_module(path).execute(filters)[:2]
    for r in rows:
        keys = ["account", "amount", "balance", "debit", "credit", "label", "voucher_no"]
        snippet = {k: r.get(k) for k in keys if k in r}
        print(" ", snippet)
