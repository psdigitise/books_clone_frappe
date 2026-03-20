(function () {
  "use strict";
  if (!document.getElementById("books-app")) return;
  if (typeof Vue === "undefined" || typeof VueRouter === "undefined") {
    console.error("[Books] Vue/VueRouter not loaded"); return;
  }

  const { createApp, ref, computed, onMounted, reactive, watch, defineComponent, nextTick } = Vue;
  const { createRouter, createWebHashHistory, useRoute, useRouter } = VueRouter;

  /* Expose URL helpers globally immediately so templates can use them */
  window.docUrl = function (dt, name) { return "/app/" + dt.toLowerCase().replace(/ /g, "-") + "/" + encodeURIComponent(name); };
  window.newDocUrl = function (dt) { return "/app/" + dt.toLowerCase().replace(/ /g, "-") + "/new"; };
  window.flt = function (v) { return parseFloat(v) || 0; };

  /* ─── Config ─────────────────────────────────────────────────── */
  // Frappe v15 new-doc URL pattern
  function newDocUrl(doctype) {
    return "/app/" + doctype.toLowerCase().replace(/ /g, "-") + "/new";
  }
  function docUrl(doctype, name) {
    return "/app/" + doctype.toLowerCase().replace(/ /g, "-") + "/" + encodeURIComponent(name);
  }
  function openDoc(doctype, name) { window.open(docUrl(doctype, name), "_blank"); }
  function openNew(doctype) { window.open(newDocUrl(doctype), "_blank"); }

  /* ─── Helpers ────────────────────────────────────────────────── */
  function fmt(v, c) {
    if (v == null || v === "") return "—";
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: c || "INR", maximumFractionDigits: 2 }).format(v); }
    catch { return "₹" + Number(v).toLocaleString("en-IN"); }
  }
  function fmtDate(v) {
    if (!v) return "—";
    try { return new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
    catch { return v; }
  }
  function fmtShort(v) {
    if (!v) return "—";
    try { return new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }); }
    catch { return v; }
  }
  function isOverdue(inv) { return flt(inv.outstanding_amount) > 0 && inv.due_date && new Date(inv.due_date) < new Date(); }
  function csrf() { return window.frappe?.csrf_token || ""; }
  function co() { return window.__booksCompany || window.frappe?.boot?.sysdefaults?.company || ""; }
  function flt(v) { return parseFloat(v) || 0; }
  function today() { return new Date().toISOString().slice(0, 10); }

  /* ─── API ────────────────────────────────────────────────────── */
  /* ─── API helpers ─────────────────────────────────────────────
     GET  → read operations  (no CSRF needed in Frappe)
     POST → write operations (CSRF required)
  ──────────────────────────────────────────────────────────── */

  function _parseResponse(json, status) {
    if (json.exc || json.exc_type) {
      const match = (json.exc || "").match(/frappe\.exceptions\.\w+: (.+)/);
      throw new Error(match ? match[1] : (json.exc_type || json.message || "Server error " + status));
    }
    return json.message;
  }

  /* GET — safe for all read-only Frappe methods, no CSRF required */
  async function apiGET(method, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      qs.append(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    const r = await fetch("/api/method/" + method + "?" + qs.toString(), {
      method: "GET", credentials: "same-origin",
      headers: { "Accept": "application/json" }
    });
    let json;
    try { json = await r.json(); } catch { throw new Error("Non-JSON response (" + r.status + ")"); }
    return _parseResponse(json, r.status);
  }

  /* Refresh CSRF token from session endpoint (GET — no CSRF needed) */
  async function refreshCsrfToken() {
    // 1. Already have a valid token
    if (window.frappe?.csrf_token && window.frappe.csrf_token !== "None" && window.frappe.csrf_token !== "{{ csrf_token }}") return;
    // 2. Meta tag (Frappe injects this on every page load)
    const meta = document.querySelector("meta[name='csrf-token']");
    if (meta) { const t = meta.getAttribute("content"); if (t && t !== "None") { window.frappe.csrf_token = t; return; } }
    // 3. Cookie
    const ck = document.cookie.split(";").map(c=>c.trim()).find(c=>c.startsWith("csrf_token="));
    if (ck) { const t = decodeURIComponent(ck.split("=").slice(1).join("=")); if (t && t !== "None") { window.frappe.csrf_token = t; return; } }
    // 4. Session endpoint
    try {
      const r = await fetch("/api/method/zoho_books_clone.api.session.get_books_session", {
        method: "GET", credentials: "same-origin", headers: { "Accept": "application/json" }
      });
      const data = await r.json();
      const token = data?.message?.csrf_token;
      if (token && token !== "None") window.frappe.csrf_token = token;
    } catch { }
  }

  /* POST — for write operations; always re-fetches CSRF token first */
  async function apiPOST(method, args) {
    // Always refresh the token before posting — prevents stale token errors
    await refreshCsrfToken();
    const csrfToken = window.frappe?.csrf_token || getCsrfFromCookie() || "";
    const body = new URLSearchParams();
    if (csrfToken) body.append("csrf_token", csrfToken);
    for (const [k, v] of Object.entries(args || {})) {
      body.append(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    const r = await fetch("/api/method/" + method, {
      method: "POST", credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Frappe-CSRF-Token": csrfToken || "",
        "Accept": "application/json"
      },
      body: body.toString()
    });
    let json;
    try { json = await r.json(); } catch { throw new Error("Non-JSON response (" + r.status + ")"); }
    return _parseResponse(json, r.status);
  }

  /* Legacy alias — kept so any direct api() calls still work (uses GET) */
  async function api(method, args) { return await apiGET(method, args); }

  /* ── Public helpers ── */
  async function apiGet(doctype, name) {
    return await apiGET("frappe.client.get", { doctype, name });
  }

  async function apiSave(doc) {
    // Use our custom GET endpoint — no CSRF token needed
    return await apiGET("zoho_books_clone.api.docs.save_doc", { doc: JSON.stringify(doc) });
  }

  async function apiSubmit(doctype, name) {
    // Use our custom GET endpoint — no CSRF token needed
    return await apiGET("zoho_books_clone.api.docs.submit_doc", { doctype, name });
  }

  async function apiList(dt, opts) {
    return await apiGET("frappe.client.get_list", {
      doctype: dt,
      fields: JSON.stringify(opts.fields || ["name"]),
      filters: JSON.stringify(opts.filters || []),
      order_by: opts.order || "modified desc",
      limit_page_length: opts.limit || 50
    }) || [];
  }

  async function apiLinkValues(doctype, txt, filters) {
    const f = filters ? [...filters, ["name", "like", "%" + txt + "%"]] : [["name", "like", "%" + txt + "%"]];
    return await apiGET("frappe.client.get_list", {
      doctype, fields: JSON.stringify(["name"]),
      filters: JSON.stringify(f),
      limit_page_length: 10
    }) || [];
  }

  async function resolveCompany() {
    if (window.__booksCompany) return window.__booksCompany;
    try {
      const r = await apiGET("frappe.client.get_value", {
        doctype: "Books Settings",
        filters: JSON.stringify({ name: "Books Settings" }),
        fieldname: JSON.stringify(["default_company"])
      });
      const c = r?.default_company || "";
      window.__booksCompany = c;
      if (window.frappe?.boot?.sysdefaults) window.frappe.boot.sysdefaults.company = c;
      return c;
    } catch { return window.__booksCompany || ""; }
  }

  /* ─── Toast ──────────────────────────────────────────────────── */
  function toast(msg, type = "success") {
    const el = document.createElement("div");
    const bg = type === "error" ? "#C92A2A" : type === "warning" ? "#E67700" : "#2F9E44";
    el.style.cssText = `position:fixed;top:20px;right:20px;z-index:99999;
    background:${bg};color:#fff;padding:12px 20px;border-radius:8px;
    font-size:13px;font-weight:500;font-family:'DM Sans',sans-serif;
    box-shadow:0 4px 20px rgba(0,0,0,.2);max-width:360px;line-height:1.4;
    animation:toastIn .2s ease`;
    el.textContent = msg;
    const style = document.createElement("style");
    style.textContent = "@keyframes toastIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}";
    document.head.appendChild(style);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  /* ─── SVG Icons ──────────────────────────────────────────────── */
  const IC = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    pay: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
    bank: '<path d="M3 22h18M6 18v-7m4 7v-7m4 7v-7m4 7v-7M3 7l9-5 9 5H3z"/>',
    accts: '<path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM12 14v-4M8 14v-2M16 14v-3"/>',
    chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    purchase: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    print: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    ext: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  };
  function icon(k, s) { s = s || 16; return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[k] || ""}</svg>`; }

  function statusBadge(s) {
    return {
      Paid: "b-badge-green", "Partly Paid": "b-badge-amber", Submitted: "b-badge-amber",
      Draft: "b-badge-muted", Cancelled: "b-badge-red", Overdue: "b-badge-red",
      Receive: "b-badge-green", Pay: "b-badge-red", Unreconciled: "b-badge-amber",
      Reconciled: "b-badge-green"
    }[s] || "b-badge-muted";
  }

  /* ═══════════════════════════════════════════════════════════════
     INLINE NEW INVOICE MODAL
     Opens a fully functional form inside the Books UI.
     Saves to Frappe via API then redirects to the saved doc.
  ═══════════════════════════════════════════════════════════════ */
  const InvoiceModal = defineComponent({
    name: "InvoiceModal",
    props: { show: Boolean, doctype: { type: String, default: "Sales Invoice" } },
    emits: ["close", "saved"],
    setup(props, { emit }) {
      const saving = ref(false);
      const company = ref(co());
      const customers = ref([]);
      const accounts_ar = ref([]);
      const accounts_income = ref([]);
      const taxTemplates = ref([]);

      const form = reactive({
        naming_series: "INV-.YYYY.-.#####",
        customer: "", customer_name: "",
        posting_date: today(), due_date: today(),
        company: co(), currency: "INR",
        debit_to: "", income_account: "",
        items: [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
        taxes: [],
        notes: "",
        net_total: 0, total_tax: 0, grand_total: 0,
      });

      const isSI = computed(() => props.doctype === "Sales Invoice");

      // Recalculate totals whenever items or taxes change
      function recalc() {
        form.items.forEach(i => { i.amount = Math.round(flt(i.qty) * flt(i.rate) * 100) / 100; });
        const net = form.items.reduce((s, i) => s + flt(i.amount), 0);
        form.taxes.forEach(t => { t.tax_amount = flt(t.rate) > 0 ? Math.round(net * flt(t.rate) / 100 * 100) / 100 : 0; });
        const tax = form.taxes.reduce((s, t) => s + flt(t.tax_amount), 0);
        form.net_total = Math.round(net * 100) / 100;
        form.total_tax = Math.round(tax * 100) / 100;
        form.grand_total = Math.round((net + tax) * 100) / 100;
      }

      function addItem() { form.items.push({ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }); }
      function removeItem(i) { if (form.items.length > 1) { form.items.splice(i, 1); recalc(); } }
      function addTax() { form.taxes.push({ tax_type: "CGST", description: "CGST", rate: 9, tax_amount: 0, account_head: "" }); }
      function removeTax(i) { form.taxes.splice(i, 1); recalc(); }

      // When customer is selected, fetch their name
      async function onCustomer() {
        if (!form.customer) return;
        try {
          const r = await apiGET("frappe.client.get_value", {
            doctype: "Customer", filters: { name: form.customer },
            fieldname: ["default_currency"]
          });
          form.customer_name = form.customer; // name IS the display name for custom Customer
          if (r?.default_currency) form.currency = r.default_currency;
        } catch { }
      }

      async function loadDefaults() {
        const c = await resolveCompany();
        form.company = c;
        // Query AR accounts exactly like Frappe desk does: account_type=Receivable, is_group=0
        try {
          const ar = await apiList("Account", { fields: ["name"], filters: [["account_type", "=", "Receivable"], ["is_group", "=", 0]], limit: 50 });
          accounts_ar.value = ar;
          if (ar.length && !form.debit_to) form.debit_to = ar[0].name;
        } catch (e) { console.warn("AR accounts failed:", e.message); }
        // Income accounts
        try {
          const inc = await apiList("Account", { fields: ["name"], filters: [["account_type", "in", ["Income Account", "Income"]], ["is_group", "=", 0]], limit: 50 });
          accounts_income.value = inc;
          if (inc.length && !form.income_account) form.income_account = inc[0].name;
        } catch (e) { console.warn("Income accounts failed:", e.message); }
        // Load customers
        try {
          customers.value = await apiList("Customer", { fields: ["name"], limit: 50, order: "name asc" });
        } catch { }
      }

      onMounted(loadDefaults);
      watch(() => props.show, v => { if (v) loadDefaults(); });

      async function applyTaxTemplate(tplName) { }  // Tax templates not available

      async function save(andSubmit) {
        if (!form.customer) { toast("Please select a Customer", "error"); return; }
        if (!form.items[0].item_name && !form.items[0].rate) { toast("Please add at least one item", "error"); return; }
        if (!form.debit_to) { toast("Please set the Accounts Receivable (Debit To) account", "error"); return; }
        if (!form.income_account) { toast("Please set the Income Account", "error"); return; }

        recalc();
        saving.value = true;

        const doc = {
          doctype: props.doctype,
          naming_series: form.naming_series,
          customer: form.customer,
          posting_date: form.posting_date,
          due_date: form.due_date || form.posting_date,
          company: form.company,
          currency: form.currency || "INR",
          debit_to: form.debit_to,
          income_account: form.income_account,
          notes: form.notes,
          items: form.items.filter(i => i.item_name || flt(i.rate)).map((i, idx) => ({
            doctype: "Sales Invoice Item",
            item_name: i.item_name || "Item " + (idx + 1),
            description: i.description || i.item_name,
            qty: flt(i.qty) || 1,
            rate: flt(i.rate),
            amount: flt(i.amount),
          })),
          taxes: form.taxes.map(t => ({
            doctype: "Tax Line",
            tax_type: t.tax_type,
            description: t.description || t.tax_type,
            rate: flt(t.rate),
            tax_amount: flt(t.tax_amount),
            account_head: t.account_head || "",
          })),
        };

        try {
          const saved = await apiSave(doc);
          if (andSubmit) {
            await apiSubmit(props.doctype, saved.name);
            toast("Invoice " + saved.name + " submitted!");
          } else {
            toast("Invoice " + saved.name + " saved as Draft");
          }
          emit("saved", saved.name);
          emit("close");
          // Navigate to the saved doc in Frappe desk
          setTimeout(() => window.open(docUrl(props.doctype, saved.name), "_blank"), 300);
        } catch (e) {
          toast(e.message || "Could not save invoice", "error");
        } finally { saving.value = false; }
      }

      function onPostingDateChange() {
        if (!form.due_date || form.due_date < form.posting_date)
          form.due_date = form.posting_date;
      }
      return {
        form, saving, customers, accounts_ar, accounts_income, taxTemplates, isSI,
        recalc, addItem, removeItem, addTax, removeTax, onCustomer, applyTaxTemplate, save, fmt, flt, icon, toast, onPostingDateChange
      };
    },
    template: `
<teleport to="body">
<div v-if="show" style="position:fixed;inset:0;z-index:9000;display:flex;align-items:flex-start;justify-content:center;
     background:rgba(0,0,0,.45);padding:32px 16px;overflow-y:auto" @click.self="$emit('close')">
  <div style="background:#fff;border-radius:12px;width:100%;max-width:860px;
       box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;margin:auto">

    <!-- Header -->
    <div style="background:#3B5BDB;padding:18px 24px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="color:#fff;font-size:16px;font-weight:700;letter-spacing:-.2px">
          New {{isSI?'Sales Invoice':'Purchase Bill'}}
        </div>
        <div style="color:rgba(255,255,255,.65);font-size:12px;margin-top:2px">{{form.company}}</div>
      </div>
      <button @click="$emit('close')" style="background:rgba(255,255,255,.15);border:none;cursor:pointer;
        width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff"
        v-html="icon('x',16)"></button>
    </div>

    <div style="padding:24px;overflow-y:auto;max-height:calc(100vh - 180px)">

      <!-- Row 1: Customer + Dates -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:16px">
        <div style="grid-column:1">
          <label class="mi-label">Customer <span style="color:#C92A2A">*</span></label>
          <select v-model="form.customer" @change="onCustomer" class="mi-input">
            <option value="">— Select Customer —</option>
            <option v-for="c in customers" :key="c.name" :value="c.name">{{c.name}}</option>
          </select>
        </div>
        <div>
          <label class="mi-label">Invoice Date <span style="color:#C92A2A">*</span></label>
          <input v-model="form.posting_date" type="date" class="mi-input"
            @change="onPostingDateChange"/>
        </div>
        <div>
          <label class="mi-label">Due Date</label>
          <input v-model="form.due_date" type="date" class="mi-input"/>
        </div>
      </div>

      <!-- Row 2: Accounts -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
        <div>
          <label class="mi-label">Debit To (AR Account) <span style="color:#C92A2A">*</span></label>
          <select v-model="form.debit_to" class="mi-input">
            <option value="">— Select —</option>
            <option v-for="a in accounts_ar" :key="a.name" :value="a.name">{{a.name}}</option>
          </select>
        </div>
        <div>
          <label class="mi-label">Income Account <span style="color:#C92A2A">*</span></label>
          <select v-model="form.income_account" class="mi-input">
            <option value="">— Select —</option>
            <option v-for="a in accounts_income" :key="a.name" :value="a.name">{{a.name}}</option>
          </select>
        </div>
      </div>

      <!-- Items table -->
      <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;
           color:#868E96;margin-bottom:8px">Items</div>
      <div style="border:1px solid #E8ECF0;border-radius:8px;overflow:hidden;margin-bottom:16px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#F8F9FC">
              <th class="mi-th" style="width:30%">Item Name</th>
              <th class="mi-th" style="width:28%">Description</th>
              <th class="mi-th" style="width:10%;text-align:center">Qty</th>
              <th class="mi-th" style="width:15%;text-align:right">Rate (₹)</th>
              <th class="mi-th" style="width:13%;text-align:right">Amount (₹)</th>
              <th class="mi-th" style="width:4%"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item,i) in form.items" :key="i"
                :style="i%2===1?'background:#FAFBFC':''">
              <td class="mi-td">
                <input v-model="item.item_name" class="mi-cell-input" placeholder="Item name"/>
              </td>
              <td class="mi-td">
                <input v-model="item.description" class="mi-cell-input" placeholder="Description"/>
              </td>
              <td class="mi-td" style="text-align:center">
                <input v-model.number="item.qty" type="number" min="0.01" step="0.01"
                  class="mi-cell-input" style="text-align:center;width:60px"
                  @input="recalc"/>
              </td>
              <td class="mi-td" style="text-align:right">
                <input v-model.number="item.rate" type="number" min="0" step="0.01"
                  class="mi-cell-input" style="text-align:right"
                  @input="recalc"/>
              </td>
              <td class="mi-td" style="text-align:right;font-family:monospace;font-size:13px;
                  color:#1A1D23;font-weight:600;padding-right:12px">
                {{item.amount?item.amount.toLocaleString("en-IN",{minimumFractionDigits:2}):"0.00"}}
              </td>
              <td class="mi-td" style="text-align:center">
                <button @click="removeItem(i)" v-if="form.items.length>1"
                  style="background:none;border:none;cursor:pointer;color:#C92A2A;padding:2px"
                  v-html="icon('trash',14)"></button>
              </td>
            </tr>
          </tbody>
        </table>
        <div style="padding:8px 12px;background:#F8F9FC;border-top:1px solid #E8ECF0">
          <button @click="addItem" style="background:none;border:none;cursor:pointer;
            color:#3B5BDB;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:5px"
            :style="{fontFamily:'inherit'}">
            <span v-html="icon('plus',13)"></span> Add Row
          </button>
        </div>
      </div>

      <!-- Taxes section -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868E96">
          Taxes & Charges
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <select v-if="taxTemplates.length" @change="e=>{if(e.target.value)applyTaxTemplate(e.target.value)}"
            style="font-size:12px;border:1px solid #E8ECF0;border-radius:5px;padding:4px 8px;
                   font-family:inherit;color:#495057;background:#fff;cursor:pointer">
            <option value="">Apply Template…</option>
            <option v-for="t in taxTemplates" :key="t.name" :value="t.name">{{t.title||t.name}}</option>
          </select>
          <button @click="addTax" style="background:none;border:none;cursor:pointer;
            color:#3B5BDB;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:4px"
            :style="{fontFamily:'inherit'}">
            <span v-html="icon('plus',13)"></span> Add Tax
          </button>
        </div>
      </div>

      <div v-if="form.taxes.length" style="border:1px solid #E8ECF0;border-radius:8px;
           overflow:hidden;margin-bottom:16px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#F8F9FC">
              <th class="mi-th" style="width:22%">Type</th>
              <th class="mi-th" style="width:28%">Description</th>
              <th class="mi-th" style="width:15%;text-align:center">Rate %</th>
              <th class="mi-th" style="width:30%;text-align:right">Tax Amount (₹)</th>
              <th class="mi-th" style="width:5%"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(tax,i) in form.taxes" :key="i" :style="i%2===1?'background:#FAFBFC':''">
              <td class="mi-td">
                <select v-model="tax.tax_type" class="mi-cell-input" @change="tax.description=tax.tax_type">
                  <option>CGST</option><option>SGST</option><option>IGST</option>
                  <option>Cess</option><option>Other</option>
                </select>
              </td>
              <td class="mi-td"><input v-model="tax.description" class="mi-cell-input"/></td>
              <td class="mi-td" style="text-align:center">
                <input v-model.number="tax.rate" type="number" min="0" max="100" step="0.01"
                  class="mi-cell-input" style="text-align:center;width:60px" @input="recalc"/>
              </td>
              <td class="mi-td" style="text-align:right;font-family:monospace;font-size:13px;
                  color:#1A1D23;font-weight:600;padding-right:12px">
                {{flt(tax.tax_amount).toLocaleString("en-IN",{minimumFractionDigits:2})}}
              </td>
              <td class="mi-td" style="text-align:center">
                <button @click="removeTax(i)" style="background:none;border:none;cursor:pointer;
                  color:#C92A2A" v-html="icon('trash',14)"></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Totals -->
      <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
        <div style="min-width:260px;background:#F8F9FC;border:1px solid #E8ECF0;
             border-radius:8px;overflow:hidden">
          <div style="display:flex;justify-content:space-between;padding:10px 16px;
               font-size:13px;color:#495057;border-bottom:1px solid #E8ECF0">
            <span>Subtotal</span>
            <span style="font-family:monospace">{{fmt(form.net_total)}}</span>
          </div>
          <div v-for="tax in form.taxes" :key="tax.tax_type"
               style="display:flex;justify-content:space-between;padding:8px 16px;
               font-size:12.5px;color:#868E96;border-bottom:1px solid #E8ECF0">
            <span>{{tax.description}} ({{tax.rate}}%)</span>
            <span style="font-family:monospace">{{fmt(tax.tax_amount)}}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:12px 16px;
               font-size:15px;font-weight:700;color:#3B5BDB;background:#EEF2FF">
            <span>Grand Total</span>
            <span style="font-family:monospace">{{fmt(form.grand_total)}}</span>
          </div>
        </div>
      </div>

      <!-- Notes -->
      <div style="margin-bottom:16px">
        <label class="mi-label">Notes (optional)</label>
        <textarea v-model="form.notes" class="mi-input" rows="2"
          style="resize:vertical" placeholder="Payment terms, remarks…"></textarea>
      </div>

    </div><!-- /scroll area -->

    <!-- Footer actions -->
    <div style="padding:16px 24px;border-top:1px solid #E8ECF0;
         display:flex;justify-content:flex-end;gap:10px;background:#FAFBFC">
      <button @click="$emit('close')" :disabled="saving"
        style="padding:9px 18px;border:1px solid #CDD5E0;border-radius:6px;background:#fff;
               cursor:pointer;font-size:13px;font-weight:500;color:#495057;font-family:inherit">
        Cancel
      </button>
      <button @click="save(false)" :disabled="saving"
        style="padding:9px 18px;border:1px solid #3B5BDB;border-radius:6px;background:#fff;
               cursor:pointer;font-size:13px;font-weight:500;color:#3B5BDB;font-family:inherit">
        {{saving?'Saving…':'Save as Draft'}}
      </button>
      <button @click="save(true)" :disabled="saving"
        style="padding:9px 18px;border:none;border-radius:6px;background:#3B5BDB;
               cursor:pointer;font-size:13px;font-weight:600;color:#fff;font-family:inherit;
               box-shadow:0 2px 8px rgba(59,91,219,.3)">
        {{saving?'Submitting…':'Save & Submit'}}
      </button>
    </div>
  </div>
</div>
</teleport>
`});

  /* ═══════════════════════════════════════════════════════════════
     SEND EMAIL PAGE — full Zoho Books style
  ═══════════════════════════════════════════════════════════════ */
  const SendEmailModal = defineComponent({
    name: "SendEmailModal",
    props: { show: Boolean, invoiceName: { type: String, default: "" }, inv: { type: Object, default: null } },
    emits: ["close", "sent"],
    setup(props, { emit }) {
      const sending = ref(false), loading = ref(false);
      const error = ref("");
      const fromEmail = ref("");
      // Use different ref names from the template refs to avoid collision
      const toVal = ref(""), toTags = ref([]);
      const ccVal = ref(""), ccTags = ref([]);
      const bccVal = ref(""), bccTags = ref([]);
      const showCc = ref(true), showBcc = ref(false);
      const subject = ref("");
      const editorRef = ref(null);

      function addTagFromVal(val, tags) {
        const v = (val || "").trim().replace(/,$/, "");
        if (v && !tags.value.includes(v)) tags.value.push(v);
      }
      function removeTag(tags, i) { tags.value.splice(i, 1); }

      function onToKey(e) {
        if (e.key === "," || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          addTagFromVal(toVal.value, toTags);
          toVal.value = "";
        }
      }
      function onCcKey(e) {
        if (e.key === "," || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          addTagFromVal(ccVal.value, ccTags);
          ccVal.value = "";
        }
      }
      function onBccKey(e) {
        if (e.key === "," || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          addTagFromVal(bccVal.value, bccTags);
          bccVal.value = "";
        }
      }
      function onToBlur()  { addTagFromVal(toVal.value,  toTags);  toVal.value  = ""; }
      function onCcBlur()  { addTagFromVal(ccVal.value,  ccTags);  ccVal.value  = ""; }
      function onBccBlur() { addTagFromVal(bccVal.value, bccTags); bccVal.value = ""; }

      // Rich text commands
      function execCmd(cmd, val) { document.execCommand(cmd, false, val || null); editorRef.value?.focus(); }

      function buildInvoiceHtml(inv) {
        if (!inv) return "<p style='color:#888;padding:20px'>Loading invoice details…</p>";
        const amt = n => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const items = inv.items || [];
        const taxes = inv.taxes || [];

        const rows = items.length ? items.map((it, i) => `
          <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #f0f2f5;font-size:13px;color:#555;text-align:center">${i + 1}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0f2f5;font-size:13px;color:#1a1d23;font-weight:600">${it.item_name || it.item_code || "Item"}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0f2f5;font-size:13px;text-align:right">${Number(it.qty || 0).toFixed(2)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0f2f5;font-size:13px;text-align:right">${amt(it.rate)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #f0f2f5;font-size:13px;text-align:right;font-weight:700">${amt(it.amount)}</td>
          </tr>`).join("") : `
          <tr><td colspan="5" style="padding:20px;text-align:center;color:#9ca3af;font-size:13px">No items</td></tr>`;

        const taxRows = taxes.map(t => `
          <tr>
            <td colspan="3"></td>
            <td style="padding:5px 14px;font-size:12.5px;color:#555;text-align:right">${t.tax_type || ""} ${t.rate ? "("+t.rate+"%)" : ""}</td>
            <td style="padding:5px 14px;font-size:12.5px;text-align:right">${amt(t.tax_amount)}</td>
          </tr>`).join("");

        const paidAmt = Math.max(0, (inv.grand_total || 0) - (inv.outstanding_amount || 0));

        return `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;background:#fff">

  <!-- Header banner -->
  <div style="background:linear-gradient(135deg,#1d4ed8,#2563EB);padding:28px 36px;border-radius:10px 10px 0 0">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div style="color:rgba(255,255,255,.75);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">TAX INVOICE</div>
        <div style="color:#fff;font-size:24px;font-weight:800;letter-spacing:-.5px">${inv.name || ""}</div>
      </div>
      <div style="text-align:right">
        <div style="color:rgba(255,255,255,.75);font-size:11px;margin-bottom:4px">Amount Due</div>
        <div style="color:#fff;font-size:28px;font-weight:800">${amt(inv.outstanding_amount || inv.grand_total)}</div>
      </div>
    </div>
  </div>

  <!-- Meta row -->
  <div style="background:#f8faff;border:1px solid #dbe4ff;border-top:none;padding:16px 36px;display:flex;gap:40px;border-radius:0 0 0 0">
    <div>
      <div style="font-size:10.5px;font-weight:700;color:#9ca3af;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Bill To</div>
      <div style="font-size:14px;font-weight:700;color:#1a1d23">${inv.customer_name || inv.customer || ""}</div>
    </div>
    <div>
      <div style="font-size:10.5px;font-weight:700;color:#9ca3af;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Invoice Date</div>
      <div style="font-size:13px;color:#374151">${inv.posting_date || "—"}</div>
    </div>
    <div>
      <div style="font-size:10.5px;font-weight:700;color:#9ca3af;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Due Date</div>
      <div style="font-size:13px;color:#dc2626;font-weight:600">${inv.due_date || "—"}</div>
    </div>
  </div>

  <!-- Greeting -->
  <div style="padding:24px 36px 16px;border:1px solid #e8eaed;border-top:none">
    <p style="font-size:14px;color:#374151;margin:0 0 8px;line-height:1.7">Dear <strong>${inv.customer_name || inv.customer || "Customer"}</strong>,</p>
    <p style="font-size:13.5px;color:#6b7280;margin:0 0 20px;line-height:1.7">Thank you for your business. Please find your invoice details below. Kindly make the payment by the due date.</p>

    <!-- Items table -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:0">
      <thead>
        <tr style="background:#f5f6f8">
          <th style="padding:10px 14px;font-size:11px;font-weight:700;color:#6b7280;text-align:center;border-bottom:2px solid #e8eaed;width:40px">#</th>
          <th style="padding:10px 14px;font-size:11px;font-weight:700;color:#6b7280;text-align:left;border-bottom:2px solid #e8eaed">ITEM &amp; DESCRIPTION</th>
          <th style="padding:10px 14px;font-size:11px;font-weight:700;color:#6b7280;text-align:right;border-bottom:2px solid #e8eaed">QTY</th>
          <th style="padding:10px 14px;font-size:11px;font-weight:700;color:#6b7280;text-align:right;border-bottom:2px solid #e8eaed">RATE</th>
          <th style="padding:10px 14px;font-size:11px;font-weight:700;color:#6b7280;text-align:right;border-bottom:2px solid #e8eaed">AMOUNT</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        ${taxRows}
        <tr style="background:#f8faff">
          <td colspan="3"></td>
          <td style="padding:12px 14px;font-size:13px;font-weight:700;border-top:2px solid #e8eaed;text-align:right;color:#374151">Sub Total</td>
          <td style="padding:12px 14px;font-size:13px;font-weight:700;border-top:2px solid #e8eaed;text-align:right;color:#374151">${amt(inv.net_total || inv.grand_total)}</td>
        </tr>
        <tr style="background:#f8faff">
          <td colspan="3"></td>
          <td style="padding:8px 14px;font-size:14px;font-weight:800;text-align:right;color:#1a1d23;border-top:1px solid #e8eaed">Total</td>
          <td style="padding:8px 14px;font-size:14px;font-weight:800;text-align:right;color:#1a1d23;border-top:1px solid #e8eaed">${amt(inv.grand_total)}</td>
        </tr>
        ${paidAmt > 0 ? `<tr><td colspan="3"></td>
          <td style="padding:6px 14px;font-size:13px;text-align:right;color:#059669;font-weight:600">Payment Made</td>
          <td style="padding:6px 14px;font-size:13px;text-align:right;color:#059669;font-weight:600">-${amt(paidAmt)}</td>
        </tr>` : ""}
        <tr>
          <td colspan="3"></td>
          <td style="padding:10px 14px;font-size:14px;font-weight:800;text-align:right;color:#2563EB;background:#eef2ff;border-radius:0">Balance Due</td>
          <td style="padding:10px 14px;font-size:15px;font-weight:800;text-align:right;color:#2563EB;background:#eef2ff">${amt(inv.outstanding_amount || inv.grand_total)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- Footer -->
  <div style="padding:20px 36px;border:1px solid #e8eaed;border-top:none;border-radius:0 0 10px 10px;background:#fafbff">
    <p style="font-size:12.5px;color:#9ca3af;margin:0;text-align:center">If you have any questions about this invoice, please contact us by replying to this email.</p>
  </div>

</div>`;
      }

      async function loadDefaults() {
        if (!props.invoiceName) return;
        loading.value = true; error.value = "";
        try {
          const d = await apiGET("zoho_books_clone.api.books_data.get_invoice_email_defaults", { invoice_name: props.invoiceName });
          toTags.value = d.to ? [d.to] : [];
          subject.value = d.subject || "";
          fromEmail.value = d.from_email || frappe?.session?.user || "";
        } catch (e) { error.value = "Could not load defaults: " + e.message; }
        finally {
          loading.value = false;
          // Wait for v-else branch (editor) to render now that loading=false
          await nextTick();
          await nextTick();
          if (editorRef.value) {
            editorRef.value.innerHTML = buildInvoiceHtml(props.inv);
          } else {
            // Fallback: find by class if ref not bound yet
            const el = document.querySelector(".sem-editor");
            if (el) el.innerHTML = buildInvoiceHtml(props.inv);
          }
        }
      }

      watch(() => props.show, async v => {
        if (v && props.invoiceName) {
          toTags.value = []; ccTags.value = []; bccTags.value = [];
          toVal.value = ""; ccVal.value = ""; bccVal.value = "";
          error.value = "";
          await nextTick();
          loadDefaults();
        }
      });
      watch(() => props.inv, async v => {
        if (props.show && v) {
          await nextTick();
          const el = editorRef.value || document.querySelector(".sem-editor");
          if (el) el.innerHTML = buildInvoiceHtml(v);
        }
      });

      async function send() {
        // Flush any pending input
        if (toVal.value.trim()) { addTagFromVal(toVal.value, toTags); toVal.value = ""; }
        if (!toTags.value.length) { error.value = "Please enter at least one recipient email address."; return; }
        sending.value = true; error.value = "";
        const bodyHtml = (editorRef.value || document.querySelector(".sem-editor"))?.innerHTML || "";
        try {
          await apiPOST("zoho_books_clone.api.books_data.send_invoice_email", {
            invoice_name: props.invoiceName,
            to: toTags.value.join(","),
            subject: subject.value,
            body: bodyHtml,
            cc: ccTags.value.join(",")
          });
          toast("Invoice emailed to " + toTags.value.join(", "), "success");
          emit("sent");
          emit("close");
        } catch (e) { error.value = e.message || "Failed to send email."; }
        finally { sending.value = false; }
      }

      return {
        sending, loading, error, fromEmail,
        toVal, toTags, ccVal, ccTags, bccVal, bccTags, showCc, showBcc, subject, editorRef,
        addTagFromVal, removeTag, onToKey, onCcKey, onBccKey,
        onToBlur, onCcBlur, onBccBlur,
        execCmd, send
      };
    },
    template: `
<teleport to="body">
<div v-if="show" class="sem-page">
  <!-- Page header -->
  <div class="sem-page-header">
    <div style="display:flex;align-items:center;gap:12px">
      <button class="sem-back-btn" @click="$emit('close')" title="Back">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      </button>
      <h2 class="sem-page-title">Email To {{inv&&(inv.customer_name||inv.customer)||'Customer'}}</h2>
    </div>
  </div>

  <div v-if="loading" style="padding:40px;text-align:center">
    <div class="b-shimmer" style="height:16px;border-radius:4px;margin-bottom:12px"></div>
    <div class="b-shimmer" style="height:16px;border-radius:4px;width:60%"></div>
  </div>

  <div v-else class="sem-content">
    <!-- Error -->
    <div v-if="error" class="sem-error">⚠ {{error}}</div>

    <!-- From -->
    <div class="sem-row">
      <span class="sem-row-label">From</span>
      <div class="sem-row-value sem-from-val">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
        <span style="font-size:13px;color:#444">{{fromEmail||'Administrator'}}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#aaa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:4px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div class="sem-row-actions">
        <button class="sem-link-btn" v-if="!showBcc" @click="showBcc=true">Bcc</button>
      </div>
    </div>

    <!-- Send To (chips) -->
    <div class="sem-row sem-row-tall">
      <span class="sem-row-label">Send To</span>
      <div class="sem-chips-wrap">
        <div v-for="(tag,i) in toTags" :key="tag" class="sem-chip">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          <span>{{tag}}</span>
          <button @click="removeTag(toTags,i)" class="sem-chip-remove">✕</button>
        </div>
        <input v-model="toVal" class="sem-chip-input" placeholder="Enter email and press Enter or comma"
          @keydown="onToKey" @blur="onToBlur"/>
      </div>
    </div>

    <!-- CC (chips) -->
    <div class="sem-row sem-row-tall" v-if="showCc">
      <span class="sem-row-label">Cc</span>
      <div class="sem-chips-wrap">
        <div v-for="(tag,i) in ccTags" :key="tag" class="sem-chip">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          <span>{{tag}}</span>
          <button @click="removeTag(ccTags,i)" class="sem-chip-remove">✕</button>
        </div>
        <input v-model="ccVal" class="sem-chip-input" placeholder="Add CC recipients"
          @keydown="onCcKey" @blur="onCcBlur"/>
      </div>
    </div>

    <!-- BCC (chips) -->
    <div class="sem-row sem-row-tall" v-if="showBcc">
      <span class="sem-row-label">Bcc</span>
      <div class="sem-chips-wrap">
        <div v-for="(tag,i) in bccTags" :key="tag" class="sem-chip">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          <span>{{tag}}</span>
          <button @click="removeTag(bccTags,i)" class="sem-chip-remove">✕</button>
        </div>
        <input v-model="bccVal" class="sem-chip-input" placeholder="Add BCC recipients"
          @keydown="onBccKey" @blur="onBccBlur"/>
      </div>
    </div>

    <!-- Subject -->
    <div class="sem-row">
      <span class="sem-row-label">Subject</span>
      <input v-model="subject" class="sem-subject-input" placeholder="Email subject"/>
    </div>

    <!-- Rich text toolbar -->
    <div class="sem-toolbar">
      <button class="sem-tb-btn" @click="execCmd('bold')" title="Bold"><b>B</b></button>
      <button class="sem-tb-btn" @click="execCmd('italic')" title="Italic"><i>I</i></button>
      <button class="sem-tb-btn" @click="execCmd('underline')" title="Underline"><u>U</u></button>
      <button class="sem-tb-btn" @click="execCmd('strikeThrough')" title="Strikethrough"><s>S</s></button>
      <div class="sem-tb-sep"></div>
      <select class="sem-tb-select" @change="e=>execCmd('fontSize',e.target.value)" title="Font size">
        <option value="2">12px</option>
        <option value="3" selected>16px</option>
        <option value="4">18px</option>
        <option value="5">24px</option>
        <option value="6">32px</option>
      </select>
      <select class="sem-tb-select" @change="e=>execCmd('fontName',e.target.value)" title="Font">
        <option>Arial</option>
        <option>Georgia</option>
        <option>Times New Roman</option>
        <option>Courier New</option>
      </select>
      <div class="sem-tb-sep"></div>
      <button class="sem-tb-btn" @click="execCmd('justifyLeft')" title="Align left">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>
      </button>
      <button class="sem-tb-btn" @click="execCmd('justifyCenter')" title="Center">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
      </button>
      <button class="sem-tb-btn" @click="execCmd('insertUnorderedList')" title="Bullet list">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
      </button>
      <button class="sem-tb-btn" @click="execCmd('insertOrderedList')" title="Numbered list">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2" y="7" font-size="6" fill="currentColor" stroke="none">1</text><text x="2" y="13" font-size="6" fill="currentColor" stroke="none">2</text><text x="2" y="19" font-size="6" fill="currentColor" stroke="none">3</text></svg>
      </button>
      <div class="sem-tb-sep"></div>
      <button class="sem-tb-btn" @click="execCmd('createLink',prompt('URL:','https://'))" title="Insert link">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      </button>
    </div>

    <!-- Rich text editor -->
    <div ref="editorRef" class="sem-editor" contenteditable="true" spellcheck="true"
      style="min-height:420px;padding:24px 32px;outline:none;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;overflow-y:auto">
    </div>

    <!-- Footer actions -->
    <div class="sem-footer">
      <button class="sem-send-btn" @click="send" :disabled="sending||!toTags.length">
        <span v-if="sending" style="display:inline-block;animation:spin .8s linear infinite;font-size:15px">↻</span>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        {{sending?'Sending…':'Send'}}
      </button>
      <button class="sem-cancel-btn" @click="$emit('close')" :disabled="sending">Cancel</button>
    </div>
  </div>
</div>
</teleport>
`});

  /* ═══════════════════════════════════════════════════════════════
     PURCHASE BILL MODAL — same structure, different fields
  ═══════════════════════════════════════════════════════════════ */
  const PurchaseModal = defineComponent({
    name: "PurchaseModal",
    props: { show: Boolean },
    emits: ["close", "saved"],
    setup(props, { emit }) {
      const saving = ref(false);
      const suppliers = ref([]), accounts_ap = ref([]), accounts_exp = ref([]);

      const form = reactive({
        naming_series: "PINV-.YYYY.-.#####",
        supplier: "", supplier_name: "",
        posting_date: today(), due_date: today(),
        bill_no: "",
        company: co(), currency: "INR",
        credit_to: "", expense_account: "",
        items: [{ item_name: "", qty: 1, rate: 0, amount: 0 }],
        taxes: [],
        net_total: 0, total_tax: 0, grand_total: 0,
      });

      function recalc() {
        form.items.forEach(i => { i.amount = Math.round(flt(i.qty) * flt(i.rate) * 100) / 100; });
        const net = form.items.reduce((s, i) => s + flt(i.amount), 0);
        form.taxes.forEach(t => { t.tax_amount = flt(t.rate) > 0 ? Math.round(net * flt(t.rate) / 100 * 100) / 100 : 0; });
        const tax = form.taxes.reduce((s, t) => s + flt(t.tax_amount), 0);
        form.net_total = Math.round(net * 100) / 100;
        form.total_tax = Math.round(tax * 100) / 100;
        form.grand_total = Math.round((net + tax) * 100) / 100;
      }

      function addItem() { form.items.push({ item_name: "", qty: 1, rate: 0, amount: 0 }); }
      function removeItem(i) { if (form.items.length > 1) { form.items.splice(i, 1); recalc(); } }

      async function loadDefaults() {
        const c = await resolveCompany(); form.company = c;
        try {
          const ap = await apiList("Account", { fields: ["name"], filters: [["account_type", "=", "Payable"], ["is_group", "=", 0]], limit: 50 });
          accounts_ap.value = ap;
          if (ap.length && !form.credit_to) form.credit_to = ap[0].name;
        } catch (e) { console.warn("AP accounts failed:", e.message); }
        try {
          const exp = await apiList("Account", { fields: ["name"], filters: [["account_type", "in", ["Expense Account", "Expense", "Cost of Goods Sold"]], ["is_group", "=", 0]], limit: 50 });
          accounts_exp.value = exp;
          if (exp.length && !form.expense_account) form.expense_account = exp[0].name;
        } catch (e) { console.warn("Expense accounts failed:", e.message); }
        try { suppliers.value = await apiList("Supplier", { fields: ["name"], limit: 50, order: "name asc" }); } catch { }
      }

      onMounted(loadDefaults);
      watch(() => props.show, v => { if (v) loadDefaults(); });

      async function onSupplier() {
        if (!form.supplier) return;
        try {
          const r = await apiGET("frappe.client.get_value", { doctype: "Supplier", filters: JSON.stringify({ name: form.supplier }), fieldname: JSON.stringify(["default_currency"]) });
          form.supplier_name = form.supplier;
          if (r.default_currency) form.currency = r.default_currency;
        } catch { }
      }

      async function save(andSubmit) {
        if (!form.supplier) { toast("Please select a Supplier", "error"); return; }
        if (!form.items[0].item_name && !form.items[0].rate) { toast("Please add at least one item", "error"); return; }
        if (!form.credit_to) { toast("Please set the Accounts Payable (Credit To) account", "error"); return; }
        if (!form.expense_account) { toast("Please set the Expense Account", "error"); return; }
        recalc(); saving.value = true;
        const doc = {
          doctype: "Purchase Invoice",
          naming_series: form.naming_series,
          supplier: form.supplier,
          posting_date: form.posting_date, due_date: form.due_date || form.posting_date,
          bill_no: form.bill_no,
          company: form.company, currency: form.currency || "INR",
          credit_to: form.credit_to, expense_account: form.expense_account,
          items: form.items.filter(i => i.item_name || flt(i.rate)).map((i, idx) => ({
            doctype: "Purchase Invoice Item",
            item_name: i.item_name || "Item " + (idx + 1),
            qty: flt(i.qty) || 1, rate: flt(i.rate), amount: flt(i.amount),
          })),
          taxes: form.taxes.map(t => ({ doctype: "Tax Line", tax_type: t.tax_type, description: t.description || t.tax_type, rate: flt(t.rate), tax_amount: flt(t.tax_amount), account_head: t.account_head || "" })),
        };
        try {
          const saved = await apiSave(doc);
          if (andSubmit) { await apiSubmit("Purchase Invoice", saved.name); toast("Bill " + saved.name + " submitted!"); }
          else { toast("Bill " + saved.name + " saved as Draft"); }
          emit("saved", saved.name); emit("close");
          setTimeout(() => window.open(docUrl("Purchase Invoice", saved.name), "_blank"), 300);
        } catch (e) { toast(e.message || "Could not save bill", "error"); }
        finally { saving.value = false; }
      }

      return { form, saving, suppliers, accounts_ap, accounts_exp, recalc, addItem, removeItem, onSupplier, save, fmt, flt, icon };
    },
    template: `
<teleport to="body">
<div v-if="show" style="position:fixed;inset:0;z-index:9000;display:flex;align-items:flex-start;
     justify-content:center;background:rgba(0,0,0,.45);padding:32px 16px;overflow-y:auto" @click.self="$emit('close')">
  <div style="background:#fff;border-radius:12px;width:100%;max-width:800px;
       box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;margin:auto">
    <div style="background:#2F9E44;padding:18px 24px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="color:#fff;font-size:16px;font-weight:700">New Purchase Bill</div>
        <div style="color:rgba(255,255,255,.65);font-size:12px;margin-top:2px">{{form.company}}</div>
      </div>
      <button @click="$emit('close')" style="background:rgba(255,255,255,.15);border:none;cursor:pointer;
        width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff"
        v-html="icon('x',16)"></button>
    </div>
    <div style="padding:24px;overflow-y:auto;max-height:calc(100vh - 180px)">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:14px;margin-bottom:16px">
        <div style="grid-column:1/3">
          <label class="mi-label">Supplier <span style="color:#C92A2A">*</span></label>
          <select v-model="form.supplier" @change="onSupplier" class="mi-input">
            <option value="">— Select Supplier —</option>
            <option v-for="s in suppliers" :key="s.name" :value="s.name">{{s.name}}</option>
          </select>
        </div>
        <div>
          <label class="mi-label">Supplier Invoice No</label>
          <input v-model="form.bill_no" class="mi-input" placeholder="e.g. INV-001"/>
        </div>
        <div>
          <label class="mi-label">Date</label>
          <input v-model="form.posting_date" type="date" class="mi-input"/>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
        <div>
          <label class="mi-label">Credit To (AP Account) <span style="color:#C92A2A">*</span></label>
          <select v-model="form.credit_to" class="mi-input">
            <option value="">— Select —</option>
            <option v-for="a in accounts_ap" :key="a.name" :value="a.name">{{a.name}}</option>
          </select>
        </div>
        <div>
          <label class="mi-label">Expense Account <span style="color:#C92A2A">*</span></label>
          <select v-model="form.expense_account" class="mi-input">
            <option value="">— Select —</option>
            <option v-for="a in accounts_exp" :key="a.name" :value="a.name">{{a.name}}</option>
          </select>
        </div>
      </div>
      <!-- Items -->
      <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868E96;margin-bottom:8px">Items</div>
      <div style="border:1px solid #E8ECF0;border-radius:8px;overflow:hidden;margin-bottom:16px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#F8F9FC">
            <th class="mi-th">Item Name</th><th class="mi-th" style="text-align:center">Qty</th>
            <th class="mi-th" style="text-align:right">Rate (₹)</th>
            <th class="mi-th" style="text-align:right">Amount (₹)</th>
            <th class="mi-th"></th>
          </tr></thead>
          <tbody>
            <tr v-for="(item,i) in form.items" :key="i" :style="i%2===1?'background:#FAFBFC':''">
              <td class="mi-td"><input v-model="item.item_name" class="mi-cell-input" placeholder="Item name"/></td>
              <td class="mi-td" style="text-align:center"><input v-model.number="item.qty" type="number" min="0.01" class="mi-cell-input" style="text-align:center;width:60px" @input="recalc"/></td>
              <td class="mi-td" style="text-align:right"><input v-model.number="item.rate" type="number" min="0" class="mi-cell-input" style="text-align:right" @input="recalc"/></td>
              <td class="mi-td" style="text-align:right;font-family:monospace;font-size:13px;font-weight:600;padding-right:12px">{{flt(item.amount).toLocaleString("en-IN",{minimumFractionDigits:2})}}</td>
              <td class="mi-td" style="text-align:center"><button @click="removeItem(i)" v-if="form.items.length>1" style="background:none;border:none;cursor:pointer;color:#C92A2A" v-html="icon('trash',14)"></button></td>
            </tr>
          </tbody>
        </table>
        <div style="padding:8px 12px;background:#F8F9FC;border-top:1px solid #E8ECF0">
          <button @click="addItem" style="background:none;border:none;cursor:pointer;color:#2F9E44;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:5px;font-family:inherit"><span v-html="icon('plus',13)"></span> Add Row</button>
        </div>
      </div>
      <!-- Totals -->
      <div style="display:flex;justify-content:flex-end">
        <div style="min-width:240px;background:#F0FDF4;border:1px solid #86EFAC;border-radius:8px;overflow:hidden">
          <div style="display:flex;justify-content:space-between;padding:10px 16px;font-size:13px;color:#495057;border-bottom:1px solid #86EFAC"><span>Subtotal</span><span style="font-family:monospace">{{fmt(form.net_total)}}</span></div>
          <div style="display:flex;justify-content:space-between;padding:12px 16px;font-size:15px;font-weight:700;color:#2F9E44"><span>Grand Total</span><span style="font-family:monospace">{{fmt(form.grand_total)}}</span></div>
        </div>
      </div>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #E8ECF0;display:flex;justify-content:flex-end;gap:10px;background:#FAFBFC">
      <button @click="$emit('close')" :disabled="saving" style="padding:9px 18px;border:1px solid #CDD5E0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;font-weight:500;color:#495057;font-family:inherit">Cancel</button>
      <button @click="save(false)" :disabled="saving" style="padding:9px 18px;border:1px solid #2F9E44;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;font-weight:500;color:#2F9E44;font-family:inherit">{{saving?'Saving…':'Save as Draft'}}</button>
      <button @click="save(true)" :disabled="saving" style="padding:9px 18px;border:none;border-radius:6px;background:#2F9E44;cursor:pointer;font-size:13px;font-weight:600;color:#fff;font-family:inherit">{{saving?'Submitting…':'Save & Submit'}}</button>
    </div>
  </div>
</div>
</teleport>
`});

  /* ═══════════════════════════════════════════════════════════════
     PAYMENT MODAL
  ═══════════════════════════════════════════════════════════════ */
  const PaymentModal = defineComponent({
    name: "PaymentModal",
    props: { show: Boolean },
    emits: ["close", "saved"],
    setup(props, { emit }) {
      const saving = ref(false);
      const accounts_bank = ref([]), accounts_ar = ref([]), accounts_ap = ref([]);
      const invoices = ref([]);

      const form = reactive({
        naming_series: "PAY-.YYYY.-.#####",
        payment_type: "Receive", party_type: "Customer", party: "", party_name: "",
        payment_date: today(), paid_amount: 0, currency: "INR",
        mode_of_payment: "Bank Transfer", reference_no: "",
        paid_from: "", paid_to: "", company: co(),
        remarks: "",
      });

      const customers = ref([]), suppliers = ref([]);
      const paymentModes = ref([{ name: "Bank Transfer" }, { name: "Cash" }, { name: "Cheque" }, { name: "NEFT" }, { name: "RTGS" }, { name: "UPI" }]);

      async function loadDefaults() {
        const c = await resolveCompany(); form.company = c;
        // Load payment modes — try Books Payment Mode (custom), fallback to hardcoded
        try {
          const modes = await apiList("Books Payment Mode", { fields: ["name"], limit: 50, order: "name asc" });
          if (modes && modes.length) paymentModes.value = modes;
        } catch {
          // keep hardcoded defaults: Bank Transfer, Cash, Cheque, NEFT, RTGS, UPI
        }
        try {
          const bank = await apiList("Account", { fields: ["name"], filters: [["account_type", "in", ["Bank", "Cash"]], ["is_group", "=", 0]], limit: 50 });
          accounts_bank.value = bank;
        } catch (e) { console.warn("Bank accounts failed:", e.message); }
        try {
          const ar = await apiList("Account", { fields: ["name"], filters: [["account_type", "=", "Receivable"], ["is_group", "=", 0]], limit: 50 });
          accounts_ar.value = ar;
        } catch (e) { console.warn("AR accounts failed:", e.message); }
        try {
          const ap = await apiList("Account", { fields: ["name"], filters: [["account_type", "=", "Payable"], ["is_group", "=", 0]], limit: 50 });
          accounts_ap.value = ap;
        } catch (e) { console.warn("AP accounts failed:", e.message); }
        try { customers.value = await apiList("Customer", { fields: ["name"], limit: 50, order: "name asc" }); } catch { }
        try { suppliers.value = await apiList("Supplier", { fields: ["name"], limit: 50, order: "name asc" }); } catch { }
        _autoFillAccounts();
      }

      function _autoFillAccounts() {
        if (form.payment_type === "Receive") {
          if (accounts_ar.value.length && !form.paid_from) form.paid_from = accounts_ar.value[0].name;
          if (accounts_bank.value.length && !form.paid_to) form.paid_to = accounts_bank.value[0].name;
        } else {
          if (accounts_bank.value.length && !form.paid_from) form.paid_from = accounts_bank.value[0].name;
          if (accounts_ap.value.length && !form.paid_to) form.paid_to = accounts_ap.value[0].name;
        }
      }

      watch(() => form.payment_type, () => {
        form.party_type = form.payment_type === "Receive" ? "Customer" : "Supplier";
        form.party = ""; form.party_name = "";
        form.paid_from = ""; form.paid_to = "";
        invoices.value = [];
        _autoFillAccounts();
      });
      watch(() => props.show, v => { if (v) loadDefaults(); });
      onMounted(loadDefaults);

      const partyList = computed(() => form.party_type === "Customer" ? customers.value : suppliers.value);

      async function onParty() {
        if (!form.party) return;
        try {
          const nameField = "name"; // custom doctypes use name as display name
          const r = await apiGET("frappe.client.get_value", { doctype: form.party_type, filters: JSON.stringify({ name: form.party }), fieldname: JSON.stringify([nameField]) });
          form.party_name = form.party; // name is display name
        } catch { }
        // Load outstanding invoices
        try {
          invoices.value = await apiGET("zoho_books_clone.payments.utils.get_outstanding_invoices", { party_type: form.party_type, party: form.party });
          if (invoices.value.length) {
            form.paid_amount = invoices.value.reduce((s, i) => s + flt(i.outstanding_amount), 0);
            form.remarks = "Payment against " + (invoices.value.length === 1 ? invoices.value[0].name : invoices.value.length + " invoices");
          }
        } catch { }
      }

      async function save() {
        if (!form.party) { toast("Please select a party", "error"); return; }
        if (!flt(form.paid_amount)) { toast("Please enter payment amount", "error"); return; }
        if (!form.paid_from) { toast("Please select the Paid From account", "error"); return; }
        if (!form.paid_to) { toast("Please select the Paid To account", "error"); return; }
        saving.value = true;
        try {
          let peName;
          if (invoices.value.length) {
            // Use backend utility which handles GL + invoice outstanding update
            const method = form.payment_type === "Receive" ? "zoho_books_clone.payments.utils.make_payment_entry_from_invoice" : "zoho_books_clone.payments.utils.make_payment_entry_from_purchase_invoice";
            peName = await apiGET(method, {
              source_name: invoices.value[0].name,
              paid_amount: form.paid_amount,
              payment_date: form.payment_date,
              mode_of_payment: form.mode_of_payment,
              reference_no: form.reference_no,
              paid_to: form.payment_type === "Receive" ? form.paid_to : undefined,
              paid_from: form.payment_type === "Pay" ? form.paid_from : undefined,
            });
          } else {
            // Standalone payment without invoice link
            const doc = {
              doctype: "Payment Entry",
              naming_series: form.naming_series,
              payment_type: form.payment_type,
              payment_date: form.payment_date,
              party_type: form.party_type,
              party: form.party, party_name: form.party_name,
              paid_from: form.paid_from, paid_to: form.paid_to,
              paid_amount: flt(form.paid_amount),
              currency: form.currency,
              mode_of_payment: form.mode_of_payment,
              reference_no: form.reference_no,
              company: form.company,
              remarks: form.remarks,
            };
            const saved = await apiSave(doc);
            await apiSubmit("Payment Entry", saved.name);
            peName = saved.name;
          }
          toast("Payment " + peName + " recorded!");
          emit("saved", peName); emit("close");
          setTimeout(() => window.open(docUrl("Payment Entry", peName), "_blank"), 300);
        } catch (e) { toast(e.message || "Could not save payment", "error"); }
        finally { saving.value = false; }
      }

      return { form, saving, customers, suppliers, accounts_bank, accounts_ar, accounts_ap, invoices, partyList, onParty, save, fmt, flt, icon, paymentModes };
    },
    template: `
<teleport to="body">
<div v-if="show" style="position:fixed;inset:0;z-index:9000;display:flex;align-items:flex-start;
     justify-content:center;background:rgba(0,0,0,.45);padding:32px 16px;overflow-y:auto" @click.self="$emit('close')">
  <div style="background:#fff;border-radius:12px;width:100%;max-width:600px;
       box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;margin:auto">
    <div style="background:#7C3AED;padding:18px 24px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="color:#fff;font-size:16px;font-weight:700">New Payment</div>
        <div style="color:rgba(255,255,255,.65);font-size:12px;margin-top:2px">{{form.company}}</div>
      </div>
      <button @click="$emit('close')" style="background:rgba(255,255,255,.15);border:none;cursor:pointer;
        width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff"
        v-html="icon('x',16)"></button>
    </div>
    <div style="padding:24px;overflow-y:auto;max-height:calc(100vh - 180px)">
      <!-- Type selector -->
      <div style="display:flex;gap:8px;margin-bottom:20px">
        <button v-for="t in ['Receive','Pay']" :key="t" @click="form.payment_type=t"
          :style="{padding:'9px 20px',borderRadius:'6px',fontSize:'13px',fontWeight:'600',cursor:'pointer',fontFamily:'inherit',transition:'.15s',background:form.payment_type===t?'#7C3AED':'#fff',color:form.payment_type===t?'#fff':'#495057',border:form.payment_type===t?'none':'1px solid #CDD5E0'}">
          {{t==="Receive"?"Receive (Customer)":"Pay (Supplier)"}}
        </button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <div>
          <label class="mi-label">{{form.party_type}} <span style="color:#C92A2A">*</span></label>
          <select v-model="form.party" @change="onParty" class="mi-input">
            <option value="">— Select —</option>
            <option v-for="p in partyList" :key="p.name" :value="p.name">{{p.name}}</option>
          </select>
        </div>
        <div>
          <label class="mi-label">Payment Date</label>
          <input v-model="form.payment_date" type="date" class="mi-input"/>
        </div>
      </div>
      <div v-if="invoices.length" style="background:#F0FDF4;border:1px solid #86EFAC;border-radius:8px;
           padding:12px 16px;margin-bottom:14px;font-size:13px">
        <div style="font-weight:600;color:#2F9E44;margin-bottom:6px">{{invoices.length}} outstanding invoice(s)</div>
        <div v-for="inv in invoices.slice(0,3)" :key="inv.name"
             style="display:flex;justify-content:space-between;color:#495057;padding:2px 0">
          <span>{{inv.name}}</span>
          <span style="font-family:monospace;font-weight:600">{{fmt(inv.outstanding_amount)}}</span>
        </div>
        <div v-if="invoices.length>3" style="color:#868E96;font-size:12px;margin-top:4px">+{{invoices.length-3}} more</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <div>
          <label class="mi-label">Amount <span style="color:#C92A2A">*</span></label>
          <input v-model.number="form.paid_amount" type="number" min="0" step="0.01" class="mi-input" style="font-weight:700;font-size:15px"/>
        </div>
        <div>
          <label class="mi-label">Mode of Payment</label>
          <select v-model="form.mode_of_payment" class="mi-input">
            <option value="">— Select —</option>
            <option v-for="m in paymentModes" :key="m.name" :value="m.name">{{m.name}}</option>
          </select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <div>
          <label class="mi-label">Paid From Account <span style="color:#C92A2A">*</span></label>
          <select v-model="form.paid_from" class="mi-input">
            <option value="">— Select —</option>
            <option v-for="a in (form.payment_type==='Receive'?accounts_ar:accounts_bank)" :key="a.name" :value="a.name">{{a.name}}</option>
          </select>
        </div>
        <div>
          <label class="mi-label">Paid To Account <span style="color:#C92A2A">*</span></label>
          <select v-model="form.paid_to" class="mi-input">
            <option value="">— Select —</option>
            <option v-for="a in (form.payment_type==='Receive'?accounts_bank:accounts_ap)" :key="a.name" :value="a.name">{{a.name}}</option>
          </select>
        </div>
      </div>
      <div>
        <label class="mi-label">Reference No (UTR / Cheque)</label>
        <input v-model="form.reference_no" class="mi-input" placeholder="Optional"/>
      </div>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #E8ECF0;display:flex;justify-content:flex-end;gap:10px;background:#FAFBFC">
      <button @click="$emit('close')" :disabled="saving" style="padding:9px 18px;border:1px solid #CDD5E0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;font-weight:500;color:#495057;font-family:inherit">Cancel</button>
      <button @click="save" :disabled="saving" style="padding:9px 18px;border:none;border-radius:6px;background:#7C3AED;cursor:pointer;font-size:13px;font-weight:600;color:#fff;font-family:inherit">{{saving?'Processing…':'Record Payment'}}</button>
    </div>
  </div>
</div>
</teleport>
`});

  /* ═══════════════════════════════════════════════════════════════
     PAGE COMPONENTS (Dashboard, Invoices, Payments, etc.)
     Using the modal components above for New actions
  ═══════════════════════════════════════════════════════════════ */


  /* ─── Invoice Detail Component ───────────────────────────────── */



  const Dashboard = defineComponent({
    name: "Dashboard",
    components: { InvoiceModal, PurchaseModal, PaymentModal },
    setup() {
      const kpis = ref(null), dash = ref(null), aging = ref({});
      const loading = ref(true), showSI = ref(false), showPI = ref(false), showPay = ref(false);
      const agingRows = [{ k: "current", lbl: "Current", color: "#2F9E44" }, { k: "1_30", lbl: "1–30 days", color: "#E67700" }, { k: "31_60", lbl: "31–60 days", color: "#F08C00" }, { k: "61_90", lbl: "61–90 days", color: "#E8590C" }, { k: "over_90", lbl: "90+ days", color: "#C92A2A" }];
      const agingMax = computed(() => Math.max(1, ...agingRows.map(r => flt(aging.value[r.k]))));
      const kpiDefs = computed(() => [
        { lbl: "Monthly Revenue", val: fmt(kpis.value?.month_revenue), trend: `${kpis.value?.overdue_count || 0} overdue`, up: true, icon: "trend", bg: "#eff6ff", ic: "#2563eb" },
        { lbl: "Collected", val: fmt(kpis.value?.month_collected), trend: "this month", up: true, icon: "pay", bg: "#f0fdf4", ic: "#16a34a" },
        { lbl: "Outstanding", val: fmt(kpis.value?.month_outstanding), trend: kpis.value?.overdue_count + " overdue", up: false, icon: "accts", bg: "#fef2f2", ic: "#dc2626" },
        { lbl: "Net Profit (MTD)", val: fmt(kpis.value?.net_profit_mtd), trend: "month to date", up: true, icon: "chart", bg: "#f5f3ff", ic: "#7c3aed" },
      ]);
      // Static demo data shown when API returns empty / fails
      const DEMO = {
        month_revenue: 125000, month_collected: 98500, month_outstanding: 26500, net_profit_mtd: 41200,
        total_assets: 340000, overdue_count: 4,
        top_customers: [
          { customer: "Prasath Enterprises", invoice_count: 5, total_revenue: 52000 },
          { customer: "Hari Industries", invoice_count: 3, total_revenue: 31500 },
          { customer: "Digitise Pvt Ltd", invoice_count: 2, total_revenue: 18000 },
          { customer: "Alpha Solutions", invoice_count: 2, total_revenue: 12750 },
          { customer: "Beta Corp", invoice_count: 1, total_revenue: 10750 },
        ],
        overdue_invoices: [
          { name: "INV-2026-00002", customer: "hari", customer_name: "hari", due_date: "2026-03-18", grand_total: 15000, outstanding_amount: 15000 },
          { name: "INV-2026-00008", customer: "hari", customer_name: "hari", due_date: "2026-03-18", grand_total: 500, outstanding_amount: 500 },
          { name: "INV-2026-00011", customer: "hari", customer_name: "hari", due_date: "2026-03-18", grand_total: 545, outstanding_amount: 545 },
          { name: "INV-2026-00012", customer: "Prasath", customer_name: "Prasath", due_date: "2026-03-18", grand_total: 100000, outstanding_amount: 100000 },
        ],
        aging_buckets: { current: 26500, "1_30": 18000, "31_60": 8200, "61_90": 3100, over_90: 1450 },
      };

      async function load() {
        loading.value = true;
        const company = await resolveCompany();
        try {
          const d = await apiGET("zoho_books_clone.api.dashboard.get_home_dashboard", { company });
          const hasData = d && (d.month_revenue || d.month_collected || d.month_outstanding || (d.overdue_invoices && d.overdue_invoices.length) || (d.top_customers && d.top_customers.length));
          const src = hasData ? d : DEMO;
          dash.value = src;
          kpis.value = {
            month_revenue: src.month_revenue || 0,
            month_collected: src.month_collected || 0,
            month_outstanding: src.month_outstanding || 0,
            net_profit_mtd: src.net_profit_mtd || 0,
            total_assets: src.total_assets || 0,
            overdue_count: src.overdue_count || (src.overdue_invoices?.length || 0),
          };
          aging.value = src.aging_buckets || {};
        } catch (e) {
          console.error("[Dashboard]", e);
          // API failed — show demo data so page is never blank
          dash.value = DEMO;
          kpis.value = { month_revenue: DEMO.month_revenue, month_collected: DEMO.month_collected, month_outstanding: DEMO.month_outstanding, net_profit_mtd: DEMO.net_profit_mtd, total_assets: DEMO.total_assets, overdue_count: DEMO.overdue_count };
          aging.value = DEMO.aging_buckets;
        }
        finally { loading.value = false; }
      }
      onMounted(load);
      return { kpis, dash, aging, loading, kpiDefs, agingRows, agingMax, showSI, showPI, showPay, load, fmt, fmtDate, fmtShort, isOverdue, statusBadge, icon, openDoc, flt };
    },
    template: `
<div class="b-page">
  <InvoiceModal :show="showSI" @close="showSI=false" @saved="load"/>
  <PurchaseModal :show="showPI" @close="showPI=false" @saved="load"/>
  <PaymentModal :show="showPay" @close="showPay=false" @saved="load"/>
  <div class="b-quick-actions">
    <button class="b-btn b-btn-primary" @click="showSI=true"><span v-html="icon('plus',14)"></span> New Invoice</button>
    <button class="b-btn" style="border:1px solid #2F9E44;color:#2F9E44;background:#fff" @click="showPI=true"><span v-html="icon('plus',14)"></span> New Bill</button>
    <button class="b-btn" style="border:1px solid #7C3AED;color:#7C3AED;background:#fff" @click="showPay=true"><span v-html="icon('plus',14)"></span> New Payment</button>
  </div>
  <div class="b-kpi-grid">
    <div v-for="k in kpiDefs" :key="k.lbl" class="b-kpi">
      <div class="b-kpi-top"><div class="b-kpi-icon-wrap" :style="{background:k.bg}"><span :style="{color:k.ic}" v-html="icon(k.icon,20)"></span></div></div>
      <div class="b-kpi-label">{{k.lbl}}</div>
      <div class="b-kpi-value"><div v-if="loading" class="b-shimmer" style="height:26px;width:110px"></div><template v-else>{{k.val}}</template></div>
      <div class="b-kpi-trend" :class="k.up?'b-kpi-trend-up':'b-kpi-trend-down'"><span>{{k.up?'▲':'▼'}}</span><span>{{k.trend}}</span></div>
    </div>
  </div>
  <div class="b-mid-grid">
    <div class="b-card">
      <div class="b-card-head"><span class="b-card-title">Recent Invoices</span><button class="b-btn b-btn-link" @click="$router.push('/invoices')">View all</button></div>
      <div v-if="loading" style="padding:20px"><div v-for="n in 5" :key="n" class="b-shimmer" style="height:14px;margin-bottom:16px"></div></div>
      <table v-else class="b-table"><thead><tr><th>Customer</th><th>Invoice</th><th>Date</th><th>Status</th></tr></thead>
        <tbody>
          <tr v-for="inv in (dash?.overdue_invoices?.slice(0,6)||[])" :key="inv.name" class="clickable" @click="$router.push('/invoices/'+inv.name)">
            <td class="fw-600">{{inv.customer}}</td>
            <td class="mono c-accent" style="font-size:12px">{{inv.name}}</td>
            <td class="c-muted" style="font-size:12px">{{fmtShort(inv.due_date)}}</td>
            <td><span class="b-badge b-badge-red">Overdue</span></td>
          </tr>
          <tr v-if="!(dash?.overdue_invoices?.length)"><td colspan="4" style="text-align:center;padding:32px;color:var(--green-text);font-weight:600">✓ All caught up!</td></tr>
        </tbody>
      </table>
    </div>
    <div class="b-card">
      <div class="b-card-head"><span class="b-card-title">AR Aging</span></div>
      <div class="b-card-body">
        <div v-if="loading"><div v-for="n in 5" :key="n" class="b-shimmer" style="height:14px;margin-bottom:16px"></div></div>
        <div v-else class="b-aging-rows">
          <div v-for="r in agingRows" :key="r.k" class="b-aging-row">
            <span class="b-aging-lbl">{{r.lbl}}</span>
            <div style="flex:1;background:#F1F3F5;border-radius:4px;height:6px;overflow:hidden;margin:0 10px">
              <div :style="{background:r.color,height:'100%',borderRadius:'4px',width:Math.min(100,flt(aging[r.k])/agingMax*100)+'%',transition:'width .5s'}"></div>
            </div>
            <span class="b-aging-amt" :style="{color:r.color}">{{fmt(aging[r.k])}}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="b-card">
    <div class="b-card-head"><span class="b-card-title">Top Customers</span><span class="b-badge b-badge-blue">This month</span></div>
    <div v-if="loading" style="padding:20px"><div class="b-shimmer" style="height:80px"></div></div>
    <table v-else class="b-table"><thead><tr><th>Customer</th><th class="ta-r">Invoices</th><th class="ta-r">Revenue</th></tr></thead>
      <tbody>
        <tr v-for="c in (dash?.top_customers||[])" :key="c.customer">
          <td class="fw-600">{{c.customer}}</td>
          <td class="ta-r mono">{{c.invoice_count}}</td>
          <td class="ta-r mono fw-700 c-green">{{fmt(c.total_revenue)}}</td>
        </tr>
        <tr v-if="!(dash?.top_customers?.length)"><td colspan="3" class="b-empty">No data this period</td></tr>
      </tbody>
    </table>
  </div>
</div>`});

  // ══ INVOICE LIST PAGE ════════════════════════════════════════════
  const Invoices = defineComponent({
    name: "Invoices",
    components: { InvoiceModal },
    setup() {
      const router = useRouter();
      const list = ref([]), loading = ref(true), active = ref("all"), showNew = ref(false);
      const search = ref("");
      const selected = ref(new Set());
      const sortKey = ref("posting_date"), sortDir = ref(-1);

      const filters = [
        { k: "all",     lbl: "All Invoices" },
        { k: "Draft",   lbl: "Draft" },
        { k: "Unpaid",  lbl: "Unpaid" },
        { k: "Overdue", lbl: "Overdue" },
        { k: "Paid",    lbl: "Paid" }
      ];

      const counts = computed(() => ({
        Draft:   list.value.filter(i => i.status === "Draft").length,
        Unpaid:  list.value.filter(i => !isOverdue(i) && ["Submitted","Unpaid","Partly Paid"].includes(i.status)).length,
        Overdue: list.value.filter(isOverdue).length,
        Paid:    list.value.filter(i => i.status === "Paid").length,
      }));

      const filtered = computed(() => {
        let r = list.value;
        if (active.value === "Overdue") r = r.filter(isOverdue);
        else if (active.value === "Unpaid") r = r.filter(i => !isOverdue(i) && ["Submitted","Unpaid","Partly Paid"].includes(i.status));
        else if (active.value !== "all") r = r.filter(i => i.status === active.value);
        if (search.value) {
          const q = search.value.toLowerCase();
          r = r.filter(i => (i.name + (i.customer_name || "") + (i.customer || "")).toLowerCase().includes(q));
        }
        return [...r].sort((a, b) => {
          const va = a[sortKey.value] ?? "", vb = b[sortKey.value] ?? "";
          return va < vb ? -sortDir.value : va > vb ? sortDir.value : 0;
        });
      });

      function pillCountCls(k) {
        return { Draft:"zb-pc-muted", Unpaid:"zb-pc-amber", Overdue:"zb-pc-red", Paid:"zb-pc-green" }[k] || "zb-pc-muted";
      }

      async function loadList() {
        loading.value = true;
        try {
          list.value = await apiList("Sales Invoice", {
            fields: ["name","customer","customer_name","invoice_number","posting_date","due_date","grand_total","outstanding_amount","status","currency","docstatus"],
            order: "posting_date desc",
            limit: 100
          });
        } catch (e) { toast("Failed to load invoices: " + e.message, "error"); }
        finally { loading.value = false; }
      }

      function goToInvoice(name) { router.push({ name: "invoice-detail", params: { name } }); }

      function sortBy(k) {
        if (sortKey.value === k) sortDir.value *= -1;
        else { sortKey.value = k; sortDir.value = -1; }
      }
      function sortArrow(k) { return sortKey.value === k ? (sortDir.value === 1 ? " ↑" : " ↓") : ""; }

      function overdueLabel(row) {
        const days = Math.floor((new Date() - new Date(row.due_date)) / 86400000);
        return "OVERDUE BY " + days + " DAY" + (days !== 1 ? "S" : "");
      }
      function statusChipCls(row) {
        if (isOverdue(row)) return "zb-chip-overdue";
        const s = row.status || "Draft";
        if (s === "Paid") return "zb-chip-paid";
        if (s === "Draft") return "zb-chip-draft";
        if (["Submitted","Unpaid","Partly Paid"].includes(s)) return "zb-chip-partpaid";
        return "zb-chip-draft";
      }
      function statusLabel(row) {
        if (isOverdue(row)) return overdueLabel(row);
        const s = row.status || "Draft";
        if (s === "Submitted") return "UNPAID";
        if (s === "Partly Paid") return "PARTIALLY PAID";
        if (s === "Paid") return "PAID";
        return s.toUpperCase();
      }

      function toggleRow(name) {
        const s = new Set(selected.value);
        s.has(name) ? s.delete(name) : s.add(name);
        selected.value = s;
      }
      function toggleAll(e) {
        selected.value = e.target.checked ? new Set(filtered.value.map(i => i.name)) : new Set();
      }
      const allSelected = computed(() => filtered.value.length > 0 && filtered.value.every(i => selected.value.has(i.name)));

      onMounted(loadList);
      return {
        list, loading, active, showNew, search, filters, counts, filtered,
        selected, allSelected, sortKey,
        loadList, goToInvoice, statusChipCls, statusLabel, pillCountCls,
        toggleRow, toggleAll, sortBy, sortArrow, isOverdue,
        fmt, fmtDate, flt, icon
      };
    },
    template: `
<div class="zb-root no-sidebar-pad" style="background:#fff;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <InvoiceModal :show="showNew" @close="showNew=false" @saved="loadList"/>

  <!-- ── TOOLBAR: "All Invoices ▼"  ···  [+ New ▼] [···] ── -->
  <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:#fff;border-bottom:1px solid #e8ecf0">
    <div style="display:flex;align-items:center;gap:6px;cursor:pointer">
      <span style="font-size:15px;font-weight:700;color:#1a1d23;letter-spacing:-.01em">All Invoices</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div style="display:flex;align-items:center;gap:0">
      <!-- Split "New" button — primary part + dropdown arrow -->
      <button @click="showNew=true" style="display:inline-flex;align-items:center;gap:6px;background:#2563EB;color:#fff;border:none;border-radius:6px 0 0 6px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;height:34px;font-family:inherit">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New
      </button>
      <button style="display:inline-flex;align-items:center;background:#2563EB;color:#fff;border:none;border-left:1px solid rgba(255,255,255,.3);border-radius:0 6px 6px 0;padding:0 9px;cursor:pointer;height:34px;font-size:11px">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <!-- Refresh icon -->
      <button @click="loadList" title="Refresh" style="background:none;border:none;cursor:pointer;color:#6b7280;padding:5px 8px;margin-left:6px;border-radius:5px;display:inline-flex;align-items:center">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      </button>
      <!-- Three-dot menu -->
      <button style="background:none;border:none;cursor:pointer;color:#6b7280;padding:5px 8px;border-radius:5px;display:inline-flex;align-items:center">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
      </button>
    </div>
  </div>

  <!-- ── FILTER TABS: All Invoices | Draft 5 | Unpaid 4 | Overdue 10 | Paid 1 ── -->
  <div style="display:flex;align-items:center;gap:4px;padding:0 20px;border-bottom:1px solid #e8ecf0;background:#fff;overflow-x:auto">
    <button v-for="f in filters" :key="f.k"
      @click="active=f.k"
      :style="{
        display:'inline-flex',alignItems:'center',gap:'6px',
        padding:'10px 14px',background:'none',border:'none',
        borderBottom: active===f.k ? '2px solid #2563EB' : '2px solid transparent',
        color: active===f.k ? '#2563EB' : '#5f6368',
        fontSize:'13px',fontWeight: active===f.k ? '600':'500',
        cursor:'pointer',whiteSpace:'nowrap',fontFamily:'inherit',
        marginBottom:'-1px',transition:'color .15s'
      }">
      {{f.lbl}}
      <span v-if="f.k!=='all'" :style="{
        display:'inline-flex',alignItems:'center',justifyContent:'center',
        minWidth:'18px',height:'18px',padding:'0 5px',
        borderRadius:'10px',fontSize:'11px',fontWeight:'700',
        background: active===f.k
          ? (f.k==='Overdue'?'#fee2e2':f.k==='Paid'?'#d1fae5':f.k==='Unpaid'?'#fef3c7':'#e5e7eb')
          : '#f1f3f5',
        color: active===f.k
          ? (f.k==='Overdue'?'#dc2626':f.k==='Paid'?'#059669':f.k==='Unpaid'?'#d97706':'#6b7280')
          : '#6b7280'
      }">{{counts[f.k]}}</span>
    </button>
  </div>

  <!-- ── TABLE ── -->
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13.5px">
      <thead>
        <tr style="background:#fff">
          <!-- filter icon + checkbox column -->
          <th style="width:20px;padding:10px 4px 10px 16px;border-bottom:1px solid #e8ecf0;text-align:left;vertical-align:middle">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" style="display:block"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
          </th>
          <th style="width:36px;padding:10px 8px;border-bottom:1px solid #e8ecf0;text-align:left;vertical-align:middle">
            <input type="checkbox" :checked="allSelected" @change="toggleAll" style="width:14px;height:14px;cursor:pointer"/>
          </th>
          <th @click="sortBy('posting_date')" style="padding:10px 16px;border-bottom:1px solid #e8ecf0;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#5f6368;text-align:left;white-space:nowrap;cursor:pointer;user-select:none">
            DATE<span style="color:#2563EB;margin-left:3px">{{sortArrow('posting_date')||'↓'}}</span>
          </th>
          <th @click="sortBy('name')" style="padding:10px 16px;border-bottom:1px solid #e8ecf0;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#5f6368;text-align:left;white-space:nowrap;cursor:pointer;user-select:none">INVOICE#{{sortArrow('name')}}</th>
          <th style="padding:10px 16px;border-bottom:1px solid #e8ecf0;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#5f6368;text-align:left;white-space:nowrap">ORDER NUMBER</th>
          <th @click="sortBy('customer_name')" style="padding:10px 16px;border-bottom:1px solid #e8ecf0;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#5f6368;text-align:left;white-space:nowrap;cursor:pointer;user-select:none">CUSTOMER NAME{{sortArrow('customer_name')}}</th>
          <th @click="sortBy('status')" style="padding:10px 16px;border-bottom:1px solid #e8ecf0;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#5f6368;text-align:left;white-space:nowrap;cursor:pointer;user-select:none">STATUS{{sortArrow('status')}}</th>
          <th @click="sortBy('due_date')" style="padding:10px 16px;border-bottom:1px solid #e8ecf0;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#5f6368;text-align:left;white-space:nowrap;cursor:pointer;user-select:none">DUE DATE{{sortArrow('due_date')}}</th>
          <th @click="sortBy('grand_total')" style="padding:10px 16px;border-bottom:1px solid #e8ecf0;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#5f6368;text-align:right;white-space:nowrap;cursor:pointer;user-select:none">AMOUNT{{sortArrow('grand_total')}}</th>
          <th @click="sortBy('outstanding_amount')" style="padding:10px 16px;border-bottom:1px solid #e8ecf0;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#5f6368;text-align:right;white-space:nowrap;cursor:pointer;user-select:none">BALANCE DUE{{sortArrow('outstanding_amount')}}</th>
        </tr>
      </thead>
      <tbody>
        <!-- shimmer -->
        <template v-if="loading">
          <tr v-for="n in 6" :key="n">
            <td colspan="10" style="padding:13px 16px;border-bottom:1px solid #f3f4f6"><div class="b-shimmer" style="height:12px;border-radius:3px"></div></td>
          </tr>
        </template>
        <template v-else>
          <tr v-if="!filtered.length">
            <td colspan="10" style="padding:60px 0;text-align:center;color:#9ca3af;font-size:13.5px;border-bottom:1px solid #f3f4f6">No invoices found</td>
          </tr>
          <tr v-else v-for="row in filtered" :key="row.name"
            style="cursor:pointer;transition:background .1s"
            :style="{background: selected.has(row.name) ? '#eff6ff' : ''}"
            @mouseenter="e=>{ if(!selected.has(row.name)) e.currentTarget.style.background='#f9fafb' }"
            @mouseleave="e=>{ e.currentTarget.style.background=selected.has(row.name)?'#eff6ff':'' }"
            @click="goToInvoice(row.name)">
            <!-- filter icon placeholder -->
            <td style="padding:12px 4px 12px 16px;border-bottom:1px solid #f3f4f6;vertical-align:middle;width:20px"></td>
            <!-- checkbox -->
            <td style="padding:12px 8px;border-bottom:1px solid #f3f4f6;vertical-align:middle;width:36px" @click.stop>
              <input type="checkbox" :checked="selected.has(row.name)" @change="toggleRow(row.name)" style="width:14px;height:14px;cursor:pointer"/>
            </td>
            <!-- DATE -->
            <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;color:#1a1d23;vertical-align:middle;white-space:nowrap">{{fmtDate(row.posting_date)}}</td>
            <!-- INVOICE# with optional email icon -->
            <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;vertical-align:middle;white-space:nowrap">
              <span style="color:#2563EB;font-weight:500">{{row.name}}</span>
              <span v-if="row.status==='Submitted'||row.status==='Paid'" style="display:inline-flex;align-items:center;margin-left:5px;color:#9ca3af" title="Email sent">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
              </span>
            </td>
            <!-- ORDER NUMBER -->
            <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;color:#1a1d23;vertical-align:middle">{{row.invoice_number||''}}</td>
            <!-- CUSTOMER NAME -->
            <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;color:#1a1d23;vertical-align:middle">{{row.customer_name||row.customer}}</td>
            <!-- STATUS -->
            <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;vertical-align:middle;white-space:nowrap">
              <span :style="{
                fontSize:'12.5px', fontWeight:'600',
                color: isOverdue(row) ? '#e67e00'
                     : row.status==='Paid' ? '#059669'
                     : row.status==='Draft' ? '#9ca3af'
                     : '#d97706'
              }">{{statusLabel(row)}}</span>
            </td>
            <!-- DUE DATE -->
            <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;vertical-align:middle;white-space:nowrap"
              :style="{color: flt(row.outstanding_amount)>0&&row.due_date&&new Date(row.due_date)<new Date() ? '#e03131' : '#1a1d23'}">
              {{fmtDate(row.due_date)}}
            </td>
            <!-- AMOUNT -->
            <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;text-align:right;color:#1a1d23;font-size:13.5px;vertical-align:middle;white-space:nowrap">{{fmt(row.grand_total)}}</td>
            <!-- BALANCE DUE -->
            <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;text-align:right;font-size:13.5px;vertical-align:middle;white-space:nowrap"
              :style="{color: flt(row.outstanding_amount)>0 ? '#1a1d23' : '#059669'}">
              {{fmt(row.outstanding_amount)}}
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</div>
`});

  // ══ INVOICE DETAIL PAGE ═══════════════════════════════════════════
  const InvoiceDetail = defineComponent({
    name: "InvoiceDetail",
    components: { SendEmailModal, PaymentModal },
    setup() {
      const route = useRoute();
      const router = useRouter();
      const invName = computed(() => route.params.name);
      const showSendEmail = ref(false);
      const showSendMenu = ref(false);

      // ── List (sidebar) ──────────────────────────────────────────
      const list = ref([]), listLoading = ref(true), active = ref("all"), search = ref("");
      const filters = [
        { k: "all", lbl: "All Invoices" },
        { k: "Draft", lbl: "Draft" },
        { k: "Submitted", lbl: "Unpaid" },
        { k: "Overdue", lbl: "Overdue" },
        { k: "Paid", lbl: "Paid" }
      ];
      const counts = computed(() => ({
        Draft: list.value.filter(i => i.status === "Draft").length,
        Submitted: list.value.filter(i => ["Submitted", "Partly Paid"].includes(i.status)).length,
        Overdue: list.value.filter(isOverdue).length,
        Paid: list.value.filter(i => i.status === "Paid").length,
      }));
      const filtered = computed(() => {
        let r = list.value;
        if (active.value === "Overdue") r = r.filter(isOverdue);
        else if (active.value !== "all") r = r.filter(i => i.status === active.value);
        if (search.value) r = r.filter(i => (i.name + (i.customer || "")).toLowerCase().includes(search.value.toLowerCase()));
        return r;
      });
      async function loadList() {
        listLoading.value = true;
        try { list.value = await apiList("Sales Invoice", { fields: ["name", "customer", "customer_name", "posting_date", "due_date", "grand_total", "outstanding_amount", "status"], order: "posting_date desc" }); }
        catch (e) { toast("Failed to load invoices", "error"); }
        finally { listLoading.value = false; }
      }
      function pillBadge(k) {
        return { Draft: "zb-list-draft", Submitted: "zb-list-unpaid", Overdue: "zb-list-overdue", "Partly Paid": "zb-list-partpaid", Paid: "zb-list-paid" }[k] || "zb-list-draft";
      }
      function goInvoice(name) { router.push({ name: "invoice-detail", params: { name } }); }

      // ── Detail ──────────────────────────────────────────────────
      const inv = ref(null), detailLoading = ref(false), detailError = ref(null);
      const editing = ref(false), saving = ref(false), submitting = ref(false);
      const customers = ref([]), accounts_ar = ref([]), accounts_income = ref([]);
      const form = reactive({
        customer: "", posting_date: "", due_date: "", debit_to: "", income_account: "",
        currency: "INR", notes: "", company: "",
        items: [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
        taxes: []
      });

      async function loadDetail(name) {
        if (!name) return;
        detailLoading.value = true; detailError.value = null; editing.value = false;
        try { inv.value = await apiGet("Sales Invoice", name); }
        catch (e) { detailError.value = e.message; }
        finally { detailLoading.value = false; }
      }

      watch(invName, n => { if (n) loadDetail(n); }, { immediate: true });
      onMounted(() => { loadList(); });

      async function loadFormDefaults() {
        try { customers.value = await apiList("Customer", { fields: ["name"], limit: 100, order: "name asc" }); } catch { }
        try { const ar = await apiList("Account", { fields: ["name"], filters: [["account_type", "=", "Receivable"], ["is_group", "=", 0]], limit: 50 }); accounts_ar.value = ar; } catch { }
        try { const inc = await apiList("Account", { fields: ["name"], filters: [["account_type", "in", ["Income Account", "Income"]], ["is_group", "=", 0]], limit: 50 }); accounts_income.value = inc; } catch { }
      }
      function startEdit() {
        if (!inv.value) return;
        Object.assign(form, {
          customer: inv.value.customer || "", posting_date: inv.value.posting_date || "",
          due_date: inv.value.due_date || "", debit_to: inv.value.debit_to || "",
          income_account: inv.value.income_account || "", currency: inv.value.currency || "INR",
          notes: inv.value.notes || "", company: inv.value.company || "",
          items: (inv.value.items || []).map(i => ({ ...i })),
          taxes: (inv.value.taxes || []).map(t => ({ ...t })),
        });
        if (!form.items.length) form.items = [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }];
        loadFormDefaults();
        editing.value = true;
      }
      function recalc() {
        form.items.forEach(i => { i.amount = Math.round(flt(i.qty) * flt(i.rate) * 100) / 100; });
        const net = form.items.reduce((s, i) => s + flt(i.amount), 0);
        form.taxes.forEach(t => { t.tax_amount = flt(t.rate) > 0 ? Math.round(net * flt(t.rate) / 100 * 100) / 100 : 0; });
      }
      function addItem() { form.items.push({ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }); }
      function removeItem(i) { if (form.items.length > 1) form.items.splice(i, 1); recalc(); }
      function addTax() { form.taxes.push({ tax_type: "SGST", description: "SGST", rate: 9, tax_amount: 0 }); }
      function removeTax(i) { form.taxes.splice(i, 1); recalc(); }
      const netTotal = computed(() => form.items.reduce((s, i) => s + flt(i.amount), 0));
      const totalTax = computed(() => form.taxes.reduce((s, t) => s + flt(t.tax_amount), 0));
      const grandTotal = computed(() => netTotal.value + totalTax.value);

      async function saveEdit() {
        saving.value = true;
        try {
          recalc();
          const doc = {
            doctype: "Sales Invoice", name: inv.value.name,
            customer: form.customer, posting_date: form.posting_date, due_date: form.due_date,
            debit_to: form.debit_to, income_account: form.income_account,
            currency: form.currency, notes: form.notes, company: form.company,
            items: form.items.filter(i => i.item_name || flt(i.rate)).map((i, idx) => ({
              doctype: "Sales Invoice Item", idx: idx + 1,
              item_name: i.item_name, description: i.description,
              qty: flt(i.qty) || 1, rate: flt(i.rate), amount: flt(i.amount),
            })),
            taxes: form.taxes.map(t => ({
              doctype: "Tax Line", tax_type: t.tax_type, description: t.description || t.tax_type,
              rate: flt(t.rate), tax_amount: flt(t.tax_amount),
            })),
          };
          const saved = await apiGET("zoho_books_clone.api.docs.save_doc", { doc: JSON.stringify(doc) });
          inv.value = saved;
          const idx = list.value.findIndex(i => i.name === saved.name);
          if (idx > -1) Object.assign(list.value[idx], { grand_total: saved.grand_total, outstanding_amount: saved.outstanding_amount, status: saved.status, posting_date: saved.posting_date, due_date: saved.due_date });
          editing.value = false;
          toast("Invoice saved!", "success");
        } catch (e) { toast("Save failed: " + e.message, "error"); }
        finally { saving.value = false; }
      }
      async function submitInvoice() {
        if (!confirm("Submit this invoice? This cannot be undone.")) return;
        submitting.value = true;
        try {
          await apiSubmit("Sales Invoice", inv.value.name);
          toast("Invoice submitted!", "success");
          await loadDetail(inv.value.name);
          await loadList();
        } catch (e) { toast("Submit failed: " + e.message, "error"); }
        finally { submitting.value = false; }
      }
      function printPdf() { window.print(); }
      function toAmountWords(n) {
        const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
        const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
        function w(n) { if (!n) return ""; if (n < 20) return a[n] + " "; if (n < 100) return b[Math.floor(n / 10)] + " " + (n % 10 ? a[n % 10] + " " : ""); if (n < 1000) return a[Math.floor(n / 100)] + " Hundred " + (n % 100 ? w(n % 100) : ""); if (n < 100000) return w(Math.floor(n / 1000)) + "Thousand " + (n % 1000 ? w(n % 1000) : ""); if (n < 10000000) return w(Math.floor(n / 100000)) + "Lakh " + (n % 100000 ? w(n % 100000) : ""); return w(Math.floor(n / 10000000)) + "Crore " + (n % 10000000 ? w(n % 10000000) : ""); }
        const r = Math.floor(n), p = Math.round((n - r) * 100);
        return "Indian Rupee " + w(r).trim() + (p ? " and " + w(p).trim() + " Paise" : "") + " Only";
      }
      const statusBadgeCls = computed(() => {
        const s = inv.value?.status;
        if (s === "Paid") return "b-badge-green";
        if (s === "Submitted" || s === "Partly Paid") return "b-badge-blue";
        if (s === "Overdue") return "b-badge-red";
        if (s === "Cancelled") return "b-badge-muted";
        return "b-badge-amber";
      });
      const isDraft = computed(() => !inv.value || String(inv.value.docstatus) === "0" || inv.value.status === "Draft");
      const paidAmt = computed(() => Math.max(0, flt(inv.value?.grand_total) - flt(inv.value?.outstanding_amount)));
      const paidPct = computed(() => { const g = flt(inv.value?.grand_total); return g ? Math.min(100, Math.round(paidAmt.value / g * 100)) : 0; });
      const showCustMenu = ref(false);
      const showRecPay = ref(false);
      const recPaySaving = ref(false);
      const recPayAccounts = ref([]);
      const recPay = reactive({
        amount: 0, bank_charges: 0, tax_deducted: "no",
        payment_date: new Date().toISOString().slice(0, 10),
        received_on: "", mode: "Cash", deposit_to: "",
        reference: "", notes: "", ref_no: "", send_thankyou: false
      });

      watch(() => inv.value, (v) => {
        if (v) {
          recPay.amount = flt(v.outstanding_amount) || flt(v.grand_total);
          recPay.ref_no = v.name;
        }
      });

      async function openRecPay() {
        // Load bank/cash accounts fresh each time
        try {
          const accs = await apiList("Account", {
            fields: ["name", "account_type"],
            filters: [["is_group", "=", 0]],
            limit: 100
          });
          // Filter client-side to avoid server-side IN operator issues
          recPayAccounts.value = accs.filter(a => ["Bank", "Cash"].includes(a.account_type));
          if (!recPay.deposit_to && recPayAccounts.value.length) {
            recPay.deposit_to = recPayAccounts.value[0].name;
          }
        } catch (e) {
          recPayAccounts.value = [];
        }
        // Reset amount from current outstanding
        if (inv.value) {
          recPay.amount = flt(inv.value.outstanding_amount) || flt(inv.value.grand_total);
          recPay.ref_no = inv.value.name;
          recPay.payment_date = new Date().toISOString().slice(0, 10);
        }
        showRecPay.value = true;
      }

      async function saveRecPay(submit) {
        if (!recPay.amount || recPay.amount <= 0) { toast("Please enter a valid amount", "error"); return; }
        if (!recPay.deposit_to) { toast("Please select a Deposit To account", "error"); return; }
        recPaySaving.value = true;
        try {
          const result = await apiPOST("zoho_books_clone.api.books_data.record_payment", {
            invoice_name: inv.value?.name,
            amount_received: recPay.amount,
            deposit_to: recPay.deposit_to,
            payment_mode: recPay.mode || "Cash",
            payment_date: recPay.payment_date,
            reference_no: recPay.reference || recPay.ref_no || "",
            notes: recPay.notes || "",
            bank_charges: recPay.bank_charges || 0,
            tds_deducted: recPay.tax_deducted === "yes" ? 1 : 0,
            save_as_draft: submit ? 0 : 1,
          });
          toast("Payment " + (result.payment_entry || result.name) + " " + (submit ? "recorded!" : "saved as draft!"));
          showRecPay.value = false;
          await loadDetail(invName.value);
          loadList();
        } catch (e) {
          const msg = e?.message || String(e) || "Could not save payment";
          toast(msg, "error");
        }
        finally { recPaySaving.value = false; }
      }

      return {
        list, listLoading, active, search, filters, counts, filtered, pillBadge, goInvoice, invName,
        inv, detailLoading, detailError, editing, saving, submitting, showSendEmail, showSendMenu, showCustMenu, showRecPay, recPay, recPaySaving, recPayAccounts, saveRecPay, openRecPay,
        form, customers, accounts_ar, accounts_income,
        statusBadgeCls, isDraft, paidAmt, paidPct, netTotal, totalTax, grandTotal,
        startEdit, saveEdit, submitInvoice, printPdf,
        addItem, removeItem, addTax, removeTax, recalc, toAmountWords,
        fmt, fmtDate, flt, icon, openDoc
      };
    },
    template: `
