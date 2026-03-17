frappe.ui.form.on("Item", {
  setup(frm) {
    frm.set_query("income_account",  () => ({ filters: { account_type: "Income",  is_group: 0 } }));
    frm.set_query("expense_account", () => ({ filters: { account_type: "Expense", is_group: 0 } }));
    frm.set_query("stock_uom",       () => ({ filters: { enabled: 1 } }));
  },

  refresh(frm) {
    if (!frm.is_new()) {
      frm.add_custom_button(__("View Sales Invoices"), () =>
        frappe.set_route("List", "Sales Invoice Item", { item_code: frm.doc.name })
      );
    }
  },

  item_code(frm) {
    if (!frm.doc.item_name) {
      frm.set_value("item_name", frm.doc.item_code);
    }
  },
});
