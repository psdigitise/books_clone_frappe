frappe.ui.form.on("Purchase Invoice", {
  refresh(frm) {
    const color = { Paid:"green", Overdue:"red", Submitted:"blue",
                    "Partly Paid":"orange", Draft:"gray", Cancelled:"darkgrey" };
    frm.dashboard.add_indicator(frm.doc.status, color[frm.doc.status] || "gray");
    if (frm.doc.docstatus === 1) {
      frm.add_custom_button(__("Create Payment"), () => {
        frappe.model.open_mapped_doc({
          method: "zoho_books_clone.payments.utils.make_payment_entry_from_purchase_invoice",
          frm,
        });
      }, __("Actions"));
    }
  },
  supplier(frm) {
    if (frm.doc.supplier) {
      frappe.db.get_value("Supplier", frm.doc.supplier, "default_currency", r => {
        frm.set_value("currency", r.default_currency || "INR");
      });
    }
  },
});
