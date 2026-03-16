
/* ── Payment Entry — Full working JS ──────────────────────────────────── */

frappe.ui.form.on("Payment Entry", {

  setup(frm) {
    frm.set_query("paid_from", () => ({ filters: { account_type: ["in", _paid_from_types(frm)], company: frm.doc.company, is_group: 0 } }));
    frm.set_query("paid_to",   () => ({ filters: { account_type: ["in", _paid_to_types(frm)],   company: frm.doc.company, is_group: 0 } }));
  },

  refresh(frm) {
    if (frm.doc.docstatus === 0 && frm.doc.party_type && frm.doc.party) {
      frm.add_custom_button(__("Get Outstanding Invoices"), () => _fetch_invoices(frm));
    }
    if (frm.doc.docstatus === 1) {
      frm.add_custom_button(__("View GL Entries"), () =>
        frappe.set_route("query-report", "General Ledger", { voucher_no: frm.doc.name })
      );
    }
    _update_alloc_banner(frm);
  },

  onload(frm) {
    if (frm.is_new() && !frm.doc.company)
      frm.set_value("company", frappe.defaults.get_default("company"));
    if (frm.is_new() && !frm.doc.payment_date)
      frm.set_value("payment_date", frappe.datetime.get_today());
  },

  payment_type(frm) {
    frm.set_query("paid_from", () => ({ filters: { account_type: ["in", _paid_from_types(frm)], company: frm.doc.company, is_group: 0 } }));
    frm.set_query("paid_to",   () => ({ filters: { account_type: ["in", _paid_to_types(frm)],   company: frm.doc.company, is_group: 0 } }));
    frm.set_value("paid_from", "");
    frm.set_value("paid_to",   "");
    _auto_fill_accounts(frm);
  },

  party_type(frm) {
    frm.set_value("party", "");
    frm.set_value("party_name", "");
  },

  party(frm) {
    if (!frm.doc.party || !frm.doc.party_type) return;
    const nameField = { Customer: "customer_name", Supplier: "supplier_name", Employee: "employee_name" }[frm.doc.party_type];
    if (nameField)
      frappe.db.get_value(frm.doc.party_type, frm.doc.party, nameField, r =>
        frm.set_value("party_name", r[nameField] || frm.doc.party)
      );
  },

  paid_amount(frm) { _update_alloc_banner(frm); },

  company(frm) { _auto_fill_accounts(frm); },
});

frappe.ui.form.on("Payment Entry Reference", {
  allocated_amount(frm) { _update_alloc_banner(frm); },
  references_remove(frm){ _update_alloc_banner(frm); },
});

function _paid_from_types(frm) {
  if (frm.doc.payment_type === "Receive") return ["Receivable"];
  if (frm.doc.payment_type === "Pay")     return ["Bank", "Cash"];
  return ["Bank", "Cash", "Receivable", "Payable"];
}
function _paid_to_types(frm) {
  if (frm.doc.payment_type === "Receive") return ["Bank", "Cash"];
  if (frm.doc.payment_type === "Pay")     return ["Payable"];
  return ["Bank", "Cash", "Receivable", "Payable"];
}

function _auto_fill_accounts(frm) {
  if (!frm.doc.company || !frm.doc.payment_type) return;
  if (frm.doc.payment_type === "Receive" && !frm.doc.paid_from) {
    frappe.db.get_value("Account",{account_type:"Receivable",company:frm.doc.company,is_group:0},"name",r=>{if(r?.name)frm.set_value("paid_from",r.name);});
    frappe.db.get_value("Account",{account_type:["in",["Bank","Cash"]],company:frm.doc.company,is_group:0},"name",r=>{if(r?.name)frm.set_value("paid_to",r.name);});
  }
  if (frm.doc.payment_type === "Pay" && !frm.doc.paid_to) {
    frappe.db.get_value("Account",{account_type:"Payable",company:frm.doc.company,is_group:0},"name",r=>{if(r?.name)frm.set_value("paid_to",r.name);});
    frappe.db.get_value("Account",{account_type:["in",["Bank","Cash"]],company:frm.doc.company,is_group:0},"name",r=>{if(r?.name)frm.set_value("paid_from",r.name);});
  }
}

function _fetch_invoices(frm) {
  frappe.call({
    method: "zoho_books_clone.payments.utils.get_outstanding_invoices",
    args: { party_type: frm.doc.party_type, party: frm.doc.party },
    callback({ message }) {
      if (!message?.length) {
        frappe.show_alert({ message: __("No outstanding invoices found"), indicator: "orange" });
        return;
      }
      frm.clear_table("references");
      let total = 0;
      message.forEach(inv => {
        const row = frm.add_child("references");
        row.reference_doctype  = frm.doc.payment_type === "Receive" ? "Sales Invoice" : "Purchase Invoice";
        row.reference_name     = inv.name;
        row.outstanding_amount = inv.outstanding_amount;
        row.allocated_amount   = inv.outstanding_amount;
        total += flt(inv.outstanding_amount);
      });
      frm.set_value("paid_amount", total);
      frm.refresh_field("references");
      _update_alloc_banner(frm);
      frappe.show_alert({ message: __("{0} invoice(s) loaded", [message.length]), indicator: "green" });
    }
  });
}

function _update_alloc_banner(frm) {
  frm.layout?.wrapper?.find(".pe-alloc-banner").remove();
  const paid  = flt(frm.doc.paid_amount);
  if (!paid) return;
  const alloc = (frm.doc.references||[]).reduce((s,r)=>s+flt(r.allocated_amount),0);
  const diff  = paid - alloc;
  const color = Math.abs(diff)<0.01 ? "#2F9E44" : diff<0 ? "#C92A2A" : "#E67700";
  const msg   = Math.abs(diff)<0.01 ? __("Fully allocated")
    : diff>0 ? __("{0} unallocated",[_fmt(diff)]) : __("{0} over-allocated",[_fmt(-diff)]);
  frm.layout?.wrapper?.find(".layout-main-section").first().before(
    $(`<div class="pe-alloc-banner" style="background:#fff;border:1px solid #E8ECF0;
       border-radius:8px;padding:10px 20px;margin-bottom:10px;display:flex;
       align-items:center;justify-content:space-between;font-size:13px;">
      <span style="color:#495057">${__("Paid")}: <b>${_fmt(paid)}</b> &nbsp;|&nbsp;
        ${__("Allocated")}: <b>${_fmt(alloc)}</b></span>
      <span style="color:${color};font-weight:600">${msg}</span>
    </div>`)
  );
}

function _fmt(n) { return "₹"+flt(n).toLocaleString("en-IN",{minimumFractionDigits:2}); }