<div class="zb-master-detail no-sidebar-pad">

  <!-- ══ LEFT: INVOICE SIDEBAR LIST ══ -->
  <div class="zb-list-pane no-print">
    <div class="zb-list-header">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:13px;font-weight:700;color:#111827">All Invoices</span>
          <span style="font-size:11px;color:#9ca3af">▾</span>
        </div>
        <div style="display:flex;gap:4px">
          <button class="zb-icon-btn" @click="$router.push('/invoices')" title="Back to list">
            <span v-html="icon('arrow-left',13)"></span>
          </button>
          <button class="zb-icon-btn" @click="()=>{}" title="New Invoice">
            <span v-html="icon('plus',13)"></span>
          </button>
        </div>
      </div>
      <div class="zb-list-search">
        <span v-html="icon('search',12)" style="color:#9ca3af;flex-shrink:0"></span>
        <input v-model="search" placeholder="Search invoices…" class="zb-list-search-input"/>
      </div>
      <div class="zb-list-pills">
        <button v-for="f in filters" :key="f.k"
          class="zb-list-pill" :class="{active:active===f.k}"
          @click="active=f.k">
          {{f.lbl}}
          <span v-if="f.k!=='all'" class="zb-pill-count">{{counts[f.k]}}</span>
        </button>
      </div>
    </div>
    <div class="zb-list-items">
      <template v-if="listLoading">
        <div v-for="n in 6" :key="n" class="zb-list-item-shimmer">
          <div class="b-shimmer" style="width:70%;height:13px;border-radius:3px;margin-bottom:6px"></div>
          <div class="b-shimmer" style="width:50%;height:11px;border-radius:3px;margin-bottom:4px"></div>
          <div class="b-shimmer" style="width:35%;height:10px;border-radius:3px"></div>
        </div>
      </template>
      <div v-else-if="!filtered.length" class="zb-list-empty">
        <div style="font-size:13px;color:var(--text-3)">No invoices found</div>
      </div>
      <div v-else
        v-for="row in filtered" :key="row.name"
        class="zb-list-item"
        :class="{selected:invName===row.name}"
        @click="goInvoice(row.name)">
        <div class="zb-list-item-top">
          <span class="zb-list-item-name">{{row.customer_name||row.customer}}</span>
          <span class="zb-list-item-amount">{{fmt(row.grand_total)}}</span>
        </div>
        <div class="zb-list-item-mid">
          <span class="zb-list-item-num">{{row.name}}</span>
          <span class="zb-list-item-dot">•</span>
          <span class="zb-list-item-date">{{fmtDate(row.posting_date)}}</span>
        </div>
        <div class="zb-list-item-bot">
          <span class="zb-list-status-tag" :class="pillBadge(row.status)">{{row.status||'Draft'}}</span>
          <span v-if="flt(row.outstanding_amount)>0&&row.due_date&&new Date(row.due_date)<=new Date()"
            style="font-size:10px;color:#e03131;font-weight:600;margin-left:4px">OVERDUE</span>
          <span style="margin-left:auto;font-size:11px;color:#888">{{fmt(row.outstanding_amount)}}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- ══ RIGHT: DETAIL AREA ══ -->
  <div class="zb-detail-area">

    <template v-if="showRecPay">
      <div style="display:flex;flex-direction:column;min-height:100%;flex:1;background:#fff;overflow:hidden">
        <!-- Header -->
        <div style="padding:16px 24px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;background:#fff;position:sticky;top:0;z-index:10">
          <h2 style="font-size:17px;font-weight:700;color:#111;margin:0">Payment for {{invName}}</h2>
          <button @click="showRecPay=false" style="background:none;border:none;cursor:pointer;font-size:22px;color:#6b7280;line-height:1">✕</button>
        </div>

        <!-- Body -->
        <div style="flex:1;padding:24px;display:grid;grid-template-columns:1fr 280px;gap:24px;overflow-y:auto;background:#fff">
          <!-- Left form -->
          <div>
            <!-- Row 1: Customer + Payment # -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#dc2626;margin-bottom:6px">Customer Name*</label>
                <input :value="inv?.customer_name||inv?.customer" readonly style="width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:#f9fafb"/>
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Payment #*</label>
                <div style="position:relative">
                  <input v-model="recPay.ref_no" style="width:100%;padding:8px 36px 8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"/>
                  <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);color:#6b7280">⚙</span>
                </div>
              </div>
            </div>

            <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 20px"/>

            <!-- Row 2: Amount + Bank Charges -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:6px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#dc2626;margin-bottom:6px">Amount Received (INR)*</label>
                <input v-model.number="recPay.amount" type="number" min="0" step="0.01" style="width:100%;padding:8px 12px;border:2px solid #2563EB;border-radius:6px;font-size:13px;font-weight:600"/>
                <div style="font-size:11px;color:#2563EB;margin-top:4px;cursor:pointer">PAN: <span style="text-decoration:underline">Add PAN</span></div>
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Bank Charges (if any)</label>
                <input v-model.number="recPay.bank_charges" type="number" min="0" step="0.01" style="width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"/>
              </div>
            </div>

            <!-- Tax deducted -->
            <div style="margin-bottom:20px;padding:12px 0;border-bottom:1px solid #e5e7eb">
              <span style="font-size:12.5px;color:#374151;margin-right:16px">Tax deducted?</span>
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;margin-right:16px">
                <input type="radio" v-model="recPay.tax_deducted" value="no"> No Tax deducted
              </label>
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer">
                <input type="radio" v-model="recPay.tax_deducted" value="yes"> Yes, TDS (Income Tax)
              </label>
            </div>

            <!-- Row 3: Payment Date + Payment Mode -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#dc2626;margin-bottom:6px">Payment Date*</label>
                <input v-model="recPay.payment_date" type="date" style="width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"/>
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Payment Mode</label>
                <select v-model="recPay.mode" style="width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:#fff">
                  <option>Cash</option><option>Bank Transfer</option><option>UPI</option><option>NEFT</option><option>RTGS</option><option>Cheque</option><option>Credit Card</option><option>Debit Card</option>
                </select>
              </div>
            </div>

            <!-- Row 4: Payment Received On + Deposit To -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Payment Received On</label>
                <input v-model="recPay.received_on" type="date" placeholder="dd/MM/yyyy" style="width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"/>
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#dc2626;margin-bottom:6px">Deposit To*</label>
                <select v-model="recPay.deposit_to" style="width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:#fff">
                  <option value="">— Select Account —</option>
                  <option v-for="a in recPayAccounts" :key="a.name" :value="a.name">{{a.name}}</option>
                </select>
              </div>
            </div>

            <!-- Row 5: Reference# + Notes -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Reference#</label>
                <input v-model="recPay.reference" style="width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"/>
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Notes</label>
                <textarea v-model="recPay.notes" rows="3" style="width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;resize:vertical"></textarea>
              </div>
            </div>

            <!-- Attachments -->
            <div style="border-top:1px solid #e5e7eb;padding-top:20px;margin-bottom:20px">
              <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:10px">Attachments</div>
              <button style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font-size:12.5px;cursor:pointer;color:#374151">
                ⬆ Upload File ▾
              </button>
              <div style="font-size:11px;color:#9ca3af;margin-top:6px">You can upload a maximum of 5 files, 5MB each</div>
            </div>

            <!-- Thank you note -->
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;color:#374151">
              <input type="checkbox" v-model="recPay.send_thankyou" style="width:14px;height:14px">
              Send a "Thank you" note for this payment
            </label>
          </div>

          <!-- Right sidebar: Customer details -->
          <div>
            <div style="background:#1e3a5f;border-radius:8px;overflow:hidden">
              <div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;cursor:pointer">
                <span style="color:#fff;font-size:13px;font-weight:600">{{inv?.customer_name||inv?.customer}}'s Details</span>
                <span style="color:#fff;font-size:16px">›</span>
              </div>
            </div>
            <div style="margin-top:16px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:16px">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#9ca3af;margin-bottom:10px">Invoice Summary</div>
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e5e7eb;font-size:13px">
                <span style="color:#6b7280">Invoice #</span>
                <span style="font-weight:600;color:#2563EB">{{invName}}</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e5e7eb;font-size:13px">
                <span style="color:#6b7280">Grand Total</span>
                <span style="font-weight:600">{{fmt(inv?.grand_total)}}</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e5e7eb;font-size:13px">
                <span style="color:#6b7280">Paid</span>
                <span style="font-weight:600;color:#16a34a">{{fmt(paidAmt)}}</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px">
                <span style="color:#6b7280">Balance Due</span>
                <span style="font-weight:700;color:#dc2626">{{fmt(inv?.outstanding_amount)}}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer buttons -->
        <div style="padding:16px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;display:flex;align-items:center;gap:12px;position:sticky;bottom:0;z-index:10">
          <button @click="saveRecPay(false)" :disabled="recPaySaving" style="padding:9px 22px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font-size:13px;font-weight:600;cursor:pointer;color:#374151;font-family:inherit">
            {{recPaySaving?'Saving…':'Save as Draft'}}
          </button>
          <button @click="saveRecPay(true)" :disabled="recPaySaving" style="padding:9px 22px;border:none;border-radius:6px;background:#2563EB;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">
            {{recPaySaving?'Saving…':'Save as Paid'}}
          </button>
          <button @click="showRecPay=false" style="padding:9px 22px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font-size:13px;font-weight:500;cursor:pointer;color:#6b7280;font-family:inherit">Cancel</button>
        </div>
      </div>
    </template>
    
    <template v-else>
      <div style="display:flex;flex-direction:column;flex:1;overflow:hidden">
        <!-- Action bar -->
        <div class="zb-actionbar no-print" v-if="inv&&!detailLoading">
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        <span style="font-size:14px;font-weight:700;color:#1a1d23">{{inv.name}}</span>
        <span class="b-badge" :class="statusBadgeCls" style="font-size:11px">
          {{inv.status==='Submitted'?'Sent':inv.status||'Draft'}}
        </span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        <template v-if="editing">
          <button class="zb-ab-btn" @click="editing=false">Cancel</button>
          <button class="zb-ab-btn zb-ab-primary" @click="saveEdit" :disabled="saving">
            <span v-if="saving" v-html="icon('refresh',12)" style="animation:spin 1s linear infinite"></span>
            {{saving?'Saving…':'Save'}}
          </button>
        </template>
        <template v-else>
          <button class="zb-ab-btn" @click="startEdit"><span v-html="icon('edit',12)"></span> Edit</button>
          <div class="sem-send-dropdown" style="position:relative;display:inline-block">
            <button class="zb-ab-btn sem-send-toggle" @click="showSendMenu=!showSendMenu">
              <span v-html="icon('send',12)"></span> Send ▾
            </button>
            <div v-if="showSendMenu" class="sem-dropdown-menu" @mouseleave="showSendMenu=false">
              <button class="sem-dropdown-item" @click="showSendEmail=true;showSendMenu=false">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                Email
              </button>
              <button class="sem-dropdown-item" @click="showSendMenu=false;toast('SMS feature coming soon','info')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.73 19.79 19.79 0 0 1 1.64 5.11 2 2 0 0 1 3.61 3h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 10.9a16 16 0 0 0 6 6l.98-.98a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 18.18"/></svg>
                SMS
              </button>
            </div>
          </div>
          <button class="zb-ab-btn" @click="()=>{}"><span v-html="icon('share',12)"></span> Share</button>
          <button class="zb-ab-btn" @click="printPdf"><span v-html="icon('print',12)"></span> PDF/Print ▾</button>
          <button v-if="!isDraft" class="zb-ab-btn zb-ab-primary" @click="openRecPay()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
            Record Payment ▾
          </button>
          <button v-if="isDraft" class="zb-ab-btn zb-ab-primary" @click="submitInvoice" :disabled="submitting">
            <span v-if="submitting" v-html="icon('refresh',12)" style="animation:spin 1s linear infinite"></span>
            {{submitting?'Submitting…':'Submit'}}
          </button>
          <button class="zb-ab-btn zb-ab-dots" @click="$router.push('/invoices')" title="Close">✕</button>
        </template>
      </div>
    </div>

    <!-- What's Next banners -->
    <div class="zb-banner no-print" v-if="inv&&!isDraft&&!editing">
      <span style="color:#f59e0b;font-size:15px">✦</span>
      <span style="flex:1;font-size:12px"><b>WHAT'S NEXT?</b> Invoice has been sent. Record payment for it as soon as you receive payment. <a href="#" style="color:#2563EB;font-weight:600;text-decoration:none">Learn More</a></span>
      <button class="zb-ab-btn zb-ab-primary" style="font-size:11px;padding:5px 14px;flex-shrink:0" @click="openRecPay()">Record Payment</button>
    </div>
    <div class="zb-banner zb-banner-upi no-print" v-if="inv&&!isDraft&&!editing">
      <span style="font-size:12px;color:#444">🖥 Get paid faster by <a href="#" style="color:#2563EB;text-decoration:none">setting up payment gateways</a> or <a href="#" style="color:#2563EB;text-decoration:none">display a UPI QR code</a>.</span>
    </div>
    <div class="zb-banner no-print" v-if="inv&&isDraft&&!editing">
      <span style="color:#f59e0b;font-size:15px">✦</span>
      <span style="flex:1;font-size:12px"><b>WHAT'S NEXT?</b> Submit this invoice to lock it, then record a payment when collected.</span>
      <button class="zb-ab-btn zb-ab-primary" style="font-size:11px;padding:5px 14px;flex-shrink:0" @click="submitInvoice">Submit Invoice</button>
    </div>

    <!-- Loading shimmer -->
    <div v-if="detailLoading" style="flex:1;display:flex;align-items:center;justify-content:center">
      <div style="text-align:center">
        <div class="b-shimmer" style="width:200px;height:14px;border-radius:4px;margin:0 auto 10px"></div>
        <div class="b-shimmer" style="width:130px;height:11px;border-radius:4px;margin:0 auto"></div>
      </div>
    </div>
    <div v-else-if="detailError" style="flex:1;display:flex;align-items:center;justify-content:center;color:#e03131;font-size:13px">
      Error loading invoice: {{detailError}}
    </div>

    <div v-else-if="inv" style="display:flex;flex:1;overflow:hidden">

      <!-- PDF view or Edit form -->
      <div class="zb-pdf-wrap" v-if="!editing">

        <!-- Sticky toolbar row with Customize button -->
        <div style="width:100%;max-width:660px;display:flex;justify-content:flex-end;margin-bottom:10px;position:sticky;top:0;z-index:50">
          <div @mouseleave="showCustMenu=false" style="position:relative">
            <button @click="showCustMenu=!showCustMenu"
              style="display:inline-flex;align-items:center;gap:6px;padding:7px 16px;background:#2563EB;color:#fff;border:none;border-radius:6px;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(37,99,235,.35)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 1.41 14.14M4.93 19.07A10 10 0 0 1 3.52 4.93"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2"/></svg>
              Customize ▾
            </button>
            <div v-if="showCustMenu"
              style="position:absolute;right:0;top:calc(100% + 6px);background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.13);min-width:210px;overflow:hidden;z-index:200">
              <div style="padding:4px 0">
                <button @click="showCustMenu=false" class="zb-cust-menu-item">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                  Standard Template
                </button>
                <button @click="showCustMenu=false" class="zb-cust-menu-item">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m10 0h3a2 2 0 0 0 2-2v-3"/></svg>
                  Change Template
                </button>
                <div style="height:1px;background:#f3f4f6;margin:4px 0"></div>
                <button @click="showCustMenu=false;$router.push('/template-editor')" class="zb-cust-menu-item" style="color:#2563EB;font-weight:600">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  Edit Template
                </button>
                <div style="height:1px;background:#f3f4f6;margin:4px 0"></div>
                <button @click="showCustMenu=false" class="zb-cust-menu-item">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                  Update Logo &amp; Address
                </button>
                <button @click="showCustMenu=false" class="zb-cust-menu-item">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  Manage Custom Fields
                </button>
                <button @click="showCustMenu=false" class="zb-cust-menu-item">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  Terms &amp; Conditions
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="zb-pdf-paper">
          <div class="zb-sent-ribbon" v-if="!isDraft">Sent</div>
          <div class="zb-draft-ribbon" v-else>Draft</div>
          <div class="zb-pdf-head">
            <div>
              <div class="zb-pdf-co-name">{{inv.company||'Your Company'}}</div>
              <div class="zb-pdf-co-meta" v-if="inv.company_address">{{inv.company_address}}</div>
              <div class="zb-pdf-co-meta" v-if="inv.company_email">{{inv.company_email}}</div>
            </div>
            <div class="zb-pdf-inv-title">TAX INVOICE</div>
          </div>
          <table class="zb-pdf-info-table">
            <thead><tr><th>#</th><th>Invoice Date</th><th>Terms</th><th>Due Date</th><th>P.O.#</th></tr></thead>
            <tbody><tr>
              <td>{{inv.name}}</td>
              <td>{{fmtDate(inv.posting_date)}}</td>
              <td>{{inv.payment_terms||'Due on Receipt'}}</td>
              <td :style="{color:flt(inv.outstanding_amount)>0&&inv.due_date&&new Date(inv.due_date)<new Date()?'#e03131':'inherit'}">{{fmtDate(inv.due_date)}}</td>
              <td>{{inv.invoice_number||'—'}}</td>
            </tr></tbody>
          </table>
          <div class="zb-pdf-bill-section">
            <div class="zb-pdf-bill-label">Bill To</div>
            <div class="zb-pdf-bill-name">{{inv.customer_name||inv.customer}}</div>
          </div>
          <table class="zb-pdf-items">
            <thead><tr>
              <th class="zb-pdf-th" style="width:5%;text-align:center">#</th>
              <th class="zb-pdf-th">Item &amp; Description</th>
              <th class="zb-pdf-th" style="text-align:right">Qty</th>
              <th class="zb-pdf-th" style="text-align:right">Rate</th>
              <th class="zb-pdf-th" style="text-align:right">Amount</th>
            </tr></thead>
            <tbody>
              <tr v-for="(item,i) in (inv.items||[])" :key="i" class="zb-pdf-item-row">
                <td class="zb-pdf-td" style="text-align:center;color:#aaa;font-size:12px">{{i+1}}</td>
                <td class="zb-pdf-td">
                  <div style="font-weight:600;color:#1a1d23">{{item.item_name||item.item_code}}</div>
                  <div v-if="item.description&&item.description!==item.item_name" style="font-size:11px;color:#888;margin-top:1px">{{item.description}}</div>
                </td>
                <td class="zb-pdf-td" style="text-align:right;font-family:monospace">{{flt(item.qty).toFixed(2)}}<div style="font-size:10px;color:#aaa">{{item.uom||'pcs'}}</div></td>
                <td class="zb-pdf-td" style="text-align:right;font-family:monospace">{{fmt(item.rate)}}</td>
                <td class="zb-pdf-td" style="text-align:right;font-family:monospace;font-weight:600">{{fmt(item.amount)}}</td>
              </tr>
            </tbody>
          </table>
          <div class="zb-pdf-bottom">
            <div class="zb-pdf-words-block">
              <div class="zb-pdf-words-lbl">Total In Words</div>
              <div class="zb-pdf-words-val"><i>{{toAmountWords(flt(inv.grand_total))}}</i></div>
              <div v-if="inv.notes" style="margin-top:10px">
                <div class="zb-pdf-words-lbl">Notes</div>
                <div style="font-size:12px;color:#555;margin-top:3px;white-space:pre-wrap">{{inv.notes}}</div>
              </div>
            </div>
            <div class="zb-pdf-totals-block">
              <div class="zb-pdf-total-row"><span>Sub Total</span><span>{{fmt(inv.net_total)}}</span></div>
              <div class="zb-pdf-total-row" v-for="tax in (inv.taxes||[])" :key="tax.tax_type">
                <span>{{tax.tax_type}} ({{flt(tax.rate)}}%)</span><span>{{fmt(tax.tax_amount)}}</span>
              </div>
              <div class="zb-pdf-total-row zb-pdf-total-bold"><span>Total</span><span>{{fmt(inv.grand_total)}}</span></div>
              <div v-if="flt(inv.outstanding_amount)>0" class="zb-pdf-total-row zb-pdf-balance">
                <span>Balance Due</span><span>{{fmt(inv.outstanding_amount)}}</span>
              </div>
              <div v-else class="zb-pdf-total-row" style="color:#2f9e44;font-weight:700;font-size:12px">
                <span>✓ Paid in Full</span><span>{{fmt(inv.grand_total)}}</span>
              </div>
            </div>
          </div>
          <div class="zb-pdf-sig-row"><div></div><div class="zb-pdf-sig-box">Authorized Signature</div></div>
          <div class="zb-pdf-footer" style="display:flex;align-items:center;justify-content:space-between">
            <span>PDF template : <span style="color:#2563EB;font-weight:600">'Tax Invoice'</span></span>
            <button @click="$router.push('/template-editor')" style="display:inline-flex;align-items:center;gap:5px;padding:4px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:5px;color:#2563EB;font-size:11px;font-weight:600;cursor:pointer">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit Template
            </button>
          </div>
        </div>
      </div>

      <!-- Edit form -->
      <div v-else class="zb-edit-wrap no-print">
        <div class="zb-edit-form">
          <div class="zb-form-section-title">Invoice Details</div>
          <div class="zb-form-grid3">
            <div class="zb-form-field"><label class="zb-form-label">Customer *</label>
              <select v-model="form.customer" class="zb-form-input"><option value="">— Select —</option><option v-for="c in customers" :key="c.name" :value="c.name">{{c.name}}</option></select></div>
            <div class="zb-form-field"><label class="zb-form-label">Invoice Date</label>
              <input type="date" v-model="form.posting_date" class="zb-form-input"/></div>
            <div class="zb-form-field"><label class="zb-form-label">Due Date</label>
              <input type="date" v-model="form.due_date" class="zb-form-input"/></div>
            <div class="zb-form-field"><label class="zb-form-label">AR Account</label>
              <select v-model="form.debit_to" class="zb-form-input"><option value="">— Select —</option><option v-for="a in accounts_ar" :key="a.name" :value="a.name">{{a.name}}</option></select></div>
            <div class="zb-form-field"><label class="zb-form-label">Income Account</label>
              <select v-model="form.income_account" class="zb-form-input"><option value="">— Select —</option><option v-for="a in accounts_income" :key="a.name" :value="a.name">{{a.name}}</option></select></div>
            <div class="zb-form-field"><label class="zb-form-label">Currency</label>
              <input v-model="form.currency" class="zb-form-input"/></div>
          </div>
          <div class="zb-form-section-title" style="margin-top:18px">Items</div>
          <table class="zb-items-table">
            <thead><tr><th>#</th><th>Item Name</th><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(item,i) in form.items" :key="i">
                <td style="color:#aaa;font-size:11px;text-align:center;width:28px">{{i+1}}</td>
                <td><input v-model="item.item_name" class="zb-cell-input" placeholder="Item name" @input="recalc"/></td>
                <td><input v-model="item.description" class="zb-cell-input" placeholder="Description"/></td>
                <td><input v-model.number="item.qty" type="number" min="1" class="zb-cell-input zb-cell-num" @input="recalc"/></td>
                <td><input v-model.number="item.rate" type="number" min="0" class="zb-cell-input zb-cell-num" @input="recalc"/></td>
                <td style="text-align:right;font-family:monospace;font-weight:600;padding-right:6px;font-size:13px">{{fmt(item.amount)}}</td>
                <td><button @click="removeItem(i)" style="background:none;border:none;cursor:pointer;color:#e03131;padding:3px" v-html="icon('trash',12)"></button></td>
              </tr>
            </tbody>
          </table>
          <button class="zb-add-row" @click="addItem">+ Add Row</button>
          <div class="zb-form-section-title" style="margin-top:16px">Taxes</div>
          <table class="zb-items-table" v-if="form.taxes.length">
            <thead><tr><th>Type</th><th>Description</th><th style="text-align:right">Rate %</th><th style="text-align:right">Amount</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(tax,i) in form.taxes" :key="i">
                <td><input v-model="tax.tax_type" class="zb-cell-input" placeholder="SGST"/></td>
                <td><input v-model="tax.description" class="zb-cell-input" placeholder="SGST 9%"/></td>
                <td><input v-model.number="tax.rate" type="number" class="zb-cell-input zb-cell-num" @input="recalc"/></td>
                <td style="text-align:right;font-family:monospace;font-weight:600;padding-right:6px;font-size:13px">{{fmt(tax.tax_amount)}}</td>
                <td><button @click="removeTax(i)" style="background:none;border:none;cursor:pointer;color:#e03131;padding:3px" v-html="icon('trash',12)"></button></td>
              </tr>
            </tbody>
          </table>
          <button class="zb-add-row" @click="addTax">+ Add Tax</button>
          <div class="zb-edit-totals">
            <div class="zb-edit-total-row"><span>Net Total</span><span class="mono">{{fmt(netTotal)}}</span></div>
            <div class="zb-edit-total-row"><span>Tax</span><span class="mono">{{fmt(totalTax)}}</span></div>
            <div class="zb-edit-total-row zb-edit-grand"><span>Grand Total</span><span class="mono">{{fmt(grandTotal)}}</span></div>
          </div>
          <div class="zb-form-field" style="margin-top:14px">
            <label class="zb-form-label">Notes</label>
            <textarea v-model="form.notes" class="zb-form-input" rows="3" placeholder="Payment terms, remarks…" style="resize:vertical"></textarea>
          </div>
        </div>
      </div>

      <!-- Right panel -->
      <div class="zb-right-panel no-print">
        <div class="zb-panel-card">
          <div class="zb-panel-title">Payment Status</div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="b-badge" :class="statusBadgeCls" style="font-size:11px">{{inv.status==='Submitted'?'Sent':inv.status||'Draft'}}</span>
            <span style="font-size:11px;color:var(--text-3)">{{paidPct}}% paid</span>
          </div>
          <div style="height:6px;background:var(--surface-2);border-radius:4px;overflow:hidden;margin-bottom:12px">
            <div :style="{width:paidPct+'%',height:'100%',background:paidPct>=100?'#2f9e44':'#2563EB',borderRadius:'4px',transition:'width .5s'}"></div>
          </div>
          <div class="zb-panel-row"><span>Grand Total</span><span class="mono fw-700">{{fmt(inv.grand_total)}}</span></div>
          <div class="zb-panel-row"><span>Paid</span><span class="mono" style="color:#2f9e44;font-weight:600">{{fmt(paidAmt)}}</span></div>
          <div class="zb-panel-row" style="font-weight:700"><span>Outstanding</span>
            <span class="mono" :style="{color:flt(inv.outstanding_amount)>0?'#e67700':'#2f9e44'}">{{fmt(inv.outstanding_amount)}}</span>
          </div>
        </div>
        <div class="zb-panel-card">
          <div class="zb-panel-title">Invoice Info</div>
          <div class="zb-panel-row"><span>Invoice #</span><span class="mono" style="color:#2563EB;font-weight:700;font-size:11px">{{inv.name}}</span></div>
          <div class="zb-panel-row"><span>Date</span><span>{{fmtDate(inv.posting_date)}}</span></div>
          <div class="zb-panel-row"><span>Due</span>
            <span :style="{color:flt(inv.outstanding_amount)>0&&inv.due_date&&new Date(inv.due_date)<new Date()?'#e03131':'inherit'}">{{fmtDate(inv.due_date)}}</span>
          </div>
          <div class="zb-panel-row" v-if="inv.currency"><span>Currency</span><span>{{inv.currency}}</span></div>
        </div>
        <div class="zb-panel-card">
          <div class="zb-panel-title">Customer</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">
            <div style="width:34px;height:34px;border-radius:8px;background:#EEF2FF;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#2563EB;flex-shrink:0">
              {{(inv.customer_name||inv.customer||'?')[0].toUpperCase()}}
            </div>
            <div>
              <div style="font-weight:700;font-size:13px">{{inv.customer_name||inv.customer}}</div>
              <div style="font-size:11px;color:var(--text-3)">{{inv.customer}}</div>
            </div>
          </div>
          <div class="zb-panel-row" v-if="inv.debit_to"><span>AR Account</span><span style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" :title="inv.debit_to">{{inv.debit_to}}</span></div>
          <div class="zb-panel-row" v-if="inv.income_account"><span>Income Acct</span><span style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" :title="inv.income_account">{{inv.income_account}}</span></div>
        </div>
      </div>

      </div><!-- /right panel -->
      </div><!-- /flex row -->
    </template>
  </div><!-- /detail area -->
  
  <SendEmailModal :show="showSendEmail" :invoice-name="invName" :inv="inv" @close="showSendEmail=false" @sent="showSendEmail=false"/>

