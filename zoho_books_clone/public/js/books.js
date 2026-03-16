
/* ═══════════════════════════════════════════════════════════════
   ZOHO BOOKS CLONE — Main JS
   Mounts sidebar, topbar, and wires Frappe desk to Books UI
   ═══════════════════════════════════════════════════════════════ */

window.BooksApp = (() => {
  // ── Currency Formatter ──────────────────────────────────────
  function fmt(amount, currency = "INR") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency,
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(amount || 0);
  }

  // ── Status Badge ────────────────────────────────────────────
  function badge(status) {
    const map = {
      "Draft":       "books-badge-draft",
      "Submitted":   "books-badge-submitted",
      "Paid":        "books-badge-paid",
      "Partly Paid": "books-badge-partial",
      "Overdue":     "books-badge-overdue",
      "Cancelled":   "books-badge-cancelled",
    };
    const cls = map[status] || "books-badge-draft";
    return `<span class="books-badge ${cls}">${status}</span>`;
  }

  // ── Sidebar Definition ──────────────────────────────────────
  const NAV = [
    { label: "Main Menu", type: "section" },
    { label: "Dashboard",       icon: "grid",          route: "Books Dashboard",      key: "dashboard" },
    { label: "Invoicing", type: "section" },
    { label: "Sales Invoices",  icon: "file-text",     route: "List/Sales Invoice",   key: "si" },
    { label: "Purchase Bills",  icon: "shopping-bag",  route: "List/Purchase Invoice",key: "pi" },
    { label: "Payments",        icon: "credit-card",   route: "List/Payment Entry",   key: "pe" },
    { label: "Accounting", type: "section" },
    { label: "Chart of Accounts",icon:"layers",        route: "List/Account",         key: "coa" },
    { label: "General Ledger",  icon: "book-open",     route: "query-report/General Ledger", key: "gl" },
    { label: "Journal Entries", icon: "edit-3",        route: "List/General Ledger Entry",   key: "je" },
    { label: "Banking", type: "section" },
    { label: "Bank Accounts",   icon: "database",      route: "List/Bank Account",    key: "ba" },
    { label: "Reconciliation",  icon: "check-square",  route: "List/Bank Transaction",key: "rec" },
    { label: "Reports", type: "section" },
    { label: "P & L Statement", icon: "trending-up",   route: "query-report/Profit and Loss Statement", key: "pl" },
    { label: "Balance Sheet",   icon: "pie-chart",     route: "query-report/Balance Sheet",             key: "bs" },
    { label: "Cash Flow",       icon: "activity",      route: "query-report/Cash Flow Statement",       key: "cf" },
    { label: "GST Summary",     icon: "tag",           route: "query-report/GST Summary",               key: "gst" },
    { label: "AR Aging",        icon: "clock",         route: "query-report/Accounts Receivable Aging", key: "ara" },
    { label: "Settings", type: "section" },
    { label: "Books Settings",  icon: "settings",      route: "Form/Books Settings",  key: "cfg" },
    { label: "Tax Templates",   icon: "percent",       route: "List/Tax Template",    key: "tax" },
  ];

  // ── SVG Icons (Feather subset, inline) ──────────────────────
  const ICONS = {
    "grid":         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    "file-text":    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    "shopping-bag": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
    "credit-card":  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
    "layers":       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
    "book-open":    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
    "edit-3":       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
    "database":     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
    "check-square": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    "trending-up":  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
    "pie-chart":    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>`,
    "activity":     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    "tag":          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
    "clock":        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    "settings":     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    "percent":      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>`,
    "search":       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    "bell":         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    "plus":         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    "x":            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    "send":         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    "download":     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  };

  function icon(name, cls = "") {
    const svg = ICONS[name] || ICONS["grid"];
    return `<span class="books-nav-icon ${cls}">${svg}</span>`;
  }

  // ── Build sidebar HTML ───────────────────────────────────────
  function buildSidebar() {
    const user = frappe.session.user || "A";
    const initials = user.charAt(0).toUpperCase();
    let html = `
    <div class="books-sidebar" id="books-sidebar">
      <a class="books-sidebar-logo">
        <div class="books-sidebar-logo-icon">📚</div>
        <div>
          <div class="books-sidebar-logo-text">Books</div>
          <div class="books-sidebar-logo-sub">Accounting Suite</div>
        </div>
      </a>`;

    NAV.forEach((item, i) => {
      if (item.type === "section") {
        html += `<div class="books-sidebar-section">
          <div class="books-sidebar-section-label">${item.label}</div>`;
      } else {
        const delay = `style="animation-delay:${i * 0.025}s"`;
        html += `<a class="books-nav-item books-anim-nav" data-key="${item.key}"
                    data-route="${item.route}" ${delay}
                    onclick="BooksApp.navigate('${item.route}','${item.key}')">
                  ${icon(item.icon)}
                  <span>${item.label}</span>
                </a>`;
        // Close section div before next section
        if (i < NAV.length - 1 && NAV[i + 1].type === "section") html += `</div>`;
        if (i === NAV.length - 1) html += `</div>`;
      }
    });

    html += `
      <div class="books-sidebar-bottom">
        <div class="books-nav-item" style="gap:10px">
          <div style="width:28px;height:28px;border-radius:50%;background:#3B5BDB;
                      color:#fff;display:flex;align-items:center;justify-content:center;
                      font-size:12px;font-weight:600;flex-shrink:0">${initials}</div>
          <div style="overflow:hidden">
            <div style="font-size:12px;color:#fff;font-weight:500;
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${frappe.session.user_fullname || user}</div>
            <div style="font-size:10.5px;color:var(--zb-sidebar-text)">Administrator</div>
          </div>
        </div>
      </div>
    </div>`;
    return html;
  }

  // ── Build topbar HTML ────────────────────────────────────────
  function buildTopbar() {
    return `
    <div class="books-topbar" id="books-topbar">
      <div id="books-breadcrumb" class="books-topbar-breadcrumb">
        <span>Dashboard</span>
      </div>
      <div class="books-topbar-spacer"></div>
      <div class="books-search-bar">
        ${ICONS["search"].replace('class=""','')}
        <input id="books-search-input" type="text"
               placeholder="Search invoices, customers…"
               oninput="BooksApp.globalSearch(this.value)">
      </div>
      <button class="books-topbar-icon-btn" title="Notifications">
        ${ICONS["bell"]}
      </button>
      <div class="books-topbar-avatar" title="${frappe.session.user}">
        ${(frappe.session.user || "A").charAt(0).toUpperCase()}
      </div>
    </div>`;
  }

  // ── Navigate ─────────────────────────────────────────────────
  function navigate(route, key) {
    // Update active state
    document.querySelectorAll(".books-nav-item").forEach(el => el.classList.remove("active"));
    const active = document.querySelector(`[data-key="${key}"]`);
    if (active) active.classList.add("active");

    // Update breadcrumb
    const item = NAV.find(n => n.key === key);
    const bc   = document.getElementById("books-breadcrumb");
    if (bc && item) bc.innerHTML = `<span>${item.label}</span>`;

    // Route in Frappe
    if (route.startsWith("query-report/")) {
      frappe.set_route("query-report", route.replace("query-report/", ""));
    } else if (route.startsWith("List/")) {
      const parts = route.split("/");
      frappe.set_route("List", parts[1]);
    } else if (route.startsWith("Form/")) {
      const parts = route.split("/");
      frappe.set_route("Form", parts[1], parts[2] || "");
    } else {
      frappe.set_route(route);
    }
  }

  // ── Mount sidebar + topbar ───────────────────────────────────
  function mount() {
    if (document.getElementById("books-sidebar")) return;

    // Inject
    const wrap = document.createElement("div");
    wrap.innerHTML = buildSidebar() + buildTopbar();
    document.body.prepend(wrap);

    // Push Frappe desk content right
    const desk = document.querySelector(".page-container") || document.querySelector("#body_div");
    if (desk) {
      desk.style.marginLeft = "220px";
      desk.style.paddingTop = "52px";
    }

    // Hide Frappe's own sidebar
    const fSidebar = document.querySelector(".desk-sidebar,.layout-side-section");
    if (fSidebar) fSidebar.style.display = "none";

    // Mark active from current route
    const route = frappe.get_route_str();
    markActive(route);
  }

  function markActive(routeStr) {
    NAV.forEach(item => {
      if (!item.route) return;
      const match = routeStr && routeStr.toLowerCase().includes(
        item.route.toLowerCase().replace("list/", "").replace("form/", "").replace("query-report/", "")
      );
      const el = document.querySelector(`[data-key="${item.key}"]`);
      if (el) el.classList.toggle("active", match);
    });
  }

  // ── Global search ────────────────────────────────────────────
  let _searchTimer;
  function globalSearch(q) {
    clearTimeout(_searchTimer);
    if (!q || q.length < 2) return;
    _searchTimer = setTimeout(() => {
      frappe.call({
        method: "zoho_books_clone.api.dashboard.search_transactions",
        args: { query: q },
        callback({ message }) {
          if (!message?.length) return;
          // Show quick results in a toast-style dropdown
          frappe.show_alert({
            message: `Found ${message.length} result(s) for "${q}"`,
            indicator: "blue"
          }, 3);
        }
      });
    }, 350);
  }

  // ── Form helpers ─────────────────────────────────────────────
  function applyFormStyling(frm) {
    // Add Books class to body
    document.body.classList.add("books-app");

    // Style the form layout
    const layout = frm.layout?.wrapper?.[0];
    if (layout) layout.classList.add("books-form-page");

    // Mark active nav
    markActive(frappe.get_route_str());
  }

  // ── List view helpers ─────────────────────────────────────────
  function styleListView(listview) {
    document.body.classList.add("books-app");
    markActive(frappe.get_route_str());
  }

  // ── Auto-mount on page load ───────────────────────────────────
  $(document).on("page-change", () => {
    mount();
    markActive(frappe.get_route_str());
  });

  frappe.ready(() => {
    document.body.classList.add("books-app");
    setTimeout(mount, 300);
  });

  return { fmt, badge, navigate, mount, applyFormStyling, styleListView, globalSearch, icon };
})();


