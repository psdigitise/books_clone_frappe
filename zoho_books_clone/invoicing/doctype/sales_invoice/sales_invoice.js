
/* ── Sales Invoice — Full working JS ─────────────────────────────────────── */

frappe.ui.form.on("Sales Invoice", {

  // Called once when form type is registered
  setup(frm) {
    frm.set_query("debit_to", () => ({
      filters: { account_type: "Receivable", company: frm.doc.company, is_group: 0 }
    }));
    frm.set_query("income_account", () => ({
      filters: { account_type: "Income", company: frm.doc.company, is_group: 0 }
    }));
    frm.set_query("account_head", "taxes", () => ({
      filters: { account_type: ["in", ["Tax","Liability"]], company: frm.doc.company, is_group: 0 }
    }));
    frm.set_query("income_account", "items", () => ({
      filters: { account_type: "Income", company: frm.doc.company, is_group: 0 }
    }));
  },

  // Runs every time the form is opened / refreshed
  refresh(frm) {
    // 1. Status progress bar
    _render_status_bar(frm);

    // 2. Payment progress bar (submitted docs)
    if (frm.doc.docstatus === 1) {
      _render_payment_progress(frm);
    }

    // 3. Action buttons for submitted invoices
    if (frm.doc.docstatus === 1) {
      frm.add_custom_button(__("Record Payment"), () => _payment_dialog(frm), __("Actions"));
      frm.add_custom_button(__("Send Email"), () => _send_email_dialog(frm), __("Actions")); // REPLACED_PLACEHOLDER

      frm.add_custom_button(__("View GL Entries"), () =>
        frappe.set_route("query-report", "General Ledger", {
          voucher_no: frm.doc.name
        })
      );
    }

    // 4. Recalculate all amounts on every refresh (keeps draft in sync)
    if (frm.doc.docstatus === 0) {
      setTimeout(() => _recalculate_all(frm), 100);
    }

    // 5. Make read-only fields visually distinct
    frm.set_df_property("net_total",          "read_only", 1);
    frm.set_df_property("total_tax",          "read_only", 1);
    frm.set_df_property("grand_total",        "read_only", 1);
    frm.set_df_property("outstanding_amount", "read_only", 1);
  },

  // ── Field triggers ─────────────────────────────────────────────────────
  onload(frm) {
    // Auto-fill company from defaults
    if (frm.is_new() && !frm.doc.company) {
      frm.set_value("company", frappe.defaults.get_default("company"));
    }
    if (frm.is_new() && !frm.doc.posting_date) {
      frm.set_value("posting_date", frappe.datetime.get_today());
    }
  },

  customer(frm) {
    if (!frm.doc.customer) return;
    frappe.db.get_value("Customer", frm.doc.customer,
      ["customer_name", "default_currency", "payment_terms"], r => {
        frm.set_value("customer_name", r.customer_name || frm.doc.customer);
        if (r.default_currency) frm.set_value("currency", r.default_currency);
        if (r.payment_terms)    frm.set_value("payment_terms", r.payment_terms);
      });
    // Auto-fill debit_to from company's default AR account
    _set_default_accounts(frm);
  },

  company(frm) {
    if (!frm.doc.company) return;
    // Refresh account filters
    frm.set_query("debit_to",       () => ({ filters: { account_type: "Receivable", company: frm.doc.company, is_group: 0 } }));
    frm.set_query("income_account", () => ({ filters: { account_type: "Income",     company: frm.doc.company, is_group: 0 } }));
    _set_default_accounts(frm);
  },

  posting_date(frm) {
    if (!frm.doc.due_date || frm.doc.due_date === frm.doc.posting_date) {
      frm.set_value("due_date", frm.doc.posting_date);
    }
  },
});

// ── Items child table ────────────────────────────────────────────────────────
frappe.ui.form.on("Sales Invoice Item", {

  item_code(frm, cdt, cdn) {
    const row = locals[cdt][cdn];
    if (!row.item_code) return;
    frappe.db.get_value("Item", row.item_code,
      ["item_name", "description", "standard_rate", "income_account"], r => {
        frappe.model.set_value(cdt, cdn, "item_name",      r.item_name      || row.item_code);
        frappe.model.set_value(cdt, cdn, "description",    r.description    || "");
        frappe.model.set_value(cdt, cdn, "rate",           r.standard_rate  || 0);
        if (r.income_account) frappe.model.set_value(cdt, cdn, "income_account", r.income_account);
        _calc_row(frm, cdt, cdn);
      });
  },

  qty(frm, cdt, cdn)       { _calc_row(frm, cdt, cdn); },
  rate(frm, cdt, cdn)      { _calc_row(frm, cdt, cdn); },
  amount(frm)              { _recalculate_totals(frm); },
  items_remove(frm)        { _recalculate_totals(frm); },
});