</div>
`});

  const Purchases = defineComponent({
    name: "Purchases",
    components: { PurchaseModal },
    setup() {
      const list = ref([]), loading = ref(true), showNew = ref(false);
      async function load() {
        loading.value = true;
        try { list.value = await apiList("Purchase Invoice", { fields: ["name", "supplier", "posting_date", "due_date", "grand_total", "outstanding_amount", "status"], order: "posting_date desc" }); }
        catch (e) { console.error("Purchase Invoice load failed:", e.message); toast("Failed to load bills: " + e.message, "error"); }
        finally { loading.value = false; }
      }
      onMounted(load);
      return { list, loading, showNew, load, fmt, fmtDate, statusBadge, icon, flt, openDoc };
    },
    template: `
<div class="b-page">
  <PurchaseModal :show="showNew" @close="showNew=false" @saved="load"/>
  <div class="b-action-bar">
    <div></div>
    <div style="display:flex;gap:8px">
      <button class="b-btn b-btn-ghost" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="b-btn" style="background:#2F9E44;color:#fff;border:none" @click="showNew=true"><span v-html="icon('plus',13)"></span> New Bill</button>
    </div>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Bill #</th><th>Supplier</th><th>Date</th><th>Due Date</th><th class="ta-r">Amount</th><th class="ta-r">Outstanding</th><th>Status</th><th></th></tr></thead>
      <tbody>
        <template v-if="loading"><tr v-for="n in 6" :key="n"><td colspan="8" style="padding:14px"><div class="b-shimmer" style="height:13px"></div></td></tr></template>
        <template v-else>
          <tr v-for="inv in list" :key="inv.name" class="clickable" @click="openDoc('Purchase Invoice',inv.name)">
            <td><span class="mono c-accent fw-700" style="font-size:12px">{{inv.name}}</span></td>
            <td class="fw-600">{{inv.supplier}}</td>
            <td class="c-muted" style="font-size:12.5px">{{fmtDate(inv.posting_date)}}</td>
            <td class="c-muted" style="font-size:12.5px">{{fmtDate(inv.due_date)}}</td>
            <td class="ta-r mono fw-600" style="font-size:13px">{{fmt(inv.grand_total)}}</td>
            <td class="ta-r mono fw-600" style="font-size:13px" :class="flt(inv.outstanding_amount)>0?'c-amber':'c-green'">{{fmt(inv.outstanding_amount)}}</td>
            <td><span class="b-badge" :class="statusBadge(inv.status)">{{inv.status}}</span></td>
            <td><button @click.stop="openDoc('Purchase Invoice',inv.name)" style="background:none;border:none;cursor:pointer;color:#2F9E44" v-html="icon('ext',14)"></button></td>
          </tr>
          <tr v-if="!list.length"><td colspan="8" class="b-empty">No bills found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`});

  const Payments = defineComponent({
    name: "Payments",
    components: { PaymentModal },
    setup() {
      const list = ref([]), loading = ref(true), active = ref("all"), showNew = ref(false);
      const types = [{ k: "all", lbl: "All" }, { k: "Receive", lbl: "Received" }, { k: "Pay", lbl: "Paid Out" }];
      const filtered = computed(() => active.value === "all" ? list.value : list.value.filter(p => p.payment_type === active.value));
      async function load() {
        loading.value = true;
        try { list.value = await apiList("Payment Entry", { fields: ["name", "party", "party_type", "paid_amount", "payment_type", "payment_date", "mode_of_payment"], order: "payment_date desc" }); }
        catch (e) { console.error("Payment Entry load failed:", e.message); toast("Failed to load payments: " + e.message, "error"); }
        finally { loading.value = false; }
      }
      onMounted(load);
      return { list, loading, active, types, filtered, showNew, load, fmt, fmtDate, icon, statusBadge, openDoc };
    },
    template: `
