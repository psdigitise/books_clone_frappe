frappe.ui.form.on("Customer", {
  setup(frm) {
    frm.set_query("default_receivable_account", () => ({
      filters: { account_type: "Receivable", is_group: 0 }
    }));
  },

  refresh(frm) {
    if (!frm.is_new()) {
      frm.add_custom_button(__("View Invoices"), () =>
        frappe.set_route("List", "Sales Invoice", { customer: frm.doc.name })
      );
      frm.add_custom_button(__("New Invoice"), () => {
        frappe.new_doc("Sales Invoice", { customer: frm.doc.name });
      });
    }
  },

  customer_name(frm) {
    // Auto-suggest naming series won't collide
  },
});
