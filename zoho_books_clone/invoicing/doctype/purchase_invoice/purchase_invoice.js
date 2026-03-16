
/* ── Purchase Invoice — Full working JS ─────────────────────────────────── */

frappe.ui.form.on("Purchase Invoice", {

  setup(frm) {
    frm.set_query("credit_to",       () => ({ filters: { account_type: "Payable",  company: frm.doc.company, is_group: 0 } }));
    frm.set_query("expense_account", () => ({ filters: { account_type: "Expense",  company: frm.doc.company, is_group: 0 } }));
    frm.set_query("account_head", "taxes", () => ({ filters: { account_type: ["in",["Tax","Liability"]], company: frm.doc.company, is_group: 0 } }));
  },

  refresh(frm) {
    _pi_status_bar(frm);
    if (frm.doc.docstatus === 1) {
      _pi_pay_progress(frm);
      frm.add_custom_button(__("Record Payment"), () => _pi_pay_dialog(frm), __("Actions"));
      frm.add_custom_button(__("View GL Entries"), () =>
        frappe.set_route("query-report", "General Ledger", { voucher_no: frm.doc.name })
      );
    }
    if (frm.doc.docstatus === 0) setTimeout(() => _pi_recalc_all(frm), 100);
    frm.set_df_property("net_total",   "read_only", 1);
    frm.set_df_property("total_tax",   "read_only", 1);
    frm.set_df_property("grand_total", "read_only", 1);
  },

  onload(frm) {
    if (frm.is_new() && !frm.doc.company)
      frm.set_value("company", frappe.defaults.get_default("company"));
    if (frm.is_new() && !frm.doc.posting_date)
      frm.set_value("posting_date", frappe.datetime.get_today());
  },

  supplier(frm) {
    if (!frm.doc.supplier) return;
    frappe.db.get_value("Supplier", frm.doc.supplier, ["supplier_name","default_currency"], r => {
      frm.set_value("supplier_name", r.supplier_name || frm.doc.supplier);
      if (r.default_currency) frm.set_value("currency", r.default_currency);
    });
    _pi_set_defaults(frm);
  },

  company(frm) {
    frm.set_query("credit_to",       () => ({ filters: { account_type: "Payable",  company: frm.doc.company, is_group: 0 } }));
    frm.set_query("expense_account", () => ({ filters: { account_type: "Expense",  company: frm.doc.company, is_group: 0 } }));
    _pi_set_defaults(frm);
  },

  posting_date(frm) {
    if (!frm.doc.due_date) frm.set_value("due_date", frm.doc.posting_date);
  },
});

frappe.ui.form.on("Purchase Invoice Item", {
  item_code(frm, cdt, cdn) {
    const row = locals[cdt][cdn];
    if (!row.item_code) return;
    frappe.db.get_value("Item", row.item_code, ["item_name","standard_rate","expense_account"], r => {
      frappe.model.set_value(cdt, cdn, "item_name", r.item_name || row.item_code);
      frappe.model.set_value(cdt, cdn, "rate",      r.standard_rate || 0);
      if (r.expense_account) frappe.model.set_value(cdt, cdn, "expense_account", r.expense_account);
      _pi_calc_row(frm, cdt, cdn);
    });
  },
  qty(frm, cdt, cdn)  { _pi_calc_row(frm, cdt, cdn); },
  rate(frm, cdt, cdn) { _pi_calc_row(frm, cdt, cdn); },
  amount(frm)         { _pi_recalc_totals(frm); },
  items_remove(frm)   { _pi_recalc_totals(frm); },
});

frappe.ui.form.on("Tax Line", {
  rate(frm, cdt, cdn) {
    const row = locals[cdt][cdn];
    const net = (frm.doc.items||[]).reduce((s,i)=>s+flt(i.qty)*flt(i.rate),0);
    if (flt(row.rate) > 0 && net > 0)
      frappe.model.set_value(cdt, cdn, "tax_amount", _r(net * flt(row.rate) / 100));
  },
  tax_amount(frm)   { _pi_recalc_totals(frm); },
  taxes_remove(frm) { _pi_recalc_totals(frm); },
});

function _pi_calc_row(frm, cdt, cdn) {
  const row = locals[cdt][cdn];
  frappe.model.set_value(cdt, cdn, "amount", _r(flt(row.qty) * flt(row.rate)));
}

function _pi_recalc_all(frm) {
  (frm.doc.items||[]).forEach(row => {
    const exp = _r(flt(row.qty)*flt(row.rate));
    if (row.amount !== exp) frappe.model.set_value("Purchase Invoice Item", row.name, "amount", exp);
  });
  _pi_recalc_totals(frm);
}

function _pi_recalc_totals(frm) {
  const net = (frm.doc.items||[]).reduce((s,i)=>s+flt(i.qty)*flt(i.rate),0);
  (frm.doc.taxes||[]).forEach(tax => {
    if (flt(tax.rate) > 0 && net > 0 && !flt(tax.tax_amount))
      frappe.model.set_value("Tax Line", tax.name, "tax_amount", _r(net*flt(tax.rate)/100));
  });
  const taxTotal = (frm.doc.taxes||[]).reduce((s,t)=>s+flt(t.tax_amount),0);
  frm.set_value("net_total",   _r(net));
  frm.set_value("total_tax",   _r(taxTotal));
  frm.set_value("grand_total", _r(net+taxTotal));
}