<div class="b-page">
  <PaymentModal :show="showNew" @close="showNew=false" @saved="load"/>
  <div class="b-action-bar">
    <div class="b-filter-row"><button v-for="t in types" :key="t.k" class="b-pill" :class="{active:active===t.k}" @click="active=t.k">{{t.lbl}}</button></div>
    <div style="display:flex;gap:8px">
      <button class="b-btn b-btn-ghost" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="b-btn" style="background:#7C3AED;color:#fff;border:none" @click="showNew=true"><span v-html="icon('plus',13)"></span> New Payment</button>
    </div>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Payment #</th><th>Party</th><th>Mode</th><th>Date</th><th>Type</th><th class="ta-r">Amount</th><th></th></tr></thead>
      <tbody>
        <template v-if="loading"><tr v-for="n in 6" :key="n"><td colspan="7" style="padding:14px"><div class="b-shimmer" style="height:13px"></div></td></tr></template>
        <template v-else>
          <tr v-for="p in filtered" :key="p.name" class="clickable" @click="openDoc('Payment Entry',p.name)">
            <td><span class="mono c-accent fw-700" style="font-size:12px">{{p.name}}</span></td>
            <td class="fw-600">{{p.party}}</td>
            <td class="c-muted">{{p.mode_of_payment||'—'}}</td>
            <td class="c-muted" style="font-size:12.5px">{{fmtDate(p.payment_date)}}</td>
            <td><span class="b-badge" :class="statusBadge(p.payment_type)">{{p.payment_type}}</span></td>
            <td class="ta-r mono fw-700" :class="p.payment_type==='Receive'?'c-green':'c-red'">{{fmt(p.paid_amount)}}</td>
            <td><button @click.stop="openDoc('Payment Entry',p.name)" style="background:none;border:none;cursor:pointer;color:#7C3AED" v-html="icon('ext',14)"></button></td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="7" class="b-empty">No payments found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`});

  const Banking = defineComponent({
    name: "Banking",
    setup() {
      const cash = ref(null), cashLoad = ref(true), txns = ref([]), txnLoad = ref(false), sel = ref(null);
      async function loadCash() { cashLoad.value = true; try { cash.value = await apiGET("zoho_books_clone.api.dashboard.get_cash_position"); } finally { cashLoad.value = false; } }
      async function pickAcct(a) {
        sel.value = a.name; txnLoad.value = true;
        try { txns.value = await apiList("Bank Transaction", { fields: ["name", "date", "description", "debit", "credit", "balance", "reference_number", "status"], filters: [["bank_account", "=", a.name]], order: "date desc", limit: 30 }); }
        finally { txnLoad.value = false; }
      }
      onMounted(loadCash);
      return { cash, cashLoad, txns, txnLoad, sel, pickAcct, fmt, fmtDate, icon, statusBadge, flt };
    },
    template: `