// ── Tax child table ──────────────────────────────────────────────────────────
frappe.ui.form.on("Tax Line", {
  rate(frm, cdt, cdn) {
    const row = locals[cdt][cdn];
    const net = flt(frm.doc.net_total) || _calc_net(frm);
    if (flt(row.rate) > 0 && net > 0) {
      frappe.model.set_value(cdt, cdn, "tax_amount", _round(net * flt(row.rate) / 100));
    }
  },
  tax_type(frm, cdt, cdn) {
    // Auto-fill description from tax type
    const row = locals[cdt][cdn];
    if (row.tax_type && !row.description) {
      frappe.model.set_value(cdt, cdn, "description", row.tax_type);
    }
  },
  tax_amount(frm)          { _recalculate_totals(frm); },
  taxes_remove(frm)        { _recalculate_totals(frm); },
});

// ── Private helpers ──────────────────────────────────────────────────────────

function _calc_row(frm, cdt, cdn) {
  const row = locals[cdt][cdn];
  const amt = _round(flt(row.qty) * flt(row.rate));
  frappe.model.set_value(cdt, cdn, "amount", amt);
  // amount trigger fires _recalculate_totals
}

function _calc_net(frm) {
  return (frm.doc.items || []).reduce((s, i) => s + flt(i.qty) * flt(i.rate), 0);
}

function _recalculate_all(frm) {
  let changed = false;
  (frm.doc.items || []).forEach(row => {
    const expected = _round(flt(row.qty) * flt(row.rate));
    if (row.amount !== expected) {
      frappe.model.set_value("Sales Invoice Item", row.name, "amount", expected);
      changed = true;
    }
  });
  if (!changed) _recalculate_totals(frm);
}

function _recalculate_totals(frm) {
  const net = _calc_net(frm);

  // Auto-compute tax_amount for rows that have a rate but no amount
  (frm.doc.taxes || []).forEach(tax => {
    if (flt(tax.rate) > 0 && net > 0 && !flt(tax.tax_amount)) {
      frappe.model.set_value("Tax Line", tax.name, "tax_amount", _round(net * flt(tax.rate) / 100));
    }
  });

  const taxTotal = (frm.doc.taxes || []).reduce((s, t) => s + flt(t.tax_amount), 0);
  const grand    = _round(net + taxTotal);

  frm.set_value("net_total",   _round(net));
  frm.set_value("total_tax",   _round(taxTotal));
  frm.set_value("grand_total", grand);

  // Only update outstanding if this is a new/draft doc
  if (frm.doc.docstatus === 0 && frm.is_new()) {
    frm.set_value("outstanding_amount", grand);
  }
}

function _set_default_accounts(frm) {
  if (!frm.doc.company) return;
  // Auto-fill debit_to with the first Receivable account
  if (!frm.doc.debit_to) {
    frappe.db.get_value("Account",
      { account_type: "Receivable", company: frm.doc.company, is_group: 0 },
      "name", r => { if (r?.name) frm.set_value("debit_to", r.name); }
    );
  }
  // Auto-fill income_account with Sales Revenue
  if (!frm.doc.income_account) {
    frappe.db.get_value("Account",
      { account_type: "Income", company: frm.doc.company, is_group: 0 },
      "name", r => { if (r?.name) frm.set_value("income_account", r.name); }
    );
  }
}

function _render_status_bar(frm) {
  frm.layout?.wrapper?.find(".books-status-bar").remove();
  const steps   = ["Draft", "Submitted", "Partly Paid", "Paid"];
  const order   = { Draft:0, Submitted:1, "Partly Paid":2, Paid:3, Overdue:1, Cancelled:-1 };
  const current = frm.doc.status || "Draft";
  if (current === "Cancelled") return;

  const curIdx = order[current] ?? 0;
  const html   = steps.map((s, i) => {
    const done   = i < curIdx;
    const active = i === curIdx || (s === "Submitted" && current === "Overdue");
    return `
      <div style="display:flex;align-items:center;gap:5px;${i < steps.length-1 ? "flex:1;" : ""}">
        <div style="width:22px;height:22px;border-radius:50%;display:flex;align-items:center;
                    justify-content:center;font-size:11px;font-weight:600;flex-shrink:0;
                    background:${done || active ? "#3B5BDB" : "#E8ECF0"};
                    color:${done || active ? "#fff" : "#868E96"}">
          ${done ? "✓" : i + 1}
        </div>
        <span style="font-size:12px;font-weight:${active ? 600 : 400};
                     color:${active ? "#3B5BDB" : done ? "#1A1D23" : "#868E96"};
                     white-space:nowrap">${__(s)}</span>
        ${i < steps.length-1
          ? '<div style="flex:1;height:1px;background:#E8ECF0;margin:0 8px;min-width:16px"></div>'
          : ""}
      </div>`;
  }).join("");

  frm.layout?.wrapper?.prepend(
    $(`<div class="books-status-bar" style="display:flex;align-items:center;
       background:#fff;border:1px solid #E8ECF0;border-radius:8px;
       padding:12px 20px;margin-bottom:10px;gap:4px">${html}</div>`)
  );
}

