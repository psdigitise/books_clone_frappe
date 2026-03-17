frappe.ui.form.on("Payment Terms", {
  refresh(frm) {
    if (frm.doc.credit_days) {
      frm.set_intro(
        __("Invoices using this term are due {0} day(s) after the invoice date", [frm.doc.credit_days]),
        "blue"
      );
    }
  },
});
