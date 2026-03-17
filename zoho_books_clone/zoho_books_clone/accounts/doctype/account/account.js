
frappe.ui.form.on("Account", {

  onload(frm) {
    if (frm.is_new() && !frm.doc.company)
      frm.set_value("company", frappe.defaults.get_default("company"));
    if (frm.is_new() && !frm.doc.currency)
      frm.set_value("currency", "INR");
  },

  setup(frm) {
    frm.set_query("parent_account", () => ({
      filters: { company: frm.doc.company, is_group: 1 }
    }));
  },

  refresh(frm) {
    if (frm.is_new()) return;

    frm.add_custom_button(__("View General Ledger"), () =>
      frappe.set_route("query-report", "General Ledger", { account: frm.doc.name })
    );

    frm.add_custom_button(__("Account Balance"), () =>
      frappe.call({
        method: "get_account_balance", doc: frm.doc,
        callback({ message: m }) {
          const fmt = n => "₹"+flt(n).toLocaleString("en-IN",{minimumFractionDigits:2});
          frappe.msgprint(`
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:8px;color:#666">Total Debit</td>
                  <td style="padding:8px;text-align:right;font-family:monospace">${fmt(m.debit)}</td></tr>
              <tr><td style="padding:8px;color:#666">Total Credit</td>
                  <td style="padding:8px;text-align:right;font-family:monospace">${fmt(m.credit)}</td></tr>
              <tr style="border-top:2px solid #3B5BDB">
                <td style="padding:10px 8px;font-weight:600">Net Balance</td>
                <td style="padding:10px 8px;text-align:right;font-weight:700;font-family:monospace;
                           color:${m.balance>=0?"#2F9E44":"#C92A2A"}">${fmt(m.balance)}</td>
              </tr>
            </table>`, __("Balance — ") + frm.doc.account_name);
        }
      })
    );

    // Show live balance in dashboard section
    frappe.call({
      method: "get_account_balance", doc: frm.doc,
      callback({ message: m }) {
        if (!m) return;
        const fmt = n => "₹"+flt(n).toLocaleString("en-IN",{minimumFractionDigits:2});
        frm.dashboard.add_section(`
          <div style="padding:8px 0;display:flex;gap:24px;font-size:13px;flex-wrap:wrap">
            <span><span style="color:#868E96">Debit: </span><b style="font-family:monospace">${fmt(m.debit)}</b></span>
            <span><span style="color:#868E96">Credit: </span><b style="font-family:monospace">${fmt(m.credit)}</b></span>
            <span><span style="color:#868E96">Balance: </span>
              <b style="font-family:monospace;color:${m.balance>=0?"#2F9E44":"#C92A2A"}">${fmt(m.balance)}</b></span>
          </div>`, __("Current Balance"));
      }
    });
  },
});