function _pi_set_defaults(frm) {
  if (!frm.doc.company) return;
  if (!frm.doc.credit_to)
    frappe.db.get_value("Account",{account_type:"Payable",company:frm.doc.company,is_group:0},"name",r=>{if(r?.name)frm.set_value("credit_to",r.name);});
  if (!frm.doc.expense_account)
    frappe.db.get_value("Account",{account_type:"Expense",company:frm.doc.company,is_group:0},"name",r=>{if(r?.name)frm.set_value("expense_account",r.name);});
}

function _pi_status_bar(frm) {
  frm.layout?.wrapper?.find(".pi-status-bar").remove();
  if (frm.doc.status === "Cancelled") return;
  const steps=["Draft","Submitted","Partly Paid","Paid"];
  const order={Draft:0,Submitted:1,"Partly Paid":2,Paid:3,Overdue:1};
  const ci=order[frm.doc.status||"Draft"]??0;
  const html=steps.map((s,i)=>{
    const done=i<ci,act=i===ci;
    return `<div style="display:flex;align-items:center;gap:5px;${i<steps.length-1?"flex:1;":""}">
      <div style="width:22px;height:22px;border-radius:50%;display:flex;align-items:center;
                  justify-content:center;font-size:11px;font-weight:600;flex-shrink:0;
                  background:${done||act?"#3B5BDB":"#E8ECF0"};color:${done||act?"#fff":"#868E96"}">
        ${done?"✓":i+1}</div>
      <span style="font-size:12px;font-weight:${act?600:400};
                   color:${act?"#3B5BDB":done?"#1A1D23":"#868E96"};white-space:nowrap">${__(s)}</span>
      ${i<steps.length-1?'<div style="flex:1;height:1px;background:#E8ECF0;margin:0 8px;min-width:16px"></div>':""}
    </div>`;
  }).join("");
  frm.layout?.wrapper?.prepend(
    $(`<div class="pi-status-bar" style="display:flex;align-items:center;background:#fff;
       border:1px solid #E8ECF0;border-radius:8px;padding:12px 20px;margin-bottom:10px;gap:4px">
      ${html}</div>`)
  );
}

function _pi_pay_progress(frm) {
  frm.layout?.wrapper?.find(".pi-pay-bar").remove();
  const grand=flt(frm.doc.grand_total);if(!grand)return;
  const paid=grand-flt(frm.doc.outstanding_amount);
  const pct=Math.min(100,(paid/grand)*100);
  const color=pct>=100?"#2F9E44":pct>0?"#E67700":"#C92A2A";
  const fmt=n=>"₹"+flt(n).toLocaleString("en-IN",{minimumFractionDigits:2});
  frm.layout?.wrapper?.prepend(
    $(`<div class="pi-pay-bar" style="background:#fff;border:1px solid #E8ECF0;border-radius:8px;
       padding:12px 20px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;">
        <span style="color:#868E96">${__("Payment Progress")}</span>
        <span style="font-weight:600;color:${color}">${fmt(paid)} of ${fmt(grand)}</span>
      </div>
      <div style="background:#F1F3F5;border-radius:4px;height:6px;overflow:hidden;">
        <div style="background:${color};height:100%;width:${pct}%;border-radius:4px;transition:width .4s"></div>
      </div>
      <div style="text-align:right;font-size:11px;color:${color};margin-top:4px">
        ${pct>=100?__("Fully Paid"):fmt(flt(frm.doc.outstanding_amount))+" "+__("outstanding")}
      </div>
    </div>`)
  );
}

function _pi_pay_dialog(frm) {
  const outstanding=flt(frm.doc.outstanding_amount);
  if(outstanding<=0){frappe.show_alert({message:__("Already paid"),indicator:"green"});return;}
  const d=new frappe.ui.Dialog({
    title:__("Pay Bill — {0}",[frm.doc.name]),
    fields:[
      {fieldname:"paid_amount",label:__("Amount"),fieldtype:"Currency",default:outstanding,reqd:1},
      {fieldname:"payment_date",label:__("Date"),fieldtype:"Date",default:frappe.datetime.get_today(),reqd:1},
      {fieldname:"mode_of_payment",label:__("Mode"),fieldtype:"Link",options:"Mode of Payment",default:"Bank Transfer"},
      {fieldname:"reference_no",label:__("Reference No"),fieldtype:"Data"},
      {fieldname:"paid_from",label:__("Pay From (Bank/Cash Account)"),fieldtype:"Link",options:"Account",reqd:1,
       get_query:()=>({filters:{account_type:["in",["Bank","Cash"]],company:frm.doc.company,is_group:0}})},
    ],
    primary_action_label:__("Create & Submit Payment"),
    primary_action(vals){
      frappe.call({
        method:"zoho_books_clone.payments.utils.make_payment_entry_from_purchase_invoice",
        args:{source_name:frm.doc.name,...vals},
        freeze:true,freeze_message:__("Creating payment..."),
        callback({message:pe_name}){
          d.hide();
          frappe.show_alert({message:__("Payment {0} created",[pe_name]),indicator:"green"});
          frm.reload_doc();
        }
      });
    }
  });
  d.show();
}

function _r(n,p=2){return Math.round(n*Math.pow(10,p))/Math.pow(10,p);}
