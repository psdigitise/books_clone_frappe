// Zoho Books Clone – global JS helpers
window.BooksApp = {
  formatCurrency(amount, currency = "INR") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency, minimumFractionDigits: 2,
    }).format(amount || 0);
  },

  showKPIDashboard(wrapper, kpis) {
    const html = kpis.map(k => `
      <div class="books-kpi-card col-sm-3">
        <div class="kpi-value">${this.formatCurrency(k.value)}</div>
        <div class="kpi-label">${k.label}</div>
      </div>`).join("");
    $(wrapper).html(`<div class="row">${html}</div>`);
  },
};

// Add Books branding to form header
frappe.ui.form.on("Sales Invoice",   { refresh: _addBooksHeader });
frappe.ui.form.on("Purchase Invoice",{ refresh: _addBooksHeader });
frappe.ui.form.on("Payment Entry",   { refresh: _addBooksHeader });

function _addBooksHeader(frm) {
  if (frm.form_wrapper.find(".books-header-bar").length) return;
  frm.form_wrapper.prepend(
    `<div class="books-header-bar">${__(frm.doctype)} – ${frm.doc.name || "New"}</div>`
  );
}