<div class="b-page">
  <div class="b-card" style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px">
    <div>
      <div style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:4px">Total Cash Position</div>
      <div v-if="cashLoad" class="b-shimmer" style="width:140px;height:28px"></div>
      <div v-else style="font-family:var(--mono);font-size:26px;font-weight:700;color:var(--green-text)">{{fmt(cash?.total_cash)}}</div>
    </div><span class="b-badge b-badge-green">Live</span>
  </div>
  <div class="b-bank-grid">
    <template v-if="cashLoad"><div v-for="n in 3" :key="n" class="b-bank-card"><div class="b-shimmer" style="height:80px"></div></div></template>
    <template v-else>
      <div v-for="a in (cash?.bank_accounts||[])" :key="a.name" class="b-bank-card" :class="{selected:sel===a.name}" @click="pickAcct(a)">
        <div style="display:flex;justify-content:space-between;align-items:center"><span class="b-badge b-badge-blue" style="font-size:11px">{{a.currency||'INR'}}</span></div>
        <div class="b-bank-name">{{a.account_name}}</div>
        <div class="b-bank-sub">{{a.bank_name||'Bank Account'}}</div>
        <div class="b-bank-balance">{{fmt(a.current_balance)}}</div>
      </div>
      <div v-if="!(cash?.bank_accounts?.length)" class="b-bank-card b-empty" style="cursor:default">No bank accounts configured<br><a :href="newDocUrl('Bank Account')" target="_blank" style="color:#3B5BDB;font-size:12px;margin-top:6px;display:block">+ Add Bank Account</a></div>
    </template>
  </div>
  <div v-if="sel" class="b-card" style="padding:0;overflow:hidden">
    <div class="b-card-head"><span class="b-card-title">Transactions — {{sel}}</span><span class="b-badge b-badge-amber">{{txns.filter(t=>t.status==='Unreconciled').length}} unreconciled</span></div>
    <table class="b-table">
      <thead><tr><th>Ref #</th><th>Date</th><th>Description</th><th class="ta-r">Debit</th><th class="ta-r">Credit</th><th class="ta-r">Balance</th><th>Status</th></tr></thead>
      <tbody>
        <template v-if="txnLoad"><tr v-for="n in 5" :key="n"><td colspan="7" style="padding:14px"><div class="b-shimmer" style="height:12px"></div></td></tr></template>
        <template v-else>
          <tr v-for="t in txns" :key="t.name">
            <td class="mono c-accent fw-600" style="font-size:12px">{{t.reference_number||t.name}}</td>
            <td class="c-muted" style="font-size:12.5px">{{fmtDate(t.date)}}</td>
            <td class="c-muted" style="font-size:12.5px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{t.description||'—'}}</td>
            <td class="ta-r mono c-red fw-600" style="font-size:12.5px">{{flt(t.debit)>0?fmt(t.debit):'—'}}</td>
            <td class="ta-r mono c-green fw-600" style="font-size:12.5px">{{flt(t.credit)>0?fmt(t.credit):'—'}}</td>
            <td class="ta-r mono fw-600" style="font-size:12.5px">{{fmt(t.balance)}}</td>
            <td><span class="b-badge" :class="statusBadge(t.status)">{{t.status}}</span></td>
          </tr>
          <tr v-if="!txns.length"><td colspan="7" style="text-align:center;padding:28px;color:var(--green-text);font-weight:600">✓ All reconciled</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`});

  const Accounts = defineComponent({
    name: "Accounts",
    setup() {
      const list = ref([]), loading = ref(true), active = ref("All");
      const types = computed(() => ["All", ...new Set(list.value.map(a => a.account_type).filter(Boolean))]);
      const filtered = computed(() => active.value === "All" ? list.value : list.value.filter(a => a.account_type === active.value));
      const TC = { Asset: "b-badge-blue", Liability: "b-badge-red", Equity: "b-badge-amber", Income: "b-badge-green", Expense: "b-badge-red", Bank: "b-badge-blue", Cash: "b-badge-green", Receivable: "b-badge-blue", Payable: "b-badge-red", Tax: "b-badge-amber" };
      async function load() {
        loading.value = true;
        try { list.value = await apiList("Account", { fields: ["name", "account_name", "account_type", "parent_account", "is_group"], limit: 100, order: "account_type asc, account_name asc" }); }
        finally { loading.value = false; }
      }
      onMounted(load);
      return { list, loading, active, types, filtered, TC, load, fmt, icon, openDoc, openNew };
    },
    template: `
