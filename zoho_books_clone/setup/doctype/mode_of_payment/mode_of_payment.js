frappe.ui.form.on("Mode of Payment", {
  setup(frm) {
    frm.set_query("gl_account", () => ({
      filters: { account_type: ["in", ["Bank","Cash"]], is_group: 0 }
    }));
  },
});