function _render_payment_progress(frm) {
  frm.layout?.wrapper?.find(".books-pay-bar").remove();
  const grand = flt(frm.doc.grand_total);
  if (!grand) return;
  const paid  = grand - flt(frm.doc.outstanding_amount);
  const pct   = Math.min(100, (paid / grand) * 100);
  const color = pct >= 100 ? "#2F9E44" : pct > 0 ? "#E67700" : "#C92A2A";
  const fmt   = n => "₹" + flt(n).toLocaleString("en-IN", { minimumFractionDigits: 2 });

  frm.layout?.wrapper?.prepend(
    $(`<div class="books-pay-bar" style="background:#fff;border:1px solid #E8ECF0;
       border-radius:8px;padding:12px 20px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;">
        <span style="color:#868E96">${__("Payment Progress")}</span>
        <span style="font-weight:600;color:${color}">${fmt(paid)} of ${fmt(grand)}</span>
      </div>
      <div style="background:#F1F3F5;border-radius:4px;height:6px;overflow:hidden;">
        <div style="background:${color};height:100%;width:${pct}%;border-radius:4px;transition:width .4s"></div>
      </div>
      <div style="text-align:right;font-size:11px;color:${color};margin-top:4px">
        ${pct >= 100 ? __("Fully Paid") : fmt(flt(frm.doc.outstanding_amount)) + " " + __("outstanding")}
      </div>
    </div>`)
  );
}

function _payment_dialog(frm) {
  const outstanding = flt(frm.doc.outstanding_amount);
  if (outstanding <= 0) {
    frappe.show_alert({ message: __("Invoice is fully paid"), indicator: "green" });
    return;
  }
  const d = new frappe.ui.Dialog({
    title: __("Record Payment — {0}", [frm.doc.name]),
    fields: [
      { fieldname: "paid_amount",     label: __("Amount"),          fieldtype: "Currency",
        default: outstanding, reqd: 1 },
      { fieldname: "payment_date",    label: __("Date"),            fieldtype: "Date",
        default: frappe.datetime.get_today(), reqd: 1 },
      { fieldname: "mode_of_payment", label: __("Mode"),            fieldtype: "Link",
        options: "Books Payment Mode", default: "Bank Transfer" },
      { fieldname: "reference_no",    label: __("Reference / UTR"), fieldtype: "Data" },
      { fieldname: "paid_to",         label: __("Deposit To (Bank/Cash Account)"),
        fieldtype: "Link", options: "Account", reqd: 1,
        get_query: () => ({
          filters: { account_type: ["in", ["Bank", "Cash"]], company: frm.doc.company, is_group: 0 }
        })
      },
    ],
    primary_action_label: __("Create & Submit Payment"),
    primary_action(vals) {
      frappe.call({
        method: "zoho_books_clone.payments.utils.make_payment_entry_from_invoice",
        args: {
          source_name:     frm.doc.name,
          paid_amount:     vals.paid_amount,
          payment_date:    vals.payment_date,
          mode_of_payment: vals.mode_of_payment,
          reference_no:    vals.reference_no,
          paid_to:         vals.paid_to,
        },
        freeze: true,
        freeze_message: __("Creating payment..."),
        callback({ message: pe_name }) {
          d.hide();
          frappe.show_alert({ message: __("Payment {0} created", [pe_name]), indicator: "green" });
          frm.reload_doc();
        }
      });
    }
  });
  d.show();
}

function _round(n, places = 2) {
  return Math.round(n * Math.pow(10, places)) / Math.pow(10, places);
}

