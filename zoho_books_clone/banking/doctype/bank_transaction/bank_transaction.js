
frappe.ui.form.on("Bank Transaction", {
  refresh(frm) {
    if (frm.doc.docstatus === 1 && frm.doc.status === "Unreconciled") {
      frm.add_custom_button(__("Find Matching Payment"), () => _find_match(frm));
      frm.add_custom_button(__("Mark Reconciled"), () => {
        frappe.prompt({
          label: __("Payment Entry"), fieldname: "pe", fieldtype: "Link",
          options: "Payment Entry", reqd: 1
        }, ({ pe }) => _reconcile(frm, pe),
        __("Link Payment Entry"));
      });
    }
  },
});

function _find_match(frm) {
  frappe.call({
    method: "zoho_books_clone.banking.utils.find_matching_payment",
    args: {
      bank_account: frm.doc.bank_account,
      amount:       frm.doc.credit || frm.doc.debit,
      date:         frm.doc.date,
      reference:    frm.doc.reference_number,
    },
    callback({ message }) {
      if (!message || !message.length) {
        frappe.show_alert({ message: __("No matching payment found"), indicator: "orange" });
        return;
      }
      const matches = message.map(m =>
        `<tr style="cursor:pointer" onclick="frappe.db.open_in_new_tab('Payment Entry','${m.name}')">
          <td style="padding:8px 12px">${m.name}</td>
          <td style="padding:8px 12px">${m.payment_date}</td>
          <td style="padding:8px 12px;text-align:right">₹${flt(m.paid_amount).toLocaleString("en-IN",{minimumFractionDigits:2})}</td>
          <td style="padding:8px 12px">${m.party || ""}</td>
        </tr>`
      ).join("");
      frappe.msgprint(`
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#F8F9FC">
            <th style="padding:8px 12px;text-align:left">Payment</th>
            <th style="padding:8px 12px;text-align:left">Date</th>
            <th style="padding:8px 12px;text-align:right">Amount</th>
            <th style="padding:8px 12px;text-align:left">Party</th>
          </tr></thead>
          <tbody>${matches}</tbody>
        </table>`, __("Possible Matches"));
    }
  });
}

function _reconcile(frm, pe_name) {
  frappe.call({
    method: "zoho_books_clone.banking.utils.reconcile_transaction",
    args: { bank_transaction: frm.doc.name, payment_entry: pe_name },
    callback() {
      frappe.show_alert({ message: __("Reconciled successfully"), indicator: "green" });
      frm.reload_doc();
    }
  });
}
