# ─────────────────────────────────────────────────────────────────────────────
# INTEGRATION GUIDE — Record Payment feature
# Add the lines below to your existing hooks.py
# ─────────────────────────────────────────────────────────────────────────────

# 1. Include the CSS + JS globally in your app
app_include_css = ["/assets/zoho_books_clone/css/record_payment.css"]
app_include_js  = ["/assets/zoho_books_clone/js/record_payment.js"]

# ─────────────────────────────────────────────────────────────────────────────
# USAGE EXAMPLES
# ─────────────────────────────────────────────────────────────────────────────

# ── A) Frappe Form (Sales Invoice doctype) ───────────────────────────────────
# Create:  zoho_books_clone/zoho_books_clone/sales/doctype/sales_invoice/sales_invoice.js
#
#   frappe.ui.form.on("Sales Invoice", {
#       refresh(frm) {
#           if (frm.doc.docstatus === 1 && frm.doc.outstanding_amount > 0) {
#               frm.add_custom_button("Record Payment", () => {
#                   openRecordPaymentDialog(frm.doc.name);
#               }, "Actions");
#           }
#       }
#   });

# ── B) SPA / Vue / React component ──────────────────────────────────────────
# In your invoice detail view, render a button like:
#
#   <button data-record-payment="INV-000002">Record Payment</button>
#
# The JS auto-listener picks up any click on [data-record-payment] elements.
# Or call it directly from code:
#
#   openRecordPaymentDialog("INV-000002");

# ── C) List View action ──────────────────────────────────────────────────────
# In your Invoices list JS:
#
#   frappe.listview_settings["Sales Invoice"] = {
#       button: {
#           show(doc) { return doc.outstanding_amount > 0; },
#           get_label() { return "Record Payment"; },
#           get_description(doc) { return `Record payment for ${doc.name}`; },
#           action(doc) { openRecordPaymentDialog(doc.name); },
#       },
#   };

# ─────────────────────────────────────────────────────────────────────────────
# LISTEN FOR PAYMENT RECORDED (SPA pattern)
# ─────────────────────────────────────────────────────────────────────────────
#
#   window.addEventListener("payment_recorded", (e) => {
#       console.log("Payment recorded:", e.detail);
#       // refresh your invoice list / detail here
#   });