/* ── Zoho-style Send Email Dialog ─────────────────────────────────────────── */
function _send_email_dialog(frm) {
  frappe.call({
    method: "zoho_books_clone.api.docs.get_invoice_email_defaults",
    args: { invoice_name: frm.doc.name },
    freeze: true,
    freeze_message: __("Loading email..."),
    callback({ message: defaults }) {
      if (!defaults) {
        frappe.show_alert({ message: __("Could not load email defaults"), indicator: "red" });
        return;
      }
      _show_email_composer(frm, defaults);
    },
    error() {
      _show_email_composer(frm, {
        to: "",
        cc: frappe.session.user,
        subject: "Invoice - " + frm.doc.name + " from " + (frm.doc.company || ""),
        body: _default_email_body(frm),
        customer_name: frm.doc.customer_name || frm.doc.customer,
      });
    }
  });
}

function _default_email_body(frm) {
  var grand = flt(frm.doc.grand_total).toLocaleString("en-IN", { minimumFractionDigits: 2 });
  return (
    "<p>Dear " + (frm.doc.customer_name || frm.doc.customer) + ",</p>" +
    "<p>Thank you for your business. Your invoice can be viewed, printed and downloaded as PDF from the link below. You can also choose to pay it online.</p>" +
    "<table style='border-collapse:collapse;font-size:14px;margin:12px 0'>" +
    "<tr><td style='padding:4px 16px 4px 0;color:#666'>Invoice #</td><td><b>" + frm.doc.name + "</b></td></tr>" +
    "<tr><td style='padding:4px 16px 4px 0;color:#666'>Amount Due</td><td><b>&#8377;" + grand + "</b></td></tr>" +
    "<tr><td style='padding:4px 16px 4px 0;color:#666'>Due Date</td><td>" + (frm.doc.due_date || "") + "</td></tr>" +
    "</table>" +
    "<p>Kindly make the payment by the due date.</p>" +
    "<p>Thanks &amp; Regards,<br>" + (frm.doc.company || "") + "</p>"
  );
}

function _show_email_composer(frm, defaults) {
  var d = new frappe.ui.Dialog({
    title: __("Email To {0}", [defaults.customer_name || frm.doc.customer_name]),
    size: "large",
    fields: [
      {
        fieldname: "from_email",
        label: __("From"),
        fieldtype: "Data",
        default: defaults.from_email || frappe.session.user,
        read_only: 1,
      },
      {
        fieldname: "to",
        label: __("Send To"),
        fieldtype: "Data",
        reqd: 1,
        default: defaults.to || "",
        description: __("Separate multiple addresses with a comma"),
      },
      {
        fieldname: "cc",
        label: __("Cc"),
        fieldtype: "Data",
        default: defaults.cc || defaults.from_email || frappe.session.user,
        description: __("Separate multiple addresses with a comma"),
      },
      {
        fieldname: "subject",
        label: __("Subject"),
        fieldtype: "Data",
        reqd: 1,
        default: defaults.subject || "",
      },
      {
        fieldname: "body",
        label: __("Message"),
        fieldtype: "Text Editor",
        reqd: 1,
        default: defaults.body || _default_email_body(frm),
      },
    ],
    primary_action_label: __("Send"),
    primary_action: function(vals) {
      if (!vals.to) {
        frappe.msgprint(__("Please enter a recipient email address"));
        return;
      }
      frappe.call({
        method: "zoho_books_clone.api.docs.send_invoice_email",
        args: {
          invoice_name: frm.doc.name,
          to: vals.to,
          subject: vals.subject,
          body: vals.body,
          cc: vals.cc || "",
        },
        freeze: true,
        freeze_message: __("Sending email..."),
        callback: function(r) {
          var message = r.message;
          if (message && message.status === "sent") {
            d.hide();
            frappe.show_alert({
              message: __("Email sent to {0}", [message.to]),
              indicator: "green",
            });
            frm.reload_doc();
          }
        },
        error: function() {
          frappe.show_alert({
            message: __("Failed to send email. Please check your Email Account settings."),
            indicator: "red"
          });
        }
      });
    },
    secondary_action_label: __("Cancel"),
    secondary_action: function() { d.hide(); }
  });

  d.show();

  // Inject the blue invoice banner (Zoho style)
  setTimeout(function() {
    var banner = $('<div style="background:#3B82F6;color:#fff;text-align:center;' +
      'font-size:16px;font-weight:600;padding:14px 20px;' +
      'border-radius:6px;margin-bottom:16px;">' +
      'Invoice #' + frm.doc.name + '</div>');
    d.$wrapper.find(".frappe-dialog-body .form-layout").prepend(banner);
  }, 100);
}
