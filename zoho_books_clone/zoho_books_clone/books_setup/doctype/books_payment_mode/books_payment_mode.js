frappe.ui.form.on("Books Payment Mode", {
  setup(frm) {
    frm.set_query("gl_account", () => ({
      filters: { account_type: ["in", ["Bank","Cash"]], is_group: 0 }
    }));
  },
});
