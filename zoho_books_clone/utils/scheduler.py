import frappe
from frappe.utils import today, add_days, getdate


def send_payment_reminders():
    """Email customers with overdue invoices."""
    overdue = frappe.get_all(
        "Sales Invoice",
        filters={"docstatus":1,"outstanding_amount":[">",0],
                 "due_date":["<", today()]},
        fields=["name","customer","customer_name","grand_total",
                "outstanding_amount","due_date"],
    )
    for inv in overdue:
        email = frappe.db.get_value("Customer", inv.customer, "email_id")
        if not email:
            continue
        frappe.sendmail(
            recipients=[email],
            subject=f"Payment Reminder – Invoice {inv.name}",
            message=(
                f"Dear {inv.customer_name},<br><br>"
                f"Invoice <b>{inv.name}</b> of amount "
                f"<b>₹{inv.outstanding_amount:,.2f}</b> was due on {inv.due_date}.<br>"
                "Please arrange payment at your earliest convenience.<br><br>"
                "Thank you."
            ),
        )


def generate_monthly_reports():
    """Placeholder: generate and email monthly P&L to admin."""
    pass
