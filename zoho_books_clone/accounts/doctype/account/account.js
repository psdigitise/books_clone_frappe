frappe.ui.form.on("Account", {
  refresh(frm) {
    if (!frm.is_new()) {
      frm.add_custom_button(__("View Ledger"), () =>
        frappe.set_route("query-report", "General Ledger", { account: frm.doc.name })
      );
      frm.add_custom_button(__("Account Balance"), () => {
        frappe.call({ method: "get_account_balance", doc: frm.doc, callback({ message: m }) {
          frappe.msgprint(
            `<b>Debit:</b> ${format_currency(m.debit)}<br>
             <b>Credit:</b> ${format_currency(m.credit)}<br>
             <b>Net:</b> ${format_currency(m.balance)}`,
            __("Account Balance")
          );
        }});
      });
    }
  },
});