/* ═══════════════════════════════════════════════════════════════
   FORM HOOKS — wire Books UI to each DocType
   ═══════════════════════════════════════════════════════════════ */

// Sales Invoice
frappe.ui.form.on("Sales Invoice", {
  refresh(frm) {
    BooksApp.applyFormStyling(frm);
    _addStatusBar(frm);

    if (frm.doc.docstatus === 1) {
      frm.add_custom_button(
        `${BooksApp.icon("send")} Send Invoice`,
        () => frappe.call({ method: "send_invoice_email", doc: frm.doc }),
        "Actions"
      );
      frm.add_custom_button(
        `${BooksApp.icon("download")} Download PDF`,
        () => frappe.utils.print(frm.doctype, frm.doc.name, null, null, frm.doc.language),
        "Actions"
      );
      frm.add_custom_button(
        `${BooksApp.icon("plus")} Record Payment`,
        () => frappe.model.open_mapped_doc({
          method: "zoho_books_clone.payments.utils.make_payment_entry_from_invoice",
          frm,
        }),
        "Actions"
      );
    }
  },
  customer(frm) {
    if (frm.doc.customer) {
      frappe.db.get_value("Customer", frm.doc.customer,
        ["customer_name", "default_currency", "payment_terms"], r => {
          if (r.default_currency) frm.set_value("currency", r.default_currency);
          if (r.payment_terms)    frm.set_value("payment_terms", r.payment_terms);
        });
    }
  },
  calculate_totals(frm) {
    let net = (frm.doc.items || []).reduce((s, i) => s + (i.qty || 0) * (i.rate || 0), 0);
    let tax = (frm.doc.taxes || []).reduce((s, t) => s + (t.tax_amount || 0), 0);
    frm.set_value("net_total",   net);
    frm.set_value("total_tax",   tax);
    frm.set_value("grand_total", net + tax);
  }
});

