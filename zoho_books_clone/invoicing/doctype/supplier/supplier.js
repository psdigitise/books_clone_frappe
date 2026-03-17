frappe.ui.form.on("Supplier", {
  setup(frm) {
    frm.set_query("default_payable_account", () => ({
      filters: { account_type: "Payable", is_group: 0 }
    }));
  },

  refresh(frm) {
    if (!frm.is_new()) {
      frm.add_custom_button(__("View Bills"), () =>
        frappe.set_route("List", "Purchase Invoice", { supplier: frm.doc.name })
      );
      frm.add_custom_button(__("New Bill"), () => {
        frappe.new_doc("Purchase Invoice", { supplier: frm.doc.name });
      });
    }
  },
});
