frappe.ui.form.on("Sales Invoice", {
  refresh(frm) {
    // Status indicator
    const color = { Paid: "green", Overdue: "red", Submitted: "blue",
                    "Partly Paid": "orange", Draft: "gray", Cancelled: "darkgrey" };
    frm.dashboard.add_indicator(frm.doc.status, color[frm.doc.status] || "gray");

    if (frm.doc.docstatus === 1) {
      frm.add_custom_button(__("Send Invoice Email"), () => {
        frappe.call({ method: "send_invoice_email", doc: frm.doc,
          callback() { frappe.msgprint(__("Invoice emailed!")); }
        });
      }, __("Actions"));

      frm.add_custom_button(__("Create Payment Entry"), () => {
        frappe.model.open_mapped_doc({
          method: "zoho_books_clone.payments.utils.make_payment_entry_from_invoice",
          frm,
        });
      }, __("Actions"));

      frm.add_custom_button(__("View GL Entries"), () => {
        frappe.set_route("List", "General Ledger Entry", {
          voucher_type: "Sales Invoice", voucher_no: frm.doc.name,
        });
      });
    }
  },

  customer(frm) {
    if (frm.doc.customer) {
      frappe.db.get_value("Customer", frm.doc.customer,
        ["customer_name", "default_currency", "payment_terms"],
        (r) => {
          frm.set_value("currency", r.default_currency || "INR");
          if (r.payment_terms) frm.set_value("payment_terms", r.payment_terms);
        }
      );
    }
  },

  calculate_totals(frm) {
    let net = 0;
    (frm.doc.items || []).forEach(i => { net += (i.qty || 0) * (i.rate || 0); });
    const tax = (frm.doc.taxes || []).reduce((s, t) => s + (t.tax_amount || 0), 0);
    frm.set_value("net_total",   net);
    frm.set_value("total_tax",   tax);
    frm.set_value("grand_total", net + tax);
  },
});

frappe.ui.form.on("Sales Invoice Item", {
  qty(frm, cdt, cdn) { frm.trigger("calculate_totals"); },
  rate(frm, cdt, cdn) { frm.trigger("calculate_totals"); },
  items_remove(frm)  { frm.trigger("calculate_totals"); },
});
