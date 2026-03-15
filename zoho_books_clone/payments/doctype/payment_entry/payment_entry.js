frappe.ui.form.on("Payment Entry", {
  refresh(frm) {
    if (frm.doc.docstatus === 0) {
      frm.add_custom_button(__("Fetch Invoices"), () => {
        if (!frm.doc.party) return frappe.msgprint(__("Please select a Party first"));
        frappe.call({
          method: "zoho_books_clone.payments.utils.get_outstanding_invoices",
          args: { party_type: frm.doc.party_type, party: frm.doc.party },
          callback({ message }) {
            frm.clear_table("references");
            message.forEach(inv => {
              const row = frm.add_child("references");
              row.reference_doctype = inv.doctype;
              row.reference_name    = inv.name;
              row.outstanding_amount = inv.outstanding_amount;
              row.allocated_amount   = inv.outstanding_amount;
            });
            frm.refresh_field("references");
          },
        });
      });
    }
  },

  payment_type(frm) {
    if (frm.doc.payment_type === "Receive") {
      frm.set_df_property("party_type", "options", "\nCustomer");
    } else if (frm.doc.payment_type === "Pay") {
      frm.set_df_property("party_type", "options", "\nSupplier\nEmployee");
    }
  },
});
