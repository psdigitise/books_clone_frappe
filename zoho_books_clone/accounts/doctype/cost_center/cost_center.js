frappe.ui.form.on("Cost Center", {
  onload(frm) {
    if (frm.is_new() && !frm.doc.company)
      frm.set_value("company", frappe.defaults.get_default("company"));
  },
  setup(frm) {
    frm.set_query("parent_cost_center", () => ({
      filters: { company: frm.doc.company, is_group: 1 }
    }));
  },
});
