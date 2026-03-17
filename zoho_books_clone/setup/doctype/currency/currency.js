frappe.ui.form.on("Currency", {
  refresh(frm) {
    if (!frm.is_new()) {
      frm.dashboard.add_badge(
        frm.doc.enabled ? __("Enabled") : __("Disabled"),
        frm.doc.enabled ? "green" : "gray"
      );
    }
  },
});