<div class="b-page">
  <div class="b-action-bar">
    <div class="b-filter-row"><button v-for="t in types" :key="t" class="b-pill" :class="{active:active===t}" @click="active=t">{{t}}</button></div>
    <div style="display:flex;gap:8px">
      <button class="b-btn b-btn-ghost" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="b-btn b-btn-primary" @click="openNew('Account')"><span v-html="icon('plus',13)"></span> New Account</button>
    </div>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Account Name</th><th>Type</th><th>Parent</th><th class="ta-r">Balance (₹)</th></tr></thead>
      <tbody>
        <template v-if="loading"><tr v-for="n in 8" :key="n"><td colspan="4" style="padding:14px"><div class="b-shimmer" style="height:12px"></div></td></tr></template>
        <template v-else>
          <tr v-for="a in filtered" :key="a.name" class="clickable" @click="openDoc('Account',a.name)">
            <td><div class="fw-700">{{a.account_name}}</div><div class="mono c-muted" style="font-size:11px">{{a.is_group?'Group':'Ledger'}}</div></td>
            <td><span class="b-badge" :class="TC[a.account_type]||'b-badge-muted'">{{a.account_type}}</span></td>
            <td class="c-muted" style="font-size:13px">{{a.parent_account||'—'}}</td>
            <td class="ta-r mono fw-600 c-muted">—</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="4" class="b-empty">No accounts found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`});

  const Reports = defineComponent({
    name: "Reports",
    setup() {
      const today_str = new Date().toISOString().slice(0, 10);
      const from = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10));
      const to = ref(today_str);
      const tab = ref("pl"), running = ref(false);
      const pl = ref(null), bs = ref(null), cf = ref(null), gst = ref(null);
      const tabs = [{ k: "pl", lbl: "P & L" }, { k: "bs", lbl: "Balance Sheet" }, { k: "cf", lbl: "Cash Flow" }, { k: "gst", lbl: "GST Summary" }];
      async function run() {
        running.value = true;
        const c = co(), args = { company: c, from_date: from.value, to_date: to.value };
        try {
          if (tab.value === "pl") pl.value = await apiGET("zoho_books_clone.db.queries.get_profit_and_loss", args);
          else if (tab.value === "bs") bs.value = await apiGET("zoho_books_clone.db.queries.get_balance_sheet_totals", { company: c, as_of_date: to.value });
          else if (tab.value === "cf") cf.value = await apiGET("zoho_books_clone.db.queries.get_cash_flow", args);
          else gst.value = await apiGET("zoho_books_clone.db.queries.get_gst_summary", args);
        } catch (e) { toast(e.message, "error"); }
        finally { running.value = false; }
      }
      return { from, to, tab, tabs, pl, bs, cf, gst, running, run, fmt, icon, flt };
    },
    template: `
<div class="b-page">
  <div class="b-report-tabs"><button v-for="t in tabs" :key="t.k" class="b-rtab" :class="{active:tab===t.k}" @click="tab=t.k;pl=null;bs=null;cf=null;gst=null">{{t.lbl}}</button></div>
  <div class="b-card" style="display:flex;align-items:center;gap:12px;padding:14px 20px;flex-wrap:wrap">
    <label style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3)">From</label>
    <input type="date" v-model="from" class="b-input"/>
    <label style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3)">To</label>
    <input type="date" v-model="to" class="b-input"/>
    <button class="b-btn b-btn-primary" @click="run" :disabled="running">{{running?'Running…':'▶ Run Report'}}</button>
  </div>
  <div v-if="tab==='pl'" class="b-card b-card-body">
    <div style="font-size:16px;font-weight:700;margin-bottom:16px">Profit & Loss Statement</div>
    <div v-if="running" class="b-shimmer" style="height:80px"></div>
    <template v-else-if="pl">
      <div class="b-pl-row"><span>Total Income</span><span class="mono fw-700 c-green">{{fmt(pl.total_income)}}</span></div>
      <div class="b-pl-row"><span>Total Expense</span><span class="mono fw-700 c-red">{{fmt(pl.total_expense)}}</span></div>
      <div class="b-pl-row b-pl-net"><span>Net Profit</span><span class="mono fw-700" :class="flt(pl.net_profit)>=0?'c-green':'c-red'">{{fmt(pl.net_profit)}}</span></div>
    </template>
    <div v-else class="b-empty">Select a period and click Run Report.</div>
  </div>
  <div v-if="tab==='bs'" class="b-card b-card-body">
    <div style="font-size:16px;font-weight:700;margin-bottom:16px">Balance Sheet</div>
    <div v-if="running" class="b-shimmer" style="height:80px"></div>
    <div v-else-if="bs" class="b-bs-grid">
      <div class="b-bs-block"><div class="b-bs-lbl">Assets</div><div class="b-bs-amt c-accent">{{fmt(bs.total_assets)}}</div></div>
      <div class="b-bs-block"><div class="b-bs-lbl">Liabilities</div><div class="b-bs-amt c-red">{{fmt(bs.total_liabilities)}}</div></div>
      <div class="b-bs-block"><div class="b-bs-lbl">Equity</div><div class="b-bs-amt c-amber">{{fmt(bs.total_equity)}}</div></div>
    </div>
    <div v-else class="b-empty">Select a period and click Run Report.</div>
  </div>
  <div v-if="tab==='cf'" class="b-card b-card-body">
    <div style="font-size:16px;font-weight:700;margin-bottom:16px">Cash Flow Statement</div>
    <div v-if="running" class="b-shimmer" style="height:80px"></div>
    <template v-else-if="cf">
      <div class="b-pl-row"><span>Operating</span><span class="mono fw-700" :class="flt(cf.operating)>=0?'c-green':'c-red'">{{fmt(cf.operating)}}</span></div>
      <div class="b-pl-row"><span>Investing</span><span class="mono fw-700" :class="flt(cf.investing)>=0?'c-green':'c-red'">{{fmt(cf.investing)}}</span></div>
      <div class="b-pl-row"><span>Financing</span><span class="mono fw-700" :class="flt(cf.financing)>=0?'c-green':'c-red'">{{fmt(cf.financing)}}</span></div>
      <div class="b-pl-row b-pl-net"><span>Net Change</span><span class="mono fw-700" :class="flt(cf.net_change)>=0?'c-green':'c-red'">{{fmt(cf.net_change)}}</span></div>
    </template>
    <div v-else class="b-empty">Select a period and click Run Report.</div>
  </div>
  <div v-if="tab==='gst'" class="b-card" style="padding:0;overflow:hidden">
    <div class="b-card-head"><span class="b-card-title">GST Summary</span></div>
    <div v-if="running" style="padding:20px"><div class="b-shimmer" style="height:60px"></div></div>
    <table v-else-if="gst&&gst.length" class="b-table">
      <thead><tr><th>Tax Type</th><th class="ta-r">Invoice Count</th><th class="ta-r">Total Tax</th></tr></thead>
      <tbody><tr v-for="g in gst" :key="g.tax_type"><td><span class="b-badge b-badge-blue">{{g.tax_type}}</span></td><td class="ta-r mono fw-600">{{g.invoice_count}}</td><td class="ta-r mono fw-700 c-green">{{fmt(g.total_tax)}}</td></tr></tbody>
    </table>
    <div v-else-if="!running" class="b-empty">Select a period and click Run Report.</div>
  </div>
</div>`});

  /* ═══════════════════════════════════════════════════════════════
     APP SHELL
  ═══════════════════════════════════════════════════════════════ */
  const NAV = [
    { section: "MAIN", items: [{ to: "/", lbl: "Dashboard", icon: "grid" }] },
    { section: "INVOICING", items: [{ to: "/invoices", lbl: "Sales Invoices", icon: "file" }, { to: "/purchases", lbl: "Purchase Bills", icon: "purchase" }, { to: "/payments", lbl: "Payments", icon: "pay" }] },
    { section: "REPORTS", items: [{ to: "/reports", lbl: "P & L", icon: "trend" }, { to: "/accounts", lbl: "Balance Sheet", icon: "chart" }] },
    { section: "", items: [{ to: "/banking", lbl: "Banking", icon: "bank" }] },
  ];
  const TITLES = { dashboard: "Dashboard", invoices: "Sales Invoices", purchases: "Purchase Bills", payments: "Payments", banking: "Banking", accounts: "Chart of Accounts", reports: "Reports" };

  const App = defineComponent({
    name: "BooksApp",
    setup() {
      const route = useRoute();
      const router = useRouter();
      const cname = computed(() => window.__booksCompany || "My Company");
      const initials = computed(() => { const n = window.frappe?.session?.user_fullname || "Admin"; return n.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase(); });
      const fullname = computed(() => window.frappe?.session?.user_fullname || "Administrator");
      const title = computed(() => TITLES[route.name] || "Books");
      const collapsed = ref(false);
      const mobileOpen = ref(false);

      // ── AI Workflow Automator ──
      const aiOpen = ref(false);
      const aiInput = ref("");
      const aiRunning = ref(false);
      const aiResult = reactive({ status: "", message: "", type: "", actions: [], data: null });

      const COMMANDS = [
        { icon: "file",    label: "Create invoice for [customer] ₹[amount]",    hint: "Create invoice for Prasath ₹80,000" },
        { icon: "fileplus",label: "Create invoice for [customer] [item] ₹[rate]",hint: "Create invoice for hari laptop ₹50,000" },
        { icon: "payment", label: "Record payment for [invoice]",                hint: "Record payment for INV-2026-00005" },
        { icon: "alert",   label: "Show overdue invoices",                       hint: "Show overdue invoices" },
        { icon: "search",  label: "Find invoices for [customer]",                hint: "Find invoices for hari" },
        { icon: "rupee",   label: "Show total outstanding",                      hint: "Show total outstanding" },
      ];

      const filteredCommands = computed(() => {
        if (!aiInput.value.trim()) return COMMANDS;
        const q = aiInput.value.toLowerCase();
        return COMMANDS.filter(c => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q));
      });

      function fillCommand(cmd) {
        // Put just the template text without the icon
        aiInput.value = cmd.hint;
        document.getElementById("aiInputEl")?.focus();
      }

      async function runAI() {
        const raw = aiInput.value.trim();
        if (!raw || aiRunning.value) return;
        aiRunning.value = true;
        aiResult.status = "running";
        aiResult.message = "Processing…";
        aiResult.type = "";
        aiResult.actions = [];
        aiResult.data = null;

        try {
          const res = await apiPOST("zoho_books_clone.api.books_data.ai_chat", {
            messages: JSON.stringify([{ role: "user", content: raw }]),
          });

          const text = res?.text || "";

          // Try to parse JSON action
          const jsonMatch = text.match(/\{[\s\S]*"action"[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            await executeAction(parsed, raw);
          } else {
            // Plain text answer
            aiResult.status = "info";
            aiResult.type = "text";
            aiResult.message = text;
          }
        } catch (e) {
          aiResult.status = "error";
          aiResult.type = "error";
          aiResult.message = e.message || String(e);
        } finally {
          aiRunning.value = false;
        }
      }

      async function executeAction(parsed, raw) {
        const action = parsed.action;

        // ── Create Invoice ──
        if (action === "create_invoice") {
          aiResult.message = "Creating invoice…";
          const company = window.__booksCompany || "";
          const today = new Date().toISOString().slice(0, 10);
          const items = (parsed.items || []).map(it => ({
            doctype: "Sales Invoice Item",
            item_name: it.item_name || "Service",
            item_code: it.item_name || "Service",
            description: it.item_name || "Service",
            qty: parseFloat(it.qty) || 1,
            rate: parseFloat(it.rate) || 0,
            amount: parseFloat(it.amount) || parseFloat(it.rate) || 0,
            uom: "Nos",
          }));
          const doc = {
            doctype: "Sales Invoice",
            customer: parsed.customer,
            posting_date: today,
            due_date: parsed.due_date || today,
            company, currency: "INR", items,
            notes: parsed.notes || "",
          };
          const saved = await apiGET("zoho_books_clone.api.books_data.save_doc", { doc: JSON.stringify(doc) });
          aiResult.status = "success";
          aiResult.type = "invoice_created";
          aiResult.message = "Invoice created successfully!";
          aiResult.data = saved;
          aiResult.actions = [
            { label: "Open Invoice", fn: () => { router.push({ name: "invoice-detail", params: { name: saved.name } }); aiOpen.value = false; } },
            { label: "Create Another", fn: () => { aiInput.value = ""; aiResult.status = ""; } },
          ];
          return;
        }

        // ── Show Overdue ──
        if (action === "show_overdue" || raw.toLowerCase().includes("overdue")) {
          aiResult.message = "Fetching overdue invoices…";
          const list = await apiList("Sales Invoice", {
            fields: ["name","customer_name","due_date","outstanding_amount","status"],
            order: "due_date asc", limit: 50,
          });
          const overdue = list.filter(i => i.outstanding_amount > 0 && i.due_date && new Date(i.due_date) < new Date());
          const total = overdue.reduce((s, i) => s + parseFloat(i.outstanding_amount || 0), 0);
          aiResult.status = overdue.length ? "warning" : "success";
          aiResult.type = "invoice_list";
          aiResult.message = overdue.length ? `${overdue.length} overdue invoices — Total ₹${total.toLocaleString("en-IN")}` : "No overdue invoices! All caught up.";
          aiResult.data = overdue;
          return;
        }

        // ── Find by Customer ──
        if (action === "find_invoices" || parsed.customer) {
          aiResult.message = "Searching invoices…";
          const customer = parsed.customer || raw.replace(/find invoices for/i, "").trim();
          const list = await apiList("Sales Invoice", {
            fields: ["name","customer_name","posting_date","grand_total","outstanding_amount","status"],
            filters: [["customer_name","like",`%${customer}%`]],
            order: "posting_date desc", limit: 20,
          });
          const total = list.reduce((s, i) => s + parseFloat(i.grand_total || 0), 0);
          aiResult.status = list.length ? "success" : "info";
          aiResult.type = "invoice_list";
          aiResult.message = list.length ? `${list.length} invoices for "${customer}" — Total ₹${total.toLocaleString("en-IN")}` : `No invoices found for "${customer}"`;
          aiResult.data = list;
          return;
        }

        // ── Outstanding Total ──
        if (action === "show_outstanding" || raw.toLowerCase().includes("outstanding")) {
          aiResult.message = "Calculating…";
          const list = await apiList("Sales Invoice", {
            fields: ["name","customer_name","outstanding_amount"],
            filters: [["outstanding_amount",">",0]], limit: 200,
          });
          const total = list.reduce((s, i) => s + parseFloat(i.outstanding_amount || 0), 0);
          aiResult.status = "info";
          aiResult.type = "summary";
          aiResult.message = `Total Outstanding`;
          aiResult.data = { amount: total, count: list.length };
          return;
        }

        // ── Reply / conversational message ──
        if (action === "reply" || action === "unknown") {
          aiResult.status = "info";
          aiResult.type = "reply";
          aiResult.message = parsed.message || "";
          return;
        }
      }

      function aiIcon(name) {
        const icons = {
          file:     '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
          fileplus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
          payment:  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
          alert:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
          search:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
          rupee:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
        };
        return icons[name] || icons.file;
      }

      function onAIKey(e) { if (e.key === "Enter") { e.preventDefault(); runAI(); } }

      function logout() {
        if (window.frappe && window.frappe.call) {
          window.frappe.call({ method: "logout", callback: () => { window.location.href = "/login"; } });
        } else { window.location.href = "/login"; }
      }
      function closeMobile() { mobileOpen.value = false; }

      return { cname, initials, fullname, title, NAV, icon, collapsed, mobileOpen, logout, closeMobile,
               aiOpen, aiInput, aiRunning, aiResult, COMMANDS, filteredCommands, fillCommand, runAI, onAIKey, aiIcon, fmtDate, fmt };
    },
    template: `
<div :class="{'books-root':true, collapsed:collapsed, 'mobile-open':mobileOpen}">
  <div class="b-mob-overlay" v-if="mobileOpen" @click="closeMobile"></div>

  <aside class="b-sidebar">
    <div class="b-brand">
      <div class="b-brand-icon">B</div>
      <div class="b-brand-info"><div class="b-brand-name">Books</div><div class="b-brand-sub">Accounting</div></div>
      <button class="b-mob-close" @click="closeMobile" title="Close menu">✕</button>
    </div>
    <nav class="b-nav">
      <template v-for="group in NAV" :key="group.section">
        <div v-if="group.section" class="b-nav-section">{{group.section}}</div>
        <router-link v-for="n in group.items" :key="n.to" :to="n.to" custom v-slot="{navigate,isActive}">
          <div class="b-nav-item" :class="{active:isActive}" @click="()=>{navigate();closeMobile();}">
            <span class="b-nav-icon" v-html="icon(n.icon,16)"></span>
            <span class="b-nav-label">{{n.lbl}}</span>
          </div>
        </router-link>
      </template>
    </nav>
    <div class="b-sidebar-footer">
      <!-- AI Automator button removed from sidebar — now a floating FAB -->
      <button class="b-collapse-btn" @click="collapsed=!collapsed" :title="collapsed?'Expand':'Collapse'">
        <span v-html="icon(collapsed?'chevR':'chevL',14)"></span>
        <span class="b-nav-label">Collapse</span>
      </button>
      <div class="b-user-row" style="margin-top:6px">
        <div class="b-user-avatar">{{initials}}</div>
        <div class="b-user-info"><div class="b-user-name">{{fullname}}</div><div class="b-user-role">Books Admin</div></div>
      </div>
      <button class="b-logout-btn" @click="logout" title="Logout">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        <span class="b-nav-label">Logout</span>
      </button>
    </div>
  </aside>

  <div class="b-right">
    <header class="b-topbar">
      <div style="display:flex;align-items:center;gap:12px">
        <button class="b-hamburger" @click="mobileOpen=!mobileOpen" title="Menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <span class="b-page-title">{{title}}</span>
      </div>
      <div class="b-topbar-right">
        <div class="b-search"><span class="b-search-ico" v-html="icon('search',14)"></span><input placeholder="Search invoices…"/></div>
        <div class="b-topbar-avatar" :title="fullname">{{initials}}</div>
      </div>
    </header>
    <main class="b-main"><router-view></router-view></main>
  </div>

  <!-- ── AI Automator Floating Button + Panel ── -->
  <teleport to="body">
    <!-- Floating trigger button -->
    <button class="ai-fab" @click="aiOpen=!aiOpen" :title="'AI Automator'">
      <transition name="ai-fab-icon" mode="out-in">
        <svg v-if="!aiOpen" key="open" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        <svg v-else key="close" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </transition>
      <span class="ai-fab-label">AI</span>
    </button>

    <transition name="ai-slide">
      <div v-if="aiOpen" class="ai-panel">

        <!-- Header -->
        <div class="ai-panel-header">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="ai-panel-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            </div>
            <div>
              <div style="font-size:13.5px;font-weight:700;color:#fff;letter-spacing:-.01em">AI Automator</div>
              <div style="font-size:10px;color:rgba(255,255,255,.5);letter-spacing:.03em">Powered by Claude</div>
            </div>
          </div>
          <button class="ai-panel-close" @click="aiOpen=false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <!-- Input -->
        <div class="ai-input-wrap">
          <svg class="ai-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input
            id="aiInputEl"
            v-model="aiInput"
            class="ai-input"
            placeholder="Describe what you want to do…"
            @keydown="onAIKey"
            :disabled="aiRunning"
            autocomplete="off"
          />
          <button class="ai-run-btn" @click="runAI" :disabled="aiRunning || !aiInput.trim()">
            <svg v-if="!aiRunning" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <div v-else class="ai-spinner"></div>
          </button>
        </div>

        <!-- Command suggestions (shown when input is empty or typing) -->
        <div v-if="!aiResult.status" class="ai-commands">
          <div class="ai-commands-label">What can I do for you?</div>
          <div v-for="cmd in filteredCommands" :key="cmd.label"
            class="ai-command-item" @click="fillCommand(cmd)">
            <span class="ai-command-icon" v-html="aiIcon(cmd.icon)"></span>
            <div>
              <div class="ai-command-title">{{cmd.hint}}</div>
            </div>
            <svg class="ai-command-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </div>

        <!-- Result area -->
        <div v-if="aiResult.status" class="ai-result">

          <!-- Running -->
          <div v-if="aiResult.status==='running'" class="ai-result-running">
            <div class="ai-dots"><span></span><span></span><span></span></div>
            <span>{{aiResult.message}}</span>
          </div>

          <!-- Error -->
          <div v-else-if="aiResult.status==='error'" class="ai-result-card ai-card-error">
            <div class="ai-card-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div>
              <div class="ai-card-title">Something went wrong</div>
              <div class="ai-card-sub">{{aiResult.message}}</div>
            </div>
          </div>

          <!-- Invoice Created -->
          <div v-else-if="aiResult.type==='invoice_created'" class="ai-result-card ai-card-success">
            <div class="ai-card-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div style="flex:1">
              <div class="ai-card-title">{{aiResult.message}}</div>
              <div class="ai-card-meta">
                <span class="ai-meta-pill">{{aiResult.data?.name}}</span>
                <span class="ai-meta-pill">{{aiResult.data?.customer_name || aiResult.data?.customer}}</span>
                <span class="ai-meta-pill">₹{{Number(aiResult.data?.grand_total||0).toLocaleString("en-IN")}}</span>
              </div>
            </div>
          </div>

          <!-- Summary Card (outstanding total) -->
          <div v-else-if="aiResult.type==='summary'" class="ai-result-card ai-card-info">
            <div class="ai-card-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            </div>
            <div>
              <div class="ai-card-title">{{aiResult.message}}</div>
              <div style="font-size:22px;font-weight:800;color:#fff;margin-top:4px">₹{{Number(aiResult.data?.amount||0).toLocaleString("en-IN")}}</div>
              <div class="ai-card-sub">across {{aiResult.data?.count}} invoices</div>
            </div>
          </div>

          <!-- Plain text info -->
          <div v-else-if="aiResult.type==='text'" class="ai-result-card ai-card-info">
            <div class="ai-card-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div class="ai-card-title" style="white-space:pre-wrap">{{aiResult.message}}</div>
          </div>

          <!-- Conversational reply -->
          <div v-else-if="aiResult.type==='reply'" class="ai-reply-card">
            <div class="ai-reply-bar"></div>
            <div class="ai-reply-text" style="white-space:pre-wrap">{{aiResult.message}}</div>
          </div>

          <!-- Invoice List -->
          <div v-if="aiResult.type==='invoice_list' && aiResult.data">
            <div class="ai-list-header">
              <span :class="['ai-status-dot', aiResult.status==='warning'?'dot-warn':'dot-ok']"></span>
              {{aiResult.message}}
            </div>
            <div class="ai-list-wrap">
              <div v-for="inv in (aiResult.data||[]).slice(0,8)" :key="inv.name"
                class="ai-list-item">
                <div>
                  <div class="ai-list-name">{{inv.customer_name||inv.customer}}</div>
                  <div class="ai-list-inv">{{inv.name}} · {{fmtDate(inv.due_date||inv.posting_date)}}</div>
                </div>
                <div style="text-align:right">
                  <div class="ai-list-amt" :style="{color:inv.outstanding_amount>0?'#f87171':'#34d399'}">
                    ₹{{Number(inv.outstanding_amount||inv.grand_total||0).toLocaleString("en-IN")}}
                  </div>
                </div>
              </div>
              <div v-if="(aiResult.data||[]).length > 8" class="ai-list-more">
                +{{aiResult.data.length - 8}} more
              </div>
            </div>
          </div>

          <!-- Action buttons -->
          <div v-if="aiResult.actions && aiResult.actions.length" class="ai-action-btns">
            <button v-for="(act,i) in aiResult.actions" :key="i"
              class="ai-action-btn" :class="i===0?'ai-action-primary':'ai-action-secondary'"
              @click="act.fn()">
              {{act.label}}
            </button>
          </div>

          <!-- Reset -->
          <button class="ai-reset-btn" @click="aiResult.status='';aiInput=''">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.9"/></svg>
            New command
          </button>
        </div>

      </div>
    </transition>
  </teleport>

</div>`});

  /* ── CSS for modal inputs (injected once) ── */
  const modalCSS = `
/* ══ AI Automator FAB ══ */
.ai-fab{
  position:fixed;bottom:24px;right:24px;
  display:flex;align-items:center;gap:8px;
  height:44px;padding:0 18px;
  background:#2563eb;
  color:#fff;border:none;border-radius:22px;
  box-shadow:0 4px 16px rgba(37,99,235,.4),0 2px 6px rgba(0,0,0,.1);
  cursor:pointer;z-index:9997;
  font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
  font-size:13px;font-weight:700;letter-spacing:.02em;
  transition:transform .15s,box-shadow .15s,background .15s;
}
.ai-fab:hover{
  transform:translateY(-2px);background:#1d4ed8;
  box-shadow:0 8px 24px rgba(37,99,235,.5);
}
.ai-fab:active{transform:translateY(0);}
.ai-fab-label{font-size:12px;font-weight:800;letter-spacing:.06em;}
.ai-fab-icon-enter-active,.ai-fab-icon-leave-active{transition:all .15s ease;}
.ai-fab-icon-enter-from,.ai-fab-icon-leave-to{opacity:0;transform:rotate(90deg) scale(.7);}

/* ══ AI Panel — Light theme ══ */
.ai-panel{
  position:fixed;bottom:80px;right:24px;
  width:340px;
  background:#fff;
  border:1px solid #e4e8f0;
  border-radius:14px;
  box-shadow:0 12px 40px rgba(0,0,0,.12),0 4px 12px rgba(0,0,0,.06);
  display:flex;flex-direction:column;overflow:hidden;
  z-index:9998;
  font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
}
.ai-slide-enter-active,.ai-slide-leave-active{transition:all .22s cubic-bezier(.34,1.4,.64,1);}
.ai-slide-enter-from,.ai-slide-leave-to{opacity:0;transform:translateY(12px) scale(.97);}