frappe.ui.form.on("Sales Invoice Item", {
  qty(frm)  { frm.trigger("calculate_totals"); },
  rate(frm) { frm.trigger("calculate_totals"); },
  items_remove(frm) { frm.trigger("calculate_totals"); },
});

// Purchase Invoice
frappe.ui.form.on("Purchase Invoice", {
  refresh(frm) { BooksApp.applyFormStyling(frm); _addStatusBar(frm); },
  supplier(frm) {
    if (frm.doc.supplier) {
      frappe.db.get_value("Supplier", frm.doc.supplier, "default_currency", r => {
        if (r.default_currency) frm.set_value("currency", r.default_currency);
      });
    }
  },
});

// Payment Entry
frappe.ui.form.on("Payment Entry", {
  refresh(frm) { BooksApp.applyFormStyling(frm); },
  payment_type(frm) {
    if (frm.doc.payment_type === "Receive") {
      frm.set_df_property("party_type", "options", "\nCustomer");
    } else if (frm.doc.payment_type === "Pay") {
      frm.set_df_property("party_type", "options", "\nSupplier\nEmployee");
    }
  },
});

// Account
frappe.ui.form.on("Account", {
  refresh(frm) { BooksApp.applyFormStyling(frm); }
});

// Bank Transaction
frappe.ui.form.on("Bank Transaction", {
  refresh(frm) { BooksApp.applyFormStyling(frm); }
});

// ── Status progress bar (invoice workflow) ──────────────────────
function _addStatusBar(frm) {
  const statuses = ["Draft", "Submitted", "Partly Paid", "Paid"];
  const current  = frm.doc.status;
  if (frm.doc.status === "Cancelled") return;

  const steps = statuses.map(s => {
    const idx     = statuses.indexOf(s);
    const curIdx  = statuses.indexOf(current);
    const done    = idx < curIdx;
    const active  = s === current;
    return `
      <div style="display:flex;align-items:center;gap:6px;flex:1">
        <div style="width:22px;height:22px;border-radius:50%;display:flex;
                    align-items:center;justify-content:center;font-size:11px;
                    font-weight:600;flex-shrink:0;
                    background:${done||active?"#3B5BDB":"#E8ECF0"};
                    color:${done||active?"#fff":"#868E96"}">
          ${done ? "✓" : (statuses.indexOf(s) + 1)}
        </div>
        <span style="font-size:12px;font-weight:${active?"600":"400"};
                     color:${active?"#3B5BDB":done?"#1A1D23":"#868E96"}">
          ${s}
        </span>
        ${idx < statuses.length-1 ? '<div style="flex:1;height:1px;background:#E8ECF0;margin:0 6px"></div>' : ''}
      </div>`;
  }).join("");

  const bar = $(`
    <div style="background:#fff;border:1px solid #E8ECF0;border-radius:8px;
                padding:12px 20px;margin-bottom:12px;display:flex;
                align-items:center;gap:4px">
      ${steps}
    </div>`);
  $(frm.wrapper).find(".form-page,.form-layout").prepend(bar);
}