.ai-panel-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:13px 14px;
  background:linear-gradient(135deg,#2563eb,#4f46e5);
  flex-shrink:0;
}
.ai-panel-icon{
  width:28px;height:28px;border-radius:8px;
  background:rgba(255,255,255,.18);
  display:grid;place-items:center;color:#fff;flex-shrink:0;
}
.ai-panel-close{
  background:rgba(255,255,255,.15);border:none;cursor:pointer;
  color:rgba(255,255,255,.8);width:24px;height:24px;
  border-radius:6px;display:grid;place-items:center;transition:.15s;
}
.ai-panel-close:hover{background:rgba(255,255,255,.25);color:#fff;}

/* Input */
.ai-input-wrap{
  display:flex;align-items:center;gap:8px;
  padding:11px 12px 10px;
  border-bottom:1px solid #f1f3f7;
  background:#fafbfd;
}
.ai-input-icon{color:#9ca3af;flex-shrink:0;}
.ai-input{
  flex:1;background:transparent;border:none;outline:none;
  font-size:13.5px;color:#111827;font-family:inherit;
  caret-color:#2563eb;
}
.ai-input::placeholder{color:#9ca3af;}
.ai-input:disabled{opacity:.5;}
.ai-run-btn{
  width:28px;height:28px;border-radius:8px;flex-shrink:0;
  background:#2563eb;border:none;cursor:pointer;
  display:grid;place-items:center;color:#fff;transition:.15s;
}
.ai-run-btn:hover:not(:disabled){background:#1d4ed8;}
.ai-run-btn:disabled{opacity:.35;cursor:not-allowed;}
.ai-spinner{width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:ai-spin .6s linear infinite;}
@keyframes ai-spin{to{transform:rotate(360deg)}}

/* Commands */
.ai-commands{padding:6px 0 8px;background:#fff;}
.ai-commands-label{
  font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  color:#9ca3af;padding:6px 12px 6px;
}
.ai-command-item{
  display:flex;align-items:center;gap:10px;
  padding:8px 12px;cursor:pointer;transition:background .1s;
}
.ai-command-item:hover{background:#f5f7ff;}
.ai-command-icon{
  width:28px;height:28px;border-radius:7px;
  background:#eef2ff;display:grid;place-items:center;
  color:#4f46e5;flex-shrink:0;
}
.ai-command-title{font-size:12.5px;color:#374151;line-height:1.4;}
.ai-command-arrow{color:#d1d5db;margin-left:auto;flex-shrink:0;}
.ai-command-item:hover .ai-command-arrow{color:#4f46e5;}

/* Result */
.ai-result{padding:10px 12px 14px;display:flex;flex-direction:column;gap:10px;background:#fff;}

.ai-result-running{display:flex;align-items:center;gap:10px;padding:10px 4px;color:#6b7280;font-size:13px;}
.ai-dots{display:flex;gap:4px;}
.ai-dots span{width:6px;height:6px;border-radius:50%;background:#2563eb;animation:ai-dot .9s ease-in-out infinite;}
.ai-dots span:nth-child(2){animation-delay:.15s;}
.ai-dots span:nth-child(3){animation-delay:.3s;}
@keyframes ai-dot{0%,80%,100%{transform:scale(.8);opacity:.4}40%{transform:scale(1.2);opacity:1}}

.ai-result-card{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:10px;}
.ai-card-success{background:#f0fdf4;border:1px solid #bbf7d0;}
.ai-card-error{background:#fef2f2;border:1px solid #fecaca;}
.ai-card-info{background:#eff6ff;border:1px solid #bfdbfe;}
.ai-card-icon{
  width:28px;height:28px;border-radius:8px;
  background:rgba(0,0,0,.04);display:grid;place-items:center;flex-shrink:0;
}
.ai-card-title{font-size:13px;font-weight:600;color:#111827;line-height:1.4;}
.ai-card-sub{font-size:11.5px;color:#6b7280;margin-top:3px;}
.ai-card-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;}
.ai-meta-pill{
  padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;
  background:#eef2ff;color:#4f46e5;
}

.ai-list-header{font-size:12px;font-weight:600;color:#6b7280;display:flex;align-items:center;gap:7px;margin-bottom:6px;}
.ai-status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.dot-warn{background:#f59e0b;}
.dot-ok{background:#059669;}
.ai-list-wrap{border:1px solid #e4e8f0;border-radius:10px;overflow:hidden;background:#fff;}
.ai-list-item{display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border-bottom:1px solid #f1f3f7;}
.ai-list-item:last-child{border-bottom:none;}
.ai-list-item:hover{background:#f8f9fc;}
.ai-list-name{font-size:12.5px;font-weight:600;color:#111827;}
.ai-list-inv{font-size:11px;color:#9ca3af;margin-top:1px;}
.ai-list-amt{font-size:12.5px;font-weight:700;font-family:monospace;}
.ai-list-more{padding:7px 12px;font-size:11.5px;color:#9ca3af;text-align:center;border-top:1px solid #f1f3f7;}

.ai-action-btns{display:flex;gap:7px;flex-wrap:wrap;}
.ai-action-btn{height:32px;padding:0 14px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:.15s;white-space:nowrap;}
.ai-action-primary{background:#2563eb;color:#fff;}
.ai-action-primary:hover{background:#1d4ed8;}
.ai-action-secondary{background:#f1f5f9;color:#374151;border:1px solid #e4e8f0;}
.ai-action-secondary:hover{background:#e8edf5;}

.ai-reset-btn{display:inline-flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;color:#9ca3af;font-size:11.5px;font-family:inherit;padding:0;transition:.15s;}
.ai-reset-btn:hover{color:#6b7280;}

/* Reply card */
.ai-reply-card{display:flex;gap:10px;padding:12px 2px 4px;}
.ai-reply-bar{width:3px;border-radius:2px;flex-shrink:0;background:linear-gradient(180deg,#2563eb,#4f46e5);min-height:20px;}
.ai-reply-text{font-size:13px;color:#374151;line-height:1.65;flex:1;}

/* ══ Dashboard + app shell overrides (light) ══ */
.zb-root{display:flex;flex-direction:column;height:calc(100vh - var(--topbar-h,56px));overflow:hidden;background:#fff}
.zb-toolbar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-bottom:1px solid #e4e8f0;background:#fff;flex-shrink:0}
.zb-toolbar-left{display:flex;align-items:center;gap:6px}
.zb-toolbar-title{font-size:15px;font-weight:700;color:#111827}
.zb-toolbar-caret{font-size:11px;color:#9ca3af;cursor:pointer}
.zb-toolbar-right{display:flex;gap:6px;align-items:center}
.zb-tb-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #e4e8f0;background:#fff;color:#374151;transition:.12s;font-family:inherit}
.zb-tb-btn:hover{background:#f5f7ff;border-color:#2563eb;color:#2563eb}
.zb-tb-btn.zb-tb-primary{background:#2563eb;color:#fff;border-color:#2563eb}
.zb-tb-btn.zb-tb-primary:hover{background:#1d4ed8}
.zb-body{display:flex;flex:1;overflow:hidden}
.zb-table-view{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#fff}
.zb-table-filter-bar{display:flex;align-items:center;gap:4px;padding:10px 16px;border-bottom:1px solid #e4e8f0;background:#fafbfd;flex-shrink:0}
.zb-tf-pill{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #e4e8f0;background:#fff;color:#6b7280;font-family:inherit;display:inline-flex;align-items:center;gap:4px;transition:.1s}
.zb-tf-pill:hover{border-color:#2563eb;color:#2563eb}
.zb-tf-pill.active{background:#eff6ff;color:#2563eb;border-color:#bfdbfe}
.zb-tf-cnt{background:#f1f3f7;color:#6b7280;padding:1px 5px;border-radius:10px;font-size:10px}
.zb-tf-pill.active .zb-tf-cnt{background:#dbeafe;color:#2563eb}
.zb-tf-search{display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #e4e8f0;border-radius:20px;padding:5px 12px}
.zb-tf-search-input{border:none;outline:none;background:none;font-size:12px;font-family:inherit;color:#111827;width:160px}
.zb-table-wrap{flex:1;overflow-y:auto}
.zb-inv-table{width:100%;border-collapse:collapse}
.zb-th{padding:10px 14px;text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.06em;color:#9ca3af;border-bottom:1px solid #e4e8f0;white-space:nowrap;background:#fafbfd;position:sticky;top:0;z-index:2}
.zb-th-check{width:36px;padding-left:16px}
.zb-td{padding:11px 14px;border-bottom:1px solid #f1f3f7;font-size:13px;color:#374151;vertical-align:middle}
.zb-td-check{padding-left:16px;width:36px}
.zb-td-date{color:#6b7280;font-size:12.5px}
.zb-td-muted{color:#9ca3af;font-size:12.5px}
.zb-td-customer{font-weight:600}
.zb-inv-row{cursor:pointer;transition:background .1s}
.zb-inv-row:hover{background:#f8faff}
.zb-inv-link{color:#2563eb;font-weight:600;font-size:13px}
.zb-table-empty{text-align:center;padding:48px;color:#9ca3af;font-size:13px}
/* Status chips */
.zb-status-chip{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.02em;white-space:nowrap}
.zb-chip-draft{background:#f3f4f6;color:#6b7280}
.zb-chip-due{background:#fef3c7;color:#d97706}
.zb-chip-overdue{color:#dc2626;background:transparent}
.zb-chip-paid{background:#d1fae5;color:#059669}
.zb-chip-partpaid{background:#fef3c7;color:#d97706}
/* Invoice pill tabs */
.zb-inv-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:20px;font-size:12.5px;font-weight:600;border:1.5px solid #e4e8f0;background:#fff;color:#6b7280;cursor:pointer;transition:all .15s;font-family:inherit}
.zb-inv-pill:hover{border-color:#2563eb;color:#2563eb}
.zb-inv-pill-active{background:#eff6ff;border-color:#2563eb;color:#2563eb}
.zb-pill-cnt{font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:12px}
.zb-pc-muted{background:#f3f4f6;color:#6b7280}
.zb-pc-amber{background:#fef3c7;color:#d97706}
.zb-pc-red{background:#fee2e2;color:#dc2626}
.zb-pc-green{background:#d1fae5;color:#059669}
/* Split pane */
.zb-split-list{width:300px;flex-shrink:0;border-right:1px solid #e4e8f0;background:#fff;display:flex;flex-direction:column;overflow:hidden}
.zb-split-header{padding:12px 12px 0;flex-shrink:0;border-bottom:1px solid #f1f3f7}
.zb-split-search-wrap{display:flex;align-items:center;gap:7px;background:#f8f9fc;border:1px solid #e4e8f0;border-radius:20px;padding:6px 12px;margin-bottom:8px}
.zb-split-search-input{border:none;outline:none;background:none;font-size:12px;font-family:inherit;color:#111827;width:100%}
.zb-split-pills{display:flex;gap:4px;flex-wrap:wrap;padding-bottom:8px}
.zb-split-pill{padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;border:1.5px solid #e4e8f0;background:#fff;color:#6b7280;font-family:inherit;display:inline-flex;align-items:center;gap:4px;transition:.1s}
.zb-split-pill:hover{border-color:#2563eb;color:#2563eb}
.zb-split-pill.active{background:#2563eb;color:#fff;border-color:#2563eb}
.zb-split-pill-cnt{background:rgba(255,255,255,.25);padding:1px 4px;border-radius:10px;font-size:10px}
.zb-split-pill:not(.active) .zb-split-pill-cnt{background:#f1f3f7;color:#6b7280}
.zb-split-items{flex:1;overflow-y:auto}
.zb-split-item{padding:11px 12px;border-bottom:1px solid #f4f5f7;cursor:pointer;transition:.1s}
.zb-split-item:hover{background:#f8f9fc}
.zb-split-item.selected{background:#eff6ff;border-right:3px solid #2563eb}
.zb-split-item-shimmer{padding:11px 12px;border-bottom:1px solid #f4f5f7}
.zb-split-item-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.zb-split-item-name{font-size:13px;font-weight:700;color:#111827}
.zb-split-item-amt{font-size:13px;font-weight:700;font-family:monospace;color:#111827}
.zb-split-item-mid{display:flex;align-items:center;gap:5px;margin-bottom:4px}
.zb-split-item-num{font-size:11px;color:#2563eb;font-weight:600}
.zb-split-item-dot{color:#d1d5db;font-size:10px}
.zb-split-item-date{font-size:11px;color:#9ca3af}
.zb-split-item-bot{display:flex;justify-content:space-between;align-items:center}
.zb-split-item-bal{font-size:11px;font-weight:600}
.zb-list-draft{color:#6b7280}.zb-list-unpaid{color:#d97706}.zb-list-overdue{color:#dc2626}.zb-list-partpaid{color:#d97706}.zb-list-paid{color:#059669}
/* Detail area */
.zb-master-detail{display:flex;flex:1;overflow:hidden}
.zb-detail-area{flex:1;display:flex;flex-direction:column;overflow:hidden}
.zb-actionbar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-bottom:1px solid #e4e8f0;background:#fff;flex-shrink:0;gap:10px;flex-wrap:wrap}
.zb-ab-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:6px;font-size:12.5px;font-weight:600;cursor:pointer;border:1px solid #e4e8f0;background:#fff;color:#374151;transition:.12s;font-family:inherit}
.zb-ab-btn:hover{background:#f5f7ff;border-color:#2563eb;color:#2563eb}
.zb-ab-primary{background:#2563eb!important;color:#fff!important;border-color:#2563eb!important}
.zb-ab-primary:hover{background:#1d4ed8!important}
.zb-ab-dots{background:#f3f4f6!important;border:none!important}
.zb-banner{display:flex;align-items:center;gap:10px;padding:10px 20px;background:#fffbeb;border-bottom:1px solid #fed7aa;font-size:12.5px;flex-shrink:0}
.zb-banner-upi{background:#f0fdf4;border-bottom-color:#bbf7d0}
.no-sidebar-pad{padding:0}
.b-badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap}
.b-badge-green{background:#d1fae5;color:#059669}
.b-badge-amber{background:#fef3c7;color:#d97706}
.b-badge-red{background:#fee2e2;color:#dc2626}
.b-badge-blue{background:#eff6ff;color:#2563eb}
.b-badge-muted{background:#f3f4f6;color:#6b7280}
/* PDF view */
.zb-pdf-wrap{flex:1;overflow-y:auto;background:#f4f6fa;padding:20px;display:flex;flex-direction:column;align-items:center;gap:0}
.zb-pdf-paper{background:#fff;width:100%;max-width:640px;padding:32px 36px;box-shadow:0 2px 16px rgba(0,0,0,.1);border-radius:4px}
.zb-sent-ribbon{position:absolute;top:12px;right:-28px;background:#059669;color:#fff;font-size:10px;font-weight:800;padding:4px 32px;transform:rotate(45deg);letter-spacing:.08em}
.zb-draft-ribbon{position:absolute;top:12px;right:-28px;background:#9ca3af;color:#fff;font-size:10px;font-weight:800;padding:4px 32px;transform:rotate(45deg);letter-spacing:.08em}
.zb-pdf-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid #111827}
.zb-pdf-co-name{font-size:18px;font-weight:800;color:#111827;letter-spacing:-.01em}
.zb-pdf-co-meta{font-size:11px;color:#6b7280;margin-top:2px}
.zb-pdf-inv-title{font-size:22px;font-weight:900;color:#111827;letter-spacing:.04em;text-transform:uppercase}
.zb-pdf-info-table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:12px}
.zb-pdf-info-table th{background:#f8f9fc;padding:7px 10px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;border:1px solid #e4e8f0}
.zb-pdf-info-table td{padding:7px 10px;border:1px solid #e4e8f0;color:#374151}
.zb-pdf-bill-section{margin-bottom:16px}
.zb-pdf-bill-label{font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.zb-pdf-bill-name{font-size:14px;font-weight:700;color:#2563eb}
.zb-pdf-items{width:100%;border-collapse:collapse;margin-bottom:0}
.zb-pdf-th{padding:8px 10px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;background:#f8f9fc;border-bottom:2px solid #e4e8f0;text-align:left}
.zb-pdf-item-row{border-bottom:1px solid #f1f3f7}
.zb-pdf-item-row:hover{background:#f8f9fc}
.zb-pdf-bottom{display:flex;border-top:2px solid #e4e8f0;margin-top:0}
.zb-pdf-words-block{flex:1;padding:12px 10px;border-right:1px solid #e4e8f0;font-size:11px}
.zb-pdf-words-lbl{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af;margin-bottom:3px}
.zb-pdf-words-val{font-size:11px;color:#374151;line-height:1.5}
.zb-pdf-totals-block{width:240px;padding:8px 12px;display:flex;flex-direction:column;gap:0}
.zb-pdf-total-row{display:flex;justify-content:space-between;font-size:12px;color:#6b7280;padding:4px 0;border-bottom:1px solid #f1f3f7}
.zb-pdf-total-row:last-child{border-bottom:none}
.zb-pdf-total-bold{font-weight:800;font-size:14px;color:#111827;padding:7px 0}
.zb-pdf-balance{font-weight:800;font-size:14px;color:#2563eb;border-top:2px solid #111827!important;padding-top:7px}
.zb-pdf-sig-row{display:flex;justify-content:flex-end;padding:14px 0 6px}
.zb-pdf-sig-box{width:180px;text-align:center;border-top:1px solid #9ca3af;padding-top:5px;font-size:10px;color:#9ca3af}
.zb-pdf-footer{text-align:right;font-size:10px;color:#9ca3af;border-top:1px solid #e4e8f0;padding-top:8px;margin-top:2px}
/* Right panel */
.zb-right-panel{width:260px;flex-shrink:0;border-left:1px solid #e4e8f0;background:#fafbfd;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.zb-panel-card{border:1px solid #e4e8f0;border-radius:8px;padding:12px;background:#fff}
.zb-panel-title{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af;margin-bottom:10px}
.zb-panel-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:12px;color:#6b7280;border-bottom:1px solid #f1f3f7}
.zb-panel-row:last-child{border-bottom:none}
/* Edit form */
.zb-edit-wrap{flex:1;overflow-y:auto;padding:20px 24px;background:#f4f6fa}
.zb-edit-form{max-width:780px;background:#fff;border-radius:10px;padding:24px 28px;box-shadow:0 2px 12px rgba(0,0,0,.06);border:1px solid #e4e8f0}
.zb-form-section-title{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9ca3af;margin-bottom:10px;padding-bottom:7px;border-bottom:1px solid #f1f3f7}
.zb-form-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.zb-form-field{display:flex;flex-direction:column;gap:4px}
.zb-form-label{font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em}
.zb-form-input{padding:7px 10px;border:1px solid #e4e8f0;border-radius:6px;font-size:13px;font-family:inherit;color:#111827;background:#fff;transition:.12s;width:100%;box-sizing:border-box}
.zb-form-input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.zb-items-table{width:100%;border-collapse:collapse;margin-bottom:6px}
.zb-items-table th{font-size:10px;font-weight:700;color:#9ca3af;padding:5px 6px;border-bottom:2px solid #f1f3f7;text-align:left;background:#fafbfd}
.zb-items-table td{padding:4px 3px;border-bottom:1px solid #f1f3f7;vertical-align:middle}
.zb-cell-input{width:100%;border:1px solid transparent;border-radius:4px;padding:4px 6px;font-size:12px;font-family:inherit;background:#fafbfd;transition:.1s;box-sizing:border-box}
.zb-cell-input:focus{outline:none;border-color:#2563eb;background:#fff}
.zb-cell-num{text-align:right;width:70px}
.zb-add-row{background:none;border:none;color:#2563eb;font-size:11px;font-weight:600;cursor:pointer;padding:5px 2px;font-family:inherit}
.zb-edit-totals{display:flex;flex-direction:column;align-items:flex-end;margin-top:14px;padding-top:10px;border-top:1px solid #f1f3f7;gap:5px}
.zb-edit-total-row{display:flex;gap:48px;font-size:12px;color:#6b7280}
.zb-edit-grand{font-size:15px;font-weight:800;color:#111827;padding-top:5px;border-top:2px solid #111827;width:100%;max-width:260px;justify-content:space-between}
/* Cust menu */
.zb-cust-menu-item{display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;padding:9px 14px;font-size:12.5px;font-weight:500;color:#374151;cursor:pointer;font-family:inherit;transition:.1s;text-align:left}
.zb-cust-menu-item:hover{background:#f5f7ff;color:#2563eb}
/* List pane */
.zb-list-pane{width:300px;flex-shrink:0;border-right:1px solid #e4e8f0;background:#fff;display:flex;flex-direction:column;overflow:hidden}
.zb-list-header{padding:12px 12px 0;flex-shrink:0}
.zb-icon-btn{
  width:28px;height:28px;border-radius:6px;
  background:none;border:1.5px solid #e4e8f0;
  cursor:pointer;display:grid;place-items:center;
  color:#6b7280;transition:all .15s;
}
.zb-icon-btn:hover{background:#f5f8ff;border-color:#2563eb;color:#2563eb}
.zb-list-search{display:flex;align-items:center;gap:7px;background:#f8f9fc;border:1px solid #e4e8f0;border-radius:20px;padding:6px 12px;margin-bottom:10px}
.zb-list-search-input{border:none;outline:none;background:none;font-size:12.5px;font-family:inherit;color:#111827;width:100%;caret-color:#2563eb}
.zb-list-search-input::placeholder{color:#9ca3af}
.zb-list-pills{display:flex;gap:5px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid #f1f3f7}
.zb-list-pill{
  padding:4px 11px;border-radius:20px;font-size:11.5px;font-weight:600;
  cursor:pointer;border:1.5px solid #e4e8f0;background:#fff;
  color:#6b7280;font-family:inherit;
  display:inline-flex;align-items:center;gap:5px;
  transition:all .15s;white-space:nowrap;
}
.zb-list-pill:hover{border-color:#2563eb;color:#2563eb;background:#f5f8ff}
.zb-list-pill.active{background:#2563eb;color:#fff;border-color:#2563eb;box-shadow:0 2px 6px rgba(37,99,235,.3)}
.zb-pill-count{
  font-size:10px;font-weight:700;
  padding:1px 5px;border-radius:10px;
  background:rgba(255,255,255,.25);
  min-width:16px;text-align:center;
}
.zb-list-pill:not(.active) .zb-pill-count{background:#f1f3f7;color:#6b7280}
.zb-list-items{flex:1;overflow-y:auto}
.zb-list-item{padding:10px 12px;border-bottom:1px solid #f1f3f7;cursor:pointer;transition:.1s}
.zb-list-item:hover{background:#f8f9fc}
.zb-list-item.selected{background:#eff6ff;border-right:2px solid #2563eb}
.zb-list-item-shimmer{padding:10px 12px;border-bottom:1px solid #f1f3f7}
.zb-list-item-top{display:flex;justify-content:space-between;margin-bottom:3px}
.zb-list-item-name{font-size:13px;font-weight:700;color:#111827}
.zb-list-item-amount{font-size:13px;font-weight:700;font-family:monospace;color:#111827}
.zb-list-item-mid{display:flex;align-items:center;gap:5px;margin-bottom:4px}
.zb-list-item-num{font-size:11px;color:#2563eb;font-weight:600}
.zb-list-item-dot{color:#d1d5db}
.zb-list-item-date{font-size:11px;color:#9ca3af}
.zb-list-item-bot{display:flex;justify-content:space-between}
.zb-list-empty{text-align:center;padding:32px;color:#9ca3af;font-size:13px}
.zb-list-status-tag{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px}
/* Send Email */
.sem-page{position:fixed;inset:0;background:#fff;z-index:9999;display:flex;flex-direction:column;overflow:hidden}
.sem-page-header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid #e4e8f0;background:#fff;flex-shrink:0}
.sem-page-title{font-size:18px;font-weight:700;color:#111827;margin:0}
.sem-back-btn{background:none;border:none;cursor:pointer;color:#6b7280;padding:5px;border-radius:5px;display:flex;align-items:center;transition:.12s}
.sem-back-btn:hover{background:#f5f6f8}
.sem-content{flex:1;overflow-y:auto;display:flex;flex-direction:column}
.sem-error{background:#fef2f2;border-bottom:1px solid #fca5a5;padding:10px 24px;font-size:13px;color:#b91c1c}
.sem-row{display:flex;align-items:center;border-bottom:1px solid #f1f3f7;min-height:48px;padding:0 24px;gap:16px;flex-shrink:0}
.sem-row-tall{align-items:flex-start;padding-top:10px;padding-bottom:10px;min-height:52px}
.sem-row-label{font-size:13px;color:#9ca3af;font-weight:500;width:80px;flex-shrink:0}
.sem-row-value{flex:1;display:flex;align-items:center;gap:8px}
.sem-from-val{color:#374151;font-size:13px;gap:6px}
.sem-row-actions{display:flex;gap:8px}
.sem-link-btn{background:none;border:none;color:#2563eb;font-size:13px;font-weight:600;cursor:pointer;padding:2px 6px;border-radius:4px}
.sem-link-btn:hover{background:#eff6ff}
.sem-chips-wrap{flex:1;display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.sem-chip{display:inline-flex;align-items:center;gap:5px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:20px;padding:3px 10px 3px 8px;font-size:12px;color:#1e40af;font-weight:500}
.sem-chip-remove{background:none;border:none;cursor:pointer;color:#93c5fd;font-size:11px;padding:0;margin-left:2px;line-height:1;transition:.1s}
.sem-chip-remove:hover{color:#dc2626}
.sem-chip-input{border:none;outline:none;font-size:13px;font-family:inherit;color:#111827;min-width:220px;flex:1;padding:2px 0}
.sem-subject-input{flex:1;border:none;outline:none;font-size:14px;font-family:inherit;color:#111827;background:transparent;padding:4px 0}
.sem-toolbar{display:flex;align-items:center;gap:2px;padding:8px 16px;border-bottom:1px solid #e4e8f0;border-top:1px solid #e4e8f0;background:#fafbfd;flex-wrap:wrap;flex-shrink:0}
.sem-tb-btn{background:none;border:1px solid transparent;border-radius:4px;cursor:pointer;color:#374151;padding:4px 7px;font-size:13px;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;min-width:28px;transition:.1s}
.sem-tb-btn:hover{background:#e8eaed;border-color:#d0d3d9}
.sem-tb-sep{width:1px;height:20px;background:#e4e8f0;margin:0 4px}
.sem-tb-select{border:1px solid #e4e8f0;border-radius:4px;font-size:12px;padding:3px 6px;background:#fff;color:#374151;cursor:pointer;font-family:inherit}
.sem-editor{flex:1;border:none;outline:none;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;padding:24px 40px;background:#fafbfd;min-height:400px;overflow-y:auto}
.sem-footer{display:flex;align-items:center;gap:10px;padding:14px 24px;border-top:1px solid #e4e8f0;background:#fff;flex-shrink:0}
.sem-send-btn{display:inline-flex;align-items:center;gap:7px;background:#2563eb;color:#fff;border:none;border-radius:6px;padding:9px 22px;font-size:14px;font-weight:700;cursor:pointer;transition:.12s;font-family:inherit}
.sem-send-btn:hover{background:#1d4ed8}
.sem-send-btn:disabled{opacity:.65;cursor:not-allowed}
.sem-cancel-btn{background:none;border:1px solid #e4e8f0;border-radius:6px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer;color:#374151;transition:.12s;font-family:inherit}
.sem-cancel-btn:hover{background:#f5f6f8}
.sem-send-toggle{position:relative}
.sem-dropdown-menu{position:absolute;top:calc(100% + 4px);left:0;background:#fff;border:1px solid #e4e8f0;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.1);z-index:1000;min-width:140px;padding:4px 0;animation:sem-fade .1s ease}
.sem-dropdown-item{display:flex;align-items:center;gap:10px;width:100%;background:none;border:none;padding:10px 16px;font-size:13px;font-weight:500;color:#374151;cursor:pointer;font-family:inherit;transition:.1s;text-align:left}
.sem-dropdown-item:hover{background:#f5f7ff;color:#2563eb}
@keyframes sem-fade{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
/* Print */
@media print{
  .no-print{display:none!important}
  .zb-master-detail{height:auto!important;overflow:visible!important;display:block!important}
  .zb-list-pane{display:none!important}
  .zb-detail-area{display:block!important;overflow:visible!important}
  .zb-pdf-wrap{background:#fff!important;padding:0!important;overflow:visible!important;display:block!important}
  .zb-pdf-paper{box-shadow:none!important;max-width:100%!important;padding:20px!important}
  .zb-right-panel{display:none!important}
}
.b-quick-actions{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.b-shimmer{background:linear-gradient(90deg,#f1f3f7 25%,#e4e8f0 50%,#f1f3f7 75%);background-size:200% 100%;animation:shimmer 1.4s infinite;border-radius:4px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
/* Hamburger */
.b-hamburger{display:none;background:none;border:none;cursor:pointer;color:#374151;padding:4px;border-radius:5px;align-items:center;justify-content:center;transition:background .15s}
.b-hamburger:hover{background:#f1f3f7}
.b-mob-close{display:none;background:none;border:none;cursor:pointer;color:rgba(255,255,255,.5);font-size:16px;margin-left:auto;padding:4px 6px;border-radius:4px;transition:.15s}
.b-mob-close:hover{color:#fff;background:rgba(255,255,255,.1)}
.b-mob-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:49;backdrop-filter:blur(1px)}
/* Collapsed */
.books-root.collapsed .b-brand-info{opacity:0;width:0;pointer-events:none}
.books-root.collapsed .b-nav-label{opacity:0;width:0;pointer-events:none}
.books-root.collapsed .b-nav-section{opacity:0;height:0;padding:0;margin:0;overflow:hidden}
.books-root.collapsed .b-nav-badge{display:none}
.books-root.collapsed .b-user-info{opacity:0;width:0;overflow:hidden;pointer-events:none}
.books-root.collapsed .b-collapse-btn{justify-content:center}
.books-root.collapsed .b-nav-item{justify-content:center;padding:10px}
.books-root.collapsed .b-nav-icon{margin:0}
.books-root.collapsed .b-logout-btn{justify-content:center}
/* Responsive */
@media(max-width:900px){.b-kpi-grid{grid-template-columns:repeat(2,1fr)!important}.b-mid-grid{grid-template-columns:1fr!important}}
@media(max-width:640px){
  .b-hamburger{display:inline-flex!important}.b-mob-close{display:block!important}
  .books-root{grid-template-columns:1fr!important}
  .b-sidebar{position:fixed;left:-240px;top:0;bottom:0;z-index:50;width:240px!important;transition:left .25s ease}
  .books-root.mobile-open .b-sidebar{left:0!important;box-shadow:4px 0 24px rgba(0,0,0,.25)}
  .books-root.mobile-open .b-mob-overlay{display:block!important}
  .b-right{width:100vw}.b-topbar{padding:0 14px}.b-search{display:none}
  .b-main{padding:14px}.b-kpi-grid{grid-template-columns:1fr 1fr!important;gap:10px}
  .zb-th:nth-child(3),.zb-td:nth-child(3),.zb-th:nth-child(4),.zb-td:nth-child(4){display:none}
  .zb-list-pane{width:100%!important}.zb-detail-area{display:none!important}.zb-master-detail{flex-direction:column}
}
@media(max-width:400px){.b-kpi-grid{grid-template-columns:1fr!important}}
`;

  if (!document.getElementById("books-modal-css")) {
    const s = document.createElement("style"); s.id = "books-modal-css"; s.textContent = modalCSS;
    document.head.appendChild(s);
  }

  /* ── Template Editor ── */
  const TemplateEditor = defineComponent({
    name: "TemplateEditor",
    setup() {
      const router = useRouter();
      const activeTab = ref("general");
      const saving = ref(false);
      const saveMsg = ref("");
      const previewHtml = ref("");
      const loadingPreview = ref(false);
      const logoUrl = ref("");
      const upiId = ref("");
      const showUpiQr = ref(true);
      const primaryColor = ref("#2563EB");
      const fontFamily = ref("Inter");
      const paperSize = ref("A4");
      const orientation = ref("Portrait");
      const margins = reactive({ top: "0.7", bottom: "0.7", left: "0.55", right: "0.4" });
      const templateName = ref("Tax Invoice");
      const showLogo = ref(true);
      const showSignature = ref(true);
      const showTerms = ref(true);
      const showNotes = ref(true);
      const headerTitle = ref("TAX INVOICE");
      const footerText = ref("Thanks for your business.");
      const tableColumns = reactive({ qty: true, rate: true, amount: true, hsn: true, discount: false, tax: false });

      const tabs = [
        { key: "general", label: "General", icon: "⚙" },
        { key: "header", label: "Header & Footer", icon: "📋" },
        { key: "transaction", label: "Transaction Details", icon: "📄" },
        { key: "table", label: "Table", icon: "⊞" },
        { key: "total", label: "Total", icon: "∑" },
        { key: "other", label: "Other Details", icon: "⋯" },
      ];

      async function loadSettings() {
        try {
          const r = await fetch("/api/method/frappe.client.get?doctype=Print+Format&name=Tax+Invoice", { credentials: "same-origin" });
          const d = await r.json();
          const pf = d.message || {};
          // parse stored meta if any
          if (pf.custom_format_meta) {
            try {
              const m = JSON.parse(pf.custom_format_meta);
              if (m.primaryColor) primaryColor.value = m.primaryColor;
              if (m.fontFamily) fontFamily.value = m.fontFamily;
              if (m.upiId) upiId.value = m.upiId;
              if (m.showUpiQr != null) showUpiQr.value = m.showUpiQr;
              if (m.showLogo != null) showLogo.value = m.showLogo;
              if (m.headerTitle) headerTitle.value = m.headerTitle;
              if (m.footerText) footerText.value = m.footerText;
            } catch (e) { }
          }
        } catch (e) { }
        refreshPreview();
      }

      async function refreshPreview() {
        loadingPreview.value = true;
        try {
          // Render using a real invoice if available, else use mock
          const r = await fetch("/api/method/frappe.client.get_list?doctype=Sales+Invoice&limit=1&fields=[%22name%22]", { credentials: "same-origin" });
          const d = await r.json();
          const invName = (d.message && d.message[0]) ? d.message[0].name : null;
          if (invName) {
            const pr = await fetch(`/api/method/frappe.www.printview.get_html_and_style?doc=${encodeURIComponent(invName)}&print_format=Tax+Invoice&_lang=en`, { credentials: "same-origin" });
            if (pr.ok) {
              const pd = await pr.json();
              previewHtml.value = (pd.message && pd.message.html) || previewHtml.value;
            }
          }
        } catch (e) { }
        loadingPreview.value = false;
      }

      async function saveTemplate() {
        saving.value = true;
        saveMsg.value = "";
        try {
          const meta = { primaryColor: primaryColor.value, fontFamily: fontFamily.value, upiId: upiId.value, showUpiQr: showUpiQr.value, showLogo: showLogo.value, headerTitle: headerTitle.value, footerText: footerText.value };
          // Save meta to Print Format description field
          const body = new FormData();
          body.append("cmd", "frappe.client.set_value");
          body.append("doctype", "Print Format");
          body.append("name", "Tax Invoice");
          body.append("fieldname", "description");
          body.append("value", JSON.stringify(meta));
          body.append("csrf_token", window.frappe?.csrf_token || "");
          await fetch("/api/method/frappe.client.set_value", { method: "POST", credentials: "same-origin", body });
          // Trigger server-side rebuild of HTML
          const rb = new FormData();
          rb.append("cmd", "zoho_books_clone.books_setup.install.seed_print_formats");
          rb.append("csrf_token", window.frappe?.csrf_token || "");
          await fetch("/api/method/zoho_books_clone.books_setup.install.seed_print_formats", { method: "POST", credentials: "same-origin", body: rb });
          saveMsg.value = "✓ Saved";
          setTimeout(() => saveMsg.value = "", 3000);
        } catch (e) { saveMsg.value = "Error saving"; }
        saving.value = false;
      }

      function close() { router.push("/invoices"); }

      onMounted(loadSettings);

      return { activeTab, tabs, saving, saveMsg, previewHtml, loadingPreview, logoUrl, upiId, showUpiQr, primaryColor, fontFamily, paperSize, orientation, margins, templateName, showLogo, showSignature, showTerms, showNotes, headerTitle, footerText, tableColumns, saveTemplate, close, refreshPreview };
    },
    template: `
<div style="display:flex;flex-direction:column;height:100vh;background:#f0f2f5;overflow:hidden">
  <!-- Top Bar -->
  <div style="display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:52px;background:#fff;border-bottom:1px solid #e5e7eb;flex-shrink:0">
    <span style="font-size:15px;font-weight:600;color:#111">Edit Template</span>
    <div style="display:flex;align-items:center;gap:10px">
      <button @click="refreshPreview" style="display:flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font-size:12.5px;cursor:pointer;color:#374151;font-weight:500">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        Refresh Preview
      </button>
      <span v-if="saveMsg" style="font-size:12px;color:#16a34a;font-weight:600">{{saveMsg}}</span>
      <button @click="saveTemplate" :disabled="saving" style="padding:6px 20px;background:#2563EB;color:#fff;border:none;border-radius:6px;font-size:12.5px;font-weight:600;cursor:pointer">
        {{saving?'Saving…':'Save'}}
      </button>
      <button @click="close" style="width:30px;height:30px;border:none;background:transparent;cursor:pointer;font-size:18px;color:#6b7280;display:flex;align-items:center;justify-content:center">✕</button>
    </div>
  </div>

  <!-- Body -->
  <div style="display:flex;flex:1;overflow:hidden">

    <!-- Left Panel -->
    <div style="width:280px;flex-shrink:0;background:#fff;border-right:1px solid #e5e7eb;display:flex;flex-direction:column;overflow:hidden">
      <!-- Tab Icons -->
      <div style="display:flex;flex-direction:column;width:64px;background:#f8fafc;border-right:1px solid #e5e7eb;flex-shrink:0;position:absolute;height:calc(100vh - 52px)">
        <button v-for="t in tabs" :key="t.key" @click="activeTab=t.key"
          :style="{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'14px 4px',border:'none',cursor:'pointer',background:activeTab===t.key?'#eff6ff':'transparent',color:activeTab===t.key?'#2563EB':'#6b7280',borderLeft:activeTab===t.key?'3px solid #2563EB':'3px solid transparent',gap:'4px',width:'100%'}">
          <span style="font-size:16px">{{t.icon}}</span>
          <span style="font-size:9px;font-weight:600;text-align:center;line-height:1.2;letter-spacing:.3px">{{t.label.split(' ')[0]}}</span>
        </button>
      </div>

      <!-- Panel Content -->
      <div style="margin-left:64px;flex:1;overflow-y:auto;padding:16px">

        <!-- GENERAL -->
        <template v-if="activeTab==='general'">
          <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #e5e7eb">Template Properties</div>
          <div style="margin-bottom:14px">
            <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:5px">Template Name *</label>
            <input v-model="templateName" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12.5px;outline:none"/>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:5px">Paper Size</label>
            <div style="display:flex;gap:12px">
              <label v-for="s in ['A5','A4','Letter']" :key="s" style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
                <input type="radio" v-model="paperSize" :value="s"> {{s}}
              </label>
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:5px">Orientation</label>
            <div style="display:flex;gap:12px">
              <label v-for="o in ['Portrait','Landscape']" :key="o" style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
                <input type="radio" v-model="orientation" :value="o"> {{o}}
              </label>
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:8px">Margins (in inches)</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div v-for="m in ['top','bottom','left','right']" :key="m">
                <label style="font-size:10px;color:#6b7280;text-transform:capitalize">{{m}}</label>
                <input v-model="margins[m]" type="number" step="0.05" style="width:100%;padding:5px 8px;border:1px solid #d1d5db;border-radius:5px;font-size:12px;margin-top:2px"/>
              </div>
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:5px">Primary Color</label>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="color" v-model="primaryColor" style="width:36px;height:32px;border:1px solid #d1d5db;border-radius:4px;cursor:pointer;padding:2px"/>
              <input v-model="primaryColor" style="flex:1;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"/>
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:5px">Font Family</label>
            <select v-model="fontFamily" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12.5px">
              <option>Inter</option><option>DM Sans</option><option>Poppins</option><option>Roboto</option><option>Arial</option>
            </select>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:500;color:#374151">
              <input type="checkbox" v-model="showUpiQr" style="width:15px;height:15px">
              Include Payment Stub (UPI QR)
            </label>
          </div>
        </template>

        <!-- HEADER & FOOTER -->
        <template v-if="activeTab==='header'">
          <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #e5e7eb">Header & Footer</div>
          <div style="margin-bottom:14px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:500;color:#374151;margin-bottom:10px">
              <input type="checkbox" v-model="showLogo" style="width:15px;height:15px">
              Show Company Logo
            </label>
            <div v-if="showLogo" style="border:2px dashed #d1d5db;border-radius:8px;padding:20px;text-align:center;background:#f9fafb">
              <div style="font-size:11px;color:#6b7280;margin-bottom:8px">Upload your company logo</div>
              <div style="font-size:10px;color:#9ca3af">Go to: Settings → Company → Upload Logo</div>
              <div v-if="logoUrl" style="margin-top:8px"><img :src="logoUrl" style="max-height:50px;max-width:140px"/></div>
              <div v-else style="margin-top:8px;font-size:10px;color:#2563EB">Logo will appear from Company settings</div>
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:5px">Invoice Title</label>
            <input v-model="headerTitle" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12.5px"/>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:5px">Footer Text</label>
            <textarea v-model="footerText" rows="3" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12.5px;resize:vertical"></textarea>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:500;color:#374151">
              <input type="checkbox" v-model="showSignature" style="width:15px;height:15px">
              Show Authorized Signature line
            </label>
          </div>
        </template>

        <!-- TRANSACTION DETAILS -->
        <template v-if="activeTab==='transaction'">
          <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #e5e7eb">Transaction Details</div>
          <div style="background:#eff6ff;border-radius:8px;padding:12px;margin-bottom:14px;font-size:12px;color:#1e40af">
            These fields appear in the header info table on the invoice.
          </div>
          <div v-for="field in ['Invoice #','Invoice Date','Terms','Due Date','P.O. #']" :key="field" style="margin-bottom:10px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;color:#374151">
              <input type="checkbox" checked style="width:14px;height:14px"> {{field}}
            </label>
          </div>
        </template>

        <!-- TABLE -->
        <template v-if="activeTab==='table'">
          <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #e5e7eb">Table Columns</div>
          <div v-for="(val,key) in tableColumns" :key="key" style="margin-bottom:10px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;color:#374151;text-transform:capitalize">
              <input type="checkbox" v-model="tableColumns[key]" style="width:14px;height:14px"> {{key==='qty'?'Quantity':key==='hsn'?'HSN Code':key.charAt(0).toUpperCase()+key.slice(1)}}
            </label>
          </div>
        </template>

        <!-- TOTAL -->
        <template v-if="activeTab==='total'">
          <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #e5e7eb">Total Section</div>
          <div v-for="f in ['Sub Total','Tax Amount','Grand Total','Balance Due','Total in Words']" :key="f" style="margin-bottom:10px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;color:#374151">
              <input type="checkbox" checked style="width:14px;height:14px"> {{f}}
            </label>
          </div>
          <div style="margin-top:16px;padding-top:14px;border-top:1px solid #e5e7eb">
            <div style="font-size:11px;font-weight:600;color:#374151;margin-bottom:10px">UPI QR Code</div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:500;color:#374151;margin-bottom:10px">
              <input type="checkbox" v-model="showUpiQr" style="width:15px;height:15px"> Show UPI QR Code
            </label>
            <div v-if="showUpiQr">
              <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:5px">UPI ID</label>
              <input v-model="upiId" placeholder="yourname@upi" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12.5px"/>
              <div style="font-size:10px;color:#6b7280;margin-top:4px">e.g. business@okicici, 9876543210@paytm</div>
            </div>
          </div>
        </template>

        <!-- OTHER -->
        <template v-if="activeTab==='other'">
          <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #e5e7eb">Other Details</div>
          <div v-for="f in ['Notes','Terms & Conditions','Ship To Address','GSTIN']" :key="f" style="margin-bottom:10px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;color:#374151">
              <input type="checkbox" checked style="width:14px;height:14px"> {{f}}
            </label>
          </div>
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid #e5e7eb">
            <label style="display:block;font-size:11px;font-weight:600;color:#374151;margin-bottom:5px">Background Color</label>
            <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:6px">
              <div v-for="c in ['#ffffff','#f8fafc','#f0f9ff','#f0fdf4','#fff7ed']" :key="c"
                :style="{width:'100%',aspectRatio:'1',background:c,borderRadius:'6px',border:'2px solid #e5e7eb',cursor:'pointer'}">
              </div>
            </div>
          </div>
        </template>

      </div>
    </div>

    <!-- Right Preview -->
    <div style="flex:1;overflow-y:auto;background:#e5e7eb;padding:24px;display:flex;flex-direction:column;align-items:center">
      <div style="font-size:11px;color:#6b7280;margin-bottom:12px;text-transform:uppercase;letter-spacing:.8px;font-weight:600">Live Preview</div>
      <div v-if="loadingPreview" style="display:flex;align-items:center;justify-content:center;height:200px;color:#6b7280;font-size:13px">
        Loading preview…
      </div>
      <div v-else :style="{width:'100%',maxWidth:'794px',background:'#fff',borderRadius:'4px',boxShadow:'0 4px 24px rgba(0,0,0,.12)',minHeight:'1000px',overflow:'hidden',fontFamily:fontFamily}">
        <div v-if="previewHtml" v-html="previewHtml" style="width:100%"></div>
        <div v-else style="padding:48px 40px">
          <!-- Static preview matching Zoho style -->
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px">
            <div>
              <div v-if="showLogo" style="width:140px;height:52px;border:2px dashed #d1d5db;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#9ca3af;margin-bottom:8px">Your Logo</div>
              <div style="font-size:14px;font-weight:600;color:#111">{{$root?$root.companyName||'Company Name':'Company Name'}}</div>
              <div style="font-size:11px;color:#6b7280;margin-top:2px">Tamil Nadu, India</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#9ca3af;margin-bottom:4px">Tax Invoice</div>
              <div :style="{fontSize:'22px',fontWeight:'700',color:primaryColor,marginBottom:'12px'}">{{headerTitle}}</div>
              <table style="margin-left:auto;border-collapse:collapse">
                <tr v-for="r in [['Invoice Date','18 Mar 2026'],['Due Date','18 Mar 2026'],['Terms','Due on Receipt']]" :key="r[0]">
                  <td style="padding:2px 0 2px 16px;font-size:11.5px;color:#9ca3af">{{r[0]}}</td>
                  <td style="padding:2px 0 2px 16px;font-size:11.5px;font-weight:500;color:#111">{{r[1]}}</td>
                </tr>
              </table>
            </div>
          </div>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 20px"/>
          <div style="margin-bottom:20px">
            <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;margin-bottom:4px">Bill To</div>
            <div style="font-size:14px;font-weight:600;color:#111">Customer Name</div>
            <div style="font-size:12px;color:#6b7280">Chennai, Tamil Nadu</div>
          </div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
            <thead>
              <tr :style="{background:primaryColor}">
                <th style="padding:10px 14px;font-size:11px;font-weight:600;color:#fff;text-align:left">#</th>
                <th style="padding:10px 14px;font-size:11px;font-weight:600;color:#fff;text-align:left">Item &amp; Description</th>
                <th v-if="tableColumns.qty" style="padding:10px 14px;font-size:11px;font-weight:600;color:#fff;text-align:right">Qty</th>
                <th v-if="tableColumns.rate" style="padding:10px 14px;font-size:11px;font-weight:600;color:#fff;text-align:right">Rate</th>
                <th v-if="tableColumns.amount" style="padding:10px 14px;font-size:11px;font-weight:600;color:#fff;text-align:right">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="padding:11px 14px;font-size:13px;color:#374151;border-bottom:1px solid #f2f4f7">1</td>
                <td style="padding:11px 14px;font-size:13px;color:#374151;border-bottom:1px solid #f2f4f7"><div style="font-weight:500">Sample Item</div><div style="font-size:11px;color:#9ca3af">Item description</div></td>
                <td v-if="tableColumns.qty" style="padding:11px 14px;font-size:13px;color:#374151;border-bottom:1px solid #f2f4f7;text-align:right">1.00</td>
                <td v-if="tableColumns.rate" style="padding:11px 14px;font-size:13px;color:#374151;border-bottom:1px solid #f2f4f7;text-align:right">₹5,000.00</td>
                <td v-if="tableColumns.amount" style="padding:11px 14px;font-size:13px;color:#374151;border-bottom:1px solid #f2f4f7;text-align:right">₹5,000.00</td>
              </tr>
            </tbody>
          </table>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px">
            <div v-if="showUpiQr" style="text-align:center;padding:12px 16px;background:#f8fafc;border-radius:8px;border:1px solid #e5e7eb;min-width:130px">
              <div style="font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#9ca3af;margin-bottom:8px">Pay via UPI</div>
              <div style="width:100px;height:100px;background:#e5e7eb;border-radius:4px;margin:0 auto 6px;display:flex;align-items:center;justify-content:center">
                <svg width="60" height="60" viewBox="0 0 60 60" fill="none"><rect x="2" y="2" width="20" height="20" rx="2" stroke="#374151" stroke-width="2"/><rect x="6" y="6" width="12" height="12" fill="#374151"/><rect x="38" y="2" width="20" height="20" rx="2" stroke="#374151" stroke-width="2"/><rect x="42" y="6" width="12" height="12" fill="#374151"/><rect x="2" y="38" width="20" height="20" rx="2" stroke="#374151" stroke-width="2"/><rect x="6" y="42" width="12" height="12" fill="#374151"/><rect x="28" y="28" width="4" height="4" fill="#374151"/><rect x="34" y="28" width="4" height="4" fill="#374151"/><rect x="40" y="28" width="4" height="4" fill="#374151"/><rect x="28" y="34" width="4" height="4" fill="#374151"/><rect x="40" y="34" width="4" height="4" fill="#374151"/><rect x="28" y="40" width="4" height="4" fill="#374151"/><rect x="34" y="40" width="4" height="4" fill="#374151"/><rect x="40" y="40" width="4" height="4" fill="#374151"/><rect x="46" y="34" width="4" height="4" fill="#374151"/><rect x="46" y="46" width="4" height="4" fill="#374151"/><rect x="34" y="46" width="4" height="4" fill="#374151"/></svg>
              </div>
              <div style="font-size:10px;color:#6b7280">{{upiId||'yourname@upi'}}</div>
            </div>
            <div style="flex:1;max-width:260px;margin-left:auto">
              <div style="display:flex;justify-content:space-between;padding:7px 0;font-size:13px;border-top:1px solid #e5e7eb"><span style="color:#6b7280">Sub Total</span><span>₹5,000.00</span></div>
              <div style="display:flex;justify-content:space-between;padding:9px 0;font-size:15px;font-weight:700;border-top:2px solid #e5e7eb"><span>Total</span><span>₹5,000.00</span></div>
              <div style="display:flex;justify-content:space-between;padding:8px;font-size:13px;font-weight:600;background:#fff5f5;border-radius:4px;margin-top:4px"><span style="color:#dc2626">Balance Due</span><span style="color:#dc2626">₹5,000.00</span></div>
            </div>
          </div>
          <div v-if="showSignature" style="display:flex;justify-content:flex-end;margin-top:32px">
            <div style="text-align:center">
              <div style="width:160px;border-top:1px solid #d1d5db;padding-top:6px">
                <div style="font-size:11px;color:#9ca3af">Authorized Signature</div>
              </div>
            </div>
          </div>
          <div style="text-align:center;margin-top:20px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;font-weight:600;color:#374151">{{footerText}}</div>
        </div>
      </div>
    </div>

  </div>
</div>`
  });

  /* ── Boot ── */
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: "/", component: Dashboard, name: "dashboard" },
      { path: "/invoices", component: Invoices, name: "invoices" },
      { path: "/invoices/:name", component: InvoiceDetail, name: "invoice-detail" },
      { path: "/template-editor", component: TemplateEditor, name: "template-editor" },
      { path: "/purchases", component: Purchases, name: "purchases" },
      { path: "/payments", component: Payments, name: "payments" },
      { path: "/banking", component: Banking, name: "banking" },
      { path: "/accounts", component: Accounts, name: "accounts" },
      { path: "/reports", component: Reports, name: "reports" },
    ]
  });


  function getCsrfFromCookie() {
    const m = document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("csrf_token="));
    return m ? decodeURIComponent(m.split("=").slice(1).join("=")) : "";
  }

  function getCsrfFromMeta() {
    // Frappe injects <meta name="csrf-token" content="..."> into every page
    const meta = document.querySelector("meta[name='csrf-token']");
    return meta ? meta.getAttribute("content") : "";
  }

  async function bootstrapCsrf() {
    if (!window.frappe) window.frappe = { session: {}, boot: { sysdefaults: { company: "" } } };

    // Step 1: Already set by Frappe's own JS (most reliable — Frappe sets window.frappe.csrf_token on page load)
    if (window.frappe.csrf_token && window.frappe.csrf_token !== "None" && window.frappe.csrf_token !== "{{ csrf_token }}") {
      return window.frappe.csrf_token;
    }

    // Step 2: Meta tag — Frappe injects this on every page
    const fromMeta = getCsrfFromMeta();
    if (fromMeta && fromMeta !== "None") {
      window.frappe.csrf_token = fromMeta;
      return fromMeta;
    }

    // Step 3: Cookie fallback
    const fromCookie = getCsrfFromCookie();
    if (fromCookie && fromCookie !== "None") {
      window.frappe.csrf_token = fromCookie;
      return fromCookie;
    }

    // Step 4: Fetch from our session endpoint (GET — no CSRF needed)
    try {
      const r = await fetch("/api/method/zoho_books_clone.api.session.get_books_session", {
        method: "GET", credentials: "same-origin",
        headers: { "Accept": "application/json" }
      });
      if (!r.ok) {
        window.location.href = "/login?redirect-to=/books";
        return "";
      }
      const data = await r.json();
      const msg = data.message || {};
      if (msg.csrf_token && msg.csrf_token !== "None") {
        window.frappe.csrf_token = msg.csrf_token;
      }
      if (msg.user) window.frappe.session.user = msg.user;
      if (msg.company) {
        window.__booksCompany = msg.company;
        window.frappe.boot.sysdefaults.company = msg.company;
      }
      if (window.frappe.csrf_token && window.frappe.csrf_token !== "None") {
        return window.frappe.csrf_token;
      }
    } catch (e) { console.warn("[Books] Session fetch failed:", e.message); }

    // Step 5: Try Frappe's built-in /api/method/frappe.auth.get_logged_user as a last resort
    try {
      const r2 = await fetch("/api/method/frappe.client.get_value?doctype=User&filters=%7B%22name%22%3A%22session%22%7D&fieldname=%5B%22name%22%5D", {
        credentials: "same-origin", headers: { "Accept": "application/json" }
      });
      const hdr = r2.headers.get("X-Frappe-CSRF-Token");
      if (hdr && hdr !== "None") {
        window.frappe.csrf_token = hdr;
        return hdr;
      }
    } catch {}

    console.warn("[Books] CSRF token not found — read operations will work but POSTs may fail");
    return "";
  }

  bootstrapCsrf().then(() => {
    createApp(App).use(router).mount("#books-app");
  });

})();
