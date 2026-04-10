(function () {
  "use strict";
  if (!document.getElementById("books-app")) return;
  if (typeof Vue === "undefined" || typeof VueRouter === "undefined") {
    console.error("[Books] Vue/VueRouter not loaded"); return;
  }

  const { createApp, ref, computed, onMounted, onUnmounted, reactive, watch, defineComponent, nextTick } = Vue;
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
      // Frappe double-escapes the traceback as a JSON-encoded list, so literal \n
      // and \" survive the outer JSON.parse.  Normalise them before matching.
      const excStr = (json.exc || "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
      // Capture just the human-readable part after "frappe.exceptions.SomeError: "
      const match = excStr.match(/frappe\.exceptions\.\w+:\s*([^\n]+)/);
      if (match && match[1].trim()) {
        throw new Error(match[1].trim());
      }
      // Fall back to _server_messages (Frappe puts user-facing messages here)
      if (json._server_messages) {
        try {
          const msgs = JSON.parse(json._server_messages);
          const first = Array.isArray(msgs) ? msgs[0] : msgs;
          const text = (typeof first === "object" ? first.message : String(first) || "")
            .replace(/\\n/g, "").replace(/\\"/g, '"').replace(/^\s+|\s+$/g, "");
          if (text) throw new Error(text);
        } catch (inner) {
          if (inner instanceof Error && !inner.message.startsWith("{")) throw inner;
        }
      }
      throw new Error(json.exc_type || json.message || "Server error " + status);
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

  /* Refresh CSRF token — always fetches fresh from session endpoint */
  async function refreshCsrfToken() {
    // 1. Try meta tag first (cheapest, set by Frappe on page load)
    const meta = document.querySelector("meta[name='csrf-token']");
    if (meta) {
      const t = meta.getAttribute("content");
      if (t && t !== "None" && t !== "{{ csrf_token }}") {
        if (window.frappe) window.frappe.csrf_token = t;
        return t;
      }
    }
    // 2. Try window.frappe.csrf_token if already set and valid
    if (window.frappe?.csrf_token &&
      window.frappe.csrf_token !== "None" &&
      window.frappe.csrf_token !== "{{ csrf_token }}") {
      return window.frappe.csrf_token;
    }
    // 3. Try cookie
    const ck = document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("csrf_token="));
    if (ck) {
      const t = decodeURIComponent(ck.split("=").slice(1).join("="));
      if (t && t !== "None") {
        if (window.frappe) window.frappe.csrf_token = t;
        return t;
      }
    }
    // 4. Fetch fresh from session endpoint
    try {
      const r = await fetch("/api/method/zoho_books_clone.api.session.get_books_session", {
        method: "GET", credentials: "same-origin",
        headers: { "Accept": "application/json" }
      });
      const data = await r.json();
      const token = data?.message?.csrf_token;
      if (token && token !== "None") {
        if (window.frappe) window.frappe.csrf_token = token;
        return token;
      }
    } catch { }
    return "";
  }

  /* POST — reuses cached token when valid; fetches fresh only when needed */
  async function apiPOST(method, args) {
    const csrfToken = await refreshCsrfToken();

    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(args || {})) {
      body.append(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    // Send CSRF both ways: Frappe checks either header OR body param
    if (csrfToken) body.append("csrf_token", csrfToken);

    const r = await fetch("/api/method/" + method, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Frappe-CSRF-Token": csrfToken || "",
        "Accept": "application/json",
      },
      body: body.toString(),
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
    // Use POST so the JSON payload doesn't blow the URL length limit
    return await apiPOST("zoho_books_clone.api.docs.save_doc", { doc: JSON.stringify(doc) });
  }

  async function apiSubmit(doctype, name) {
    // Use our custom GET endpoint — no CSRF token needed
    return await apiGET("zoho_books_clone.api.docs.submit_doc", { doctype, name });
  }

  async function apiDelete(doctype, name) {
    return await apiGET("zoho_books_clone.api.docs.delete_doc", { doctype, name });
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
    users: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    quote: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    order: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    recurring: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    creditnote: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
    truck: '<rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    vendors: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    fileplus: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
    payment: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>',
    rupee: '<path d="M18 7H6M18 11H6M12 7v10M6 11c0 3.31 2.69 6 6 6s6-2.69 6-6"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    coa: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    journal: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
    opening: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    costcenter: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
    fiscal: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M17 12h.01M7 12h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    cancel: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    chevD: '<polyline points="6 9 12 15 18 9"/>',
    chevR: '<polyline points="9 18 15 12 9 6"/>',
    chevL: '<polyline points="15 18 9 12 15 6"/>',
    chevU: '<polyline points="18 15 12 9 6 15"/>',
    balance: '<path d="M12 3v18M3 9l9-6 9 6M3 15l9 6 9-6"/>',
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
     SEARCHABLE SELECT — reusable autocomplete dropdown
     Props:
       modelValue  — bound value (v-model)
       options     — Array of strings | {name} | {value,label} | custom
       valueKey    — field used as value (default "name", fallback "value")
       labelKey    — field shown as label (default "name", fallback "label")
       placeholder — empty-state text
       compact     — true for table-cell mode (smaller padding)
       disabled    — disables interaction
     Emits: update:modelValue
  ═══════════════════════════════════════════════════════════════ */
  const SearchableSelect = defineComponent({
    name: "SearchableSelect",
    props: {
      modelValue: { default: "" },
      options:    { type: Array, default: () => [] },
      valueKey:   { type: String, default: "" },
      labelKey:   { type: String, default: "" },
      placeholder:{ type: String, default: "— Select —" },
      compact:    { type: Boolean, default: false },
      disabled:   { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      const q        = ref("");
      const open     = ref(false);
      const inputEl  = ref(null);
      const trigEl   = ref(null);           // the visible trigger button
      const dropStyle= ref({});             // fixed-position style for teleported drop

      // Normalise any option shape → {value, label}
      const normalized = computed(() => {
        const vk = props.valueKey;
        const lk = props.labelKey;
        return (props.options || []).map(o => {
          if (typeof o === "string") return { value: o, label: o };
          const v = vk ? o[vk] : (o.value !== undefined ? o.value : (o.name !== undefined ? o.name : String(o)));
          const l = lk ? o[lk] : (o.label !== undefined ? o.label : (o.name !== undefined ? o.name : String(o)));
          return { value: v ?? "", label: l ?? v ?? "" };
        });
      });

      const displayLabel = computed(() => {
        if (!props.modelValue && props.modelValue !== 0) return "";
        const found = normalized.value.find(o => String(o.value) === String(props.modelValue));
        return found ? found.label : props.modelValue;
      });

      // Prefix-priority + contains fallback
      const filtered = computed(() => {
        const qv = q.value.toLowerCase().trim();
        if (!qv) return normalized.value.slice(0, 150);
        const pre = [], con = [];
        normalized.value.forEach(o => {
          const l = String(o.label || "").toLowerCase();
          if (l.startsWith(qv)) pre.push(o);
          else if (l.includes(qv)) con.push(o);
        });
        return [...pre, ...con].slice(0, 100);
      });

      // Calculate fixed position from the trigger's bounding rect
      function calcDropStyle() {
        if (!trigEl.value) return;
        const r = trigEl.value.getBoundingClientRect();
        const spaceBelow = window.innerHeight - r.bottom;
        const goUp = spaceBelow < 260 && r.top > 260;
        dropStyle.value = {
          position: "fixed",
          left:  r.left  + "px",
          width: r.width + "px",
          zIndex: 99999,
          ...(goUp ? { bottom: (window.innerHeight - r.top + 4) + "px" }
                   : { top:    (r.bottom + 4) + "px" })
        };
      }

      function openDD() {
        if (props.disabled) return;
        calcDropStyle();
        open.value = true;
        q.value = "";
        nextTick(() => inputEl.value && inputEl.value.focus());
      }

      function pick(opt) {
        emit("update:modelValue", opt.value);
        open.value = false;
        q.value = "";
      }

      // Close on outside pointer-down (teleported drop included)
      function onDoc(e) {
        if (!open.value) return;
        const trig = trigEl.value;
        const drop = document.querySelector(".ss-drop-teleport");
        if (trig && !trig.contains(e.target) && drop && !drop.contains(e.target)) {
          open.value = false;
        }
      }

      onMounted(() => document.addEventListener("pointerdown", onDoc, true));
      onUnmounted(() => document.removeEventListener("pointerdown", onDoc, true));

      return { q, open, inputEl, trigEl, dropStyle, displayLabel, filtered, openDD, pick, icon };
    },
    template: `
<div class="ss-wrap">
  <div ref="trigEl" class="ss-trigger"
    :class="{'open': open, 'ss-disabled': disabled, 'ss-compact': compact}"
    @click="openDD" tabindex="0"
    @keydown.enter.prevent="openDD"
    @keydown.space.prevent="openDD">
    <span class="ss-display" :class="{'ss-ph': !modelValue && modelValue !== 0}">
      {{(modelValue || modelValue === 0) ? displayLabel : placeholder}}
    </span>
    <span class="ss-caret" v-html="icon('chevD',11)"></span>
  </div>
  <teleport to="body">
    <div v-if="open" class="ss-drop ss-drop-teleport" :style="dropStyle">
      <div class="ss-search-row">
        <input ref="inputEl" v-model="q" class="ss-search-input"
          placeholder="Type to search…"
          @keydown.escape="open=false"
          @keydown.enter.prevent="filtered.length && pick(filtered[0])"/>
      </div>
      <div class="ss-opts">
        <div v-if="!filtered.length" class="ss-no-match">
          {{normalized.length ? 'No matches for "'+q+'"' : 'No options available'}}
        </div>
        <div v-for="o in filtered" :key="o.value"
          class="ss-opt" :class="{'ss-opt-sel': String(o.value)===String(modelValue)}"
          @mousedown.prevent="pick(o)">
          {{o.label}}
        </div>
      </div>
    </div>
  </teleport>
</div>`
  });

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
      const allItems = ref([]);
      const accounts_ar = ref([]);
      const accounts_income = ref([]);
      const taxTemplates = ref([]);

      const form = reactive({
        naming_series: "INV-.YYYY.-.#####",
        customer: "", customer_name: "",
        posting_date: today(), due_date: today(),
        currency: "INR",
        debit_to: "", income_account: "",
        source_name: "", source_type: "",
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
        // Query AR and Income accounts via our robust wrapper
        try {
          const accs = await apiGET("zoho_books_clone.api.docs.get_accounts", { company: form.company });
          accounts_ar.value = accs.ar || [];
          accounts_income.value = accs.income || [];
          if (accounts_ar.value.length && !form.debit_to) form.debit_to = accounts_ar.value[0].name;
          if (accounts_income.value.length && !form.income_account) form.income_account = accounts_income.value[0].name;
        } catch (e) {
          console.warn("Account fetching failed:", e.message);
        }
        // Load customers
        try {
          customers.value = await apiList("Customer", { fields: ["name"], limit: 50, order: "name asc" });
          allItems.value = await apiList("Item", { fields: ["name", "item_name", "item_code", "standard_rate", "description"], limit: 300, order: "item_name asc" });
        } catch { }
      }

      watch(() => props.show, (v) => {
        if (v) {
          const m = localStorage.getItem("convert_to_invoice");
          if (m) {
            try {
              const data = JSON.parse(m);
              form.source_name = data.source_name;
              form.source_type = data.source_type;
              form.customer = data.customer;
              form.posting_date = data.order_date || data.date || today();
              form.due_date = data.delivery_date || data.expiry || data.order_date || data.date || today();
              if (data.items) {
                form.items = data.items.map(i => ({ ...i }));
              }
              recalc();
            } catch (e) { }
            localStorage.removeItem("convert_to_invoice");
          }
        }
      });

      onMounted(loadDefaults);
      watch(() => props.show, v => { if (v) loadDefaults(); });

      async function applyTaxTemplate(tplName) { }  // Tax templates not available

      async function save(andSubmit) {
        if (!form.customer) { toast("Please select a Customer", "error"); return; }
        if (!form.items.some(r => r.item_name && r.item_name.trim() !== "")) { toast("Please select at least one item", "error"); return; }
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

          if (form.source_name && form.source_type) {
            const lkey = form.source_type === "Sales Order" ? "books_sales_orders" : "books_quotes";
            try {
              const stArr = JSON.parse(localStorage.getItem(lkey) || "[]");
              const stIdx = stArr.findIndex(x => x.name === form.source_name);
              if (stIdx >= 0) {
                stArr[stIdx].status = "Invoiced";
                if (form.source_type === "Sales Order") stArr[stIdx].billed_amount = stArr[stIdx].grand_total;
                localStorage.setItem(lkey, JSON.stringify(stArr));
              }
            } catch { }
          }

          emit("saved", saved.name);
          emit("close");
          // Navigation handled by parent via 'saved' event
        } catch (e) {
          toast(e.message || "Could not save invoice", "error");
        } finally { saving.value = false; }
      }

      function onPostingDateChange() {
        if (!form.due_date || form.due_date < form.posting_date)
          form.due_date = form.posting_date;
      }
      function onItemPick(row) {
        const matching = allItems.value.find(it => it.item_name === row.item_name);
        if (matching) {
          row.rate = matching.standard_rate || 0;
          row.description = matching.description || "";
          recalc();
        }
      }

      return {
        form, saving, customers, allItems, accounts_ar, accounts_income, taxTemplates, isSI,
        recalc, addItem, removeItem, addTax, removeTax, onItemPick, onCustomer, applyTaxTemplate, save, fmt, flt, icon, toast, onPostingDateChange
      };
    },
    template: `
<teleport to="body">
<div v-if="show" class="nim-overlay" @click.self="$emit('close')">
  <div class="nim-dialog">

    <!-- Header -->
    <div class="nim-header">
      <div class="nim-header-left">
        <div class="nim-header-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <div>
          <div class="nim-header-title">New {{isSI?'Sales Invoice':'Purchase Bill'}}</div>
          <div class="nim-header-sub">{{form.company}}</div>
        </div>
      </div>
      <button class="nim-close" @click="$emit('close')" v-html="icon('x',15)"></button>
    </div>

    <!-- Body -->
    <div class="nim-body">

      <!-- Section: Invoice Details -->
      <div class="nim-section-label">Invoice Details</div>
      <div class="nim-grid-3 nim-mb">
        <div class="nim-field nim-span-1">
          <label class="nim-label">Customer <span class="nim-req">*</span></label>
          <searchable-select v-model="form.customer" :options="customers" placeholder="Select customer…" @update:modelValue="onCustomer"/>
        </div>
        <div class="nim-field">
          <label class="nim-label">Invoice Date <span class="nim-req">*</span></label>
          <input v-model="form.posting_date" type="date" class="nim-input" @change="onPostingDateChange"/>
        </div>
        <div class="nim-field">
          <label class="nim-label">Due Date</label>
          <input v-model="form.due_date" type="date" class="nim-input"/>
        </div>
      </div>

      <!-- Section: Accounts -->
      <div class="nim-grid-2 nim-mb">
        <div class="nim-field">
          <label class="nim-label">AR Account <span class="nim-req">*</span></label>
          <searchable-select v-model="form.debit_to" :options="accounts_ar" placeholder="Select account…"/>
        </div>
        <div class="nim-field">
          <label class="nim-label">Income Account <span class="nim-req">*</span></label>
          <searchable-select v-model="form.income_account" :options="accounts_income" placeholder="Select account…"/>
        </div>
      </div>

      <!-- Section: Items -->
      <div class="nim-section-header">
        <div class="nim-section-label" style="margin-bottom:0">Line Items</div>
      </div>
      <div class="nim-table-wrap nim-mb">
        <table class="nim-table">
          <thead>
            <tr>
              <th style="width:30%">Item Name</th>
              <th style="width:26%">Description</th>
              <th style="width:10%;text-align:center">Qty</th>
              <th style="width:16%;text-align:right">Rate (₹)</th>
              <th style="width:14%;text-align:right">Amount (₹)</th>
              <th style="width:4%"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item,i) in form.items" :key="i" class="nim-tr">
              <td>
                <searchable-select v-model="item.item_name" :options="allItems" value-key="item_name" label-key="item_name" placeholder="— Select Item —" :compact="true" class="ss-cell-wrap" @update:modelValue="onItemPick(item)"/>
              </td>
              <td><input v-model="item.description" class="nim-cell" placeholder="Description"/></td>
              <td style="text-align:center">
                <input v-model.number="item.qty" type="number" min="0.01" step="0.01"
                  class="nim-cell nim-num" @input="recalc"/>
              </td>
              <td style="text-align:right">
                <input v-model.number="item.rate" type="number" min="0" step="0.01"
                  class="nim-cell nim-num" @input="recalc"/>
              </td>
              <td style="text-align:right;font-variant-numeric:tabular-nums" class="nim-amount">
                {{item.amount?item.amount.toLocaleString("en-IN",{minimumFractionDigits:2}):"0.00"}}
              </td>
              <td style="text-align:center">
                <button @click="removeItem(i)" v-if="form.items.length>1" class="nim-del-btn" v-html="icon('trash',13)"></button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="nim-table-footer">
          <button @click="addItem" class="nim-add-btn">
            <span v-html="icon('plus',12)"></span> Add Row
          </button>
        </div>
      </div>

      <!-- Section: Taxes -->
      <div class="nim-section-header nim-mb-sm">
        <div class="nim-section-label" style="margin-bottom:0">Taxes & Charges</div>
        <div style="display:flex;gap:8px;align-items:center">
          <select v-if="taxTemplates.length" @change="e=>{if(e.target.value)applyTaxTemplate(e.target.value)}"
            class="nim-select-sm">
            <option value="">Apply template…</option>
            <option v-for="t in taxTemplates" :key="t.name" :value="t.name">{{t.title||t.name}}</option>
          </select>
          <button @click="addTax" class="nim-add-btn">
            <span v-html="icon('plus',12)"></span> Add Tax
          </button>
        </div>
      </div>

      <div v-if="form.taxes.length" class="nim-table-wrap nim-mb">
        <table class="nim-table">
          <thead>
            <tr>
              <th style="width:20%">Type</th>
              <th style="width:30%">Description</th>
              <th style="width:14%;text-align:center">Rate %</th>
              <th style="width:32%;text-align:right">Amount (₹)</th>
              <th style="width:4%"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(tax,i) in form.taxes" :key="i" class="nim-tr">
              <td>
                <select v-model="tax.tax_type" class="nim-cell" @change="tax.description=tax.tax_type">
                  <option>CGST</option><option>SGST</option><option>IGST</option>
                  <option>Cess</option><option>Other</option>
                </select>
              </td>
              <td><input v-model="tax.description" class="nim-cell"/></td>
              <td style="text-align:center">
                <input v-model.number="tax.rate" type="number" min="0" max="100" step="0.01"
                  class="nim-cell nim-num" @input="recalc"/>
              </td>
              <td class="nim-amount" style="text-align:right;font-variant-numeric:tabular-nums">
                {{flt(tax.tax_amount).toLocaleString("en-IN",{minimumFractionDigits:2})}}
              </td>
              <td style="text-align:center">
                <button @click="removeTax(i)" class="nim-del-btn" v-html="icon('trash',13)"></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Totals + Notes row -->
      <div class="nim-bottom-row">
        <!-- Notes -->
        <div class="nim-field" style="flex:1">
          <label class="nim-label">Notes <span style="color:#9ca3af;font-weight:400">(optional)</span></label>
          <textarea v-model="form.notes" class="nim-input nim-textarea"
            rows="3" placeholder="Payment terms, remarks…"></textarea>
        </div>
        <!-- Totals -->
        <div class="nim-totals">
          <div class="nim-total-row">
            <span class="nim-total-label">Subtotal</span>
            <span class="nim-total-val">{{fmt(form.net_total)}}</span>
          </div>
          <div v-for="tax in form.taxes" :key="tax.tax_type" class="nim-total-row nim-tax-row">
            <span class="nim-total-label">{{tax.description||tax.tax_type}} ({{tax.rate}}%)</span>
            <span class="nim-total-val">{{fmt(tax.tax_amount)}}</span>
          </div>
          <div class="nim-total-grand">
            <span>Grand Total</span>
            <span>{{fmt(form.grand_total)}}</span>
          </div>
        </div>
      </div>

    </div><!-- /body -->

    <!-- Footer -->
    <div class="nim-footer">
      <button @click="$emit('close')" :disabled="saving" class="nim-btn nim-btn-ghost">Cancel</button>
      <div style="display:flex;gap:8px">
        <button @click="save(false)" :disabled="saving" class="nim-btn nim-btn-outline">
          {{saving?'Saving…':'Save as Draft'}}
        </button>
        <button @click="save(true)" :disabled="saving" class="nim-btn nim-btn-primary">
          <span v-if="saving" v-html="icon('refresh',14)" style="animation:spin 1s linear infinite"></span>
          {{saving?'Submitting…':'Save & Submit'}}
        </button>
      </div>
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
      function onToBlur() { addTagFromVal(toVal.value, toTags); toVal.value = ""; }
      function onCcBlur() { addTagFromVal(ccVal.value, ccTags); ccVal.value = ""; }
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
            <td style="padding:5px 14px;font-size:12.5px;color:#555;text-align:right">${t.tax_type || ""} ${t.rate ? "(" + t.rate + "%)" : ""}</td>
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
      const allItems = ref([]);

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
        try { allItems.value = await apiList("Item", { fields: ["name", "item_name", "item_code", "standard_rate", "description"], limit: 300, order: "item_name asc" }); } catch { }
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
          // Navigation handled by parent
        } catch (e) { toast(e.message || "Could not save bill", "error"); }
        finally { saving.value = false; }
      }

      function onItemPick(row) {
        const matching = allItems.value.find(it => it.item_name === row.item_name);
        if (matching) {
          row.rate = matching.standard_rate || 0;
          row.description = matching.description || "";
          recalc();
        }
      }

      return { form, saving, suppliers, allItems, accounts_ap, accounts_exp, recalc, addItem, removeItem, onItemPick, onSupplier, save, fmt, flt, icon };
    },
    template: `
<teleport to="body">
<div v-if="show" class="nim-overlay" @click.self="$emit('close')">
  <div class="nim-dialog">
    <!-- Header -->
    <div class="nim-header">
      <div class="nim-header-left">
        <div class="nim-header-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
        </div>
        <div>
          <div class="nim-header-title">New Purchase Bill</div>
          <div class="nim-header-sub">{{form.company}}</div>
        </div>
      </div>
      <button class="nim-close" @click="$emit('close')" v-html="icon('x',15)"></button>
    </div>
    <!-- Body -->
    <div class="nim-body">
      <div class="nim-section-label">Supplier Details</div>
      <div class="nim-grid-3 nim-mb">
        <div class="nim-field" style="grid-column:span 2">
          <label class="nim-label">Supplier <span class="nim-req">*</span></label>
          <searchable-select v-model="form.supplier" :options="suppliers" placeholder="Select supplier…" @update:modelValue="onSupplier"/>
        </div>
        <div class="nim-field">
          <label class="nim-label">Supplier Invoice No</label>
          <input v-model="form.bill_no" class="nim-input" placeholder="e.g. INV-001"/>
        </div>
      </div>
      <div class="nim-grid-3 nim-mb">
        <div class="nim-field">
          <label class="nim-label">Date</label>
          <input v-model="form.posting_date" type="date" class="nim-input"/>
        </div>
        <div class="nim-field">
          <label class="nim-label">AP Account <span class="nim-req">*</span></label>
          <searchable-select v-model="form.credit_to" :options="accounts_ap" placeholder="Select account…"/>
        </div>
        <div class="nim-field">
          <label class="nim-label">Expense Account <span class="nim-req">*</span></label>
          <searchable-select v-model="form.expense_account" :options="accounts_exp" placeholder="Select account…"/>
        </div>
      </div>
      <!-- Items -->
      <div class="nim-section-label">Line Items</div>
      <div class="nim-table-wrap nim-mb">
        <table class="nim-table">
          <thead><tr>
            <th style="width:42%">Item Name</th>
            <th style="width:14%;text-align:center">Qty</th>
            <th style="width:22%;text-align:right">Rate (₹)</th>
            <th style="width:18%;text-align:right">Amount (₹)</th>
            <th style="width:4%"></th>
          </tr></thead>
          <tbody>
            <tr v-for="(item,i) in form.items" :key="i" class="nim-tr">
              <td>
                <searchable-select v-model="item.item_name" :options="allItems" value-key="item_name" label-key="item_name" placeholder="— Select Item —" :compact="true" class="ss-cell-wrap" @update:modelValue="onItemPick(item)"/>
              </td>
              <td style="text-align:center"><input v-model.number="item.qty" type="number" min="0.01" class="nim-cell nim-num" @input="recalc"/></td>
              <td style="text-align:right"><input v-model.number="item.rate" type="number" min="0" class="nim-cell nim-num" @input="recalc"/></td>
              <td class="nim-amount" style="text-align:right;font-variant-numeric:tabular-nums">{{flt(item.amount).toLocaleString("en-IN",{minimumFractionDigits:2})}}</td>
              <td style="text-align:center"><button @click="removeItem(i)" v-if="form.items.length>1" class="nim-del-btn" v-html="icon('trash',13)"></button></td>
            </tr>
          </tbody>
        </table>
        <div class="nim-table-footer">
          <button @click="addItem" class="nim-add-btn"><span v-html="icon('plus',12)"></span> Add Row</button>
        </div>
      </div>
      <!-- Totals -->
      <div style="display:flex;justify-content:flex-end">
        <div class="nim-totals">
          <div class="nim-total-row"><span class="nim-total-label">Subtotal</span><span class="nim-total-val">{{fmt(form.net_total)}}</span></div>
          <div class="nim-total-grand"><span>Grand Total</span><span>{{fmt(form.grand_total)}}</span></div>
        </div>
      </div>
    </div>
    <!-- Footer -->
    <div class="nim-footer">
      <button @click="$emit('close')" :disabled="saving" class="nim-btn nim-btn-ghost">Cancel</button>
      <div style="display:flex;gap:8px">
        <button @click="save(false)" :disabled="saving" class="nim-btn nim-btn-outline">{{saving?'Saving…':'Save as Draft'}}</button>
        <button @click="save(true)" :disabled="saving" class="nim-btn nim-btn-primary">{{saving?'Submitting…':'Save & Submit'}}</button>
      </div>
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
        } catch (e) { toast(e.message || "Could not save payment", "error"); }
        finally { saving.value = false; }
      }

      return { form, saving, customers, suppliers, accounts_bank, accounts_ar, accounts_ap, invoices, partyList, onParty, save, fmt, flt, icon, paymentModes };
    },
    template: `
<teleport to="body">
<div v-if="show" class="nim-overlay" @click.self="$emit('close')">
  <div class="nim-dialog" style="max-width:560px">
    <!-- Header -->
    <div class="nim-header">
      <div class="nim-header-left">
        <div class="nim-header-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
        </div>
        <div>
          <div class="nim-header-title">Record Payment</div>
          <div class="nim-header-sub">{{form.company}}</div>
        </div>
      </div>
      <button class="nim-close" @click="$emit('close')" v-html="icon('x',15)"></button>
    </div>
    <!-- Body -->
    <div class="nim-body">

      <!-- Type toggle -->
      <div class="nim-type-toggle nim-mb">
        <button v-for="t in ['Receive','Pay']" :key="t"
          class="nim-type-btn" :class="{active: form.payment_type===t}"
          @click="form.payment_type=t">
          <svg v-if="t==='Receive'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          {{t==="Receive"?"Receive (Customer)":"Pay (Supplier)"}}
        </button>
      </div>

      <!-- Party + Date -->
      <div class="nim-grid-2 nim-mb">
        <div class="nim-field">
          <label class="nim-label">{{form.party_type}} <span class="nim-req">*</span></label>
          <searchable-select v-model="form.party" :options="partyList" :placeholder="'Select '+form.party_type.toLowerCase()+'…'" @update:modelValue="onParty"/>
        </div>
        <div class="nim-field">
          <label class="nim-label">Payment Date</label>
          <input v-model="form.payment_date" type="date" class="nim-input"/>
        </div>
      </div>

      <!-- Outstanding invoices banner -->
      <div v-if="invoices.length" class="nim-invoices-banner nim-mb">
        <div class="nim-invoices-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          {{invoices.length}} outstanding invoice{{invoices.length>1?'s':''}}
        </div>
        <div v-for="inv in invoices.slice(0,3)" :key="inv.name" class="nim-invoice-row">
          <span>{{inv.name}}</span>
          <span style="font-family:monospace;font-weight:600">{{fmt(inv.outstanding_amount)}}</span>
        </div>
        <div v-if="invoices.length>3" class="nim-invoice-more">+{{invoices.length-3}} more</div>
      </div>

      <!-- Amount + Mode -->
      <div class="nim-grid-2 nim-mb">
        <div class="nim-field">
          <label class="nim-label">Amount <span class="nim-req">*</span></label>
          <input v-model.number="form.paid_amount" type="number" min="0" step="0.01"
            class="nim-input nim-amount-input" placeholder="0.00"/>
        </div>
        <div class="nim-field">
          <label class="nim-label">Mode of Payment</label>
          <select v-model="form.mode_of_payment" class="nim-select">
            <option v-for="m in paymentModes" :key="m.name" :value="m.name">{{m.name}}</option>
          </select>
        </div>
      </div>

      <!-- Accounts -->
      <div class="nim-grid-2 nim-mb">
        <div class="nim-field">
          <label class="nim-label">Paid From <span class="nim-req">*</span></label>
          <searchable-select v-model="form.paid_from" :options="form.payment_type==='Receive'?accounts_ar:accounts_bank" placeholder="Select account…"/>
        </div>
        <div class="nim-field">
          <label class="nim-label">Paid To <span class="nim-req">*</span></label>
          <searchable-select v-model="form.paid_to" :options="form.payment_type==='Receive'?accounts_bank:accounts_ap" placeholder="Select account…"/>
        </div>
      </div>

      <!-- Reference -->
      <div class="nim-field">
        <label class="nim-label">Reference No <span style="color:#9ca3af;font-weight:400">(UTR / Cheque — optional)</span></label>
        <input v-model="form.reference_no" class="nim-input" placeholder="e.g. UTR123456789"/>
      </div>

    </div>
    <!-- Footer -->
    <div class="nim-footer">
      <button @click="$emit('close')" :disabled="saving" class="nim-btn nim-btn-ghost">Cancel</button>
      <button @click="save" :disabled="saving" class="nim-btn nim-btn-primary">
        <span v-if="saving" v-html="icon('refresh',14)" style="animation:spin 1s linear infinite"></span>
        {{saving?'Processing…':'Record Payment'}}
      </button>
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
      const router = useRouter();
      return {
        kpis, dash, aging, loading, kpiDefs, agingRows, agingMax, showSI, showPI, showPay, load, fmt, fmtDate, fmtShort, isOverdue, statusBadge, icon, openDoc, flt,
        onInvoiceSaved: (name) => { router.push({ name: "invoice-detail", params: { name } }); }
      };
    },
    template: `
<div class="b-page">
  <InvoiceModal :show="showSI" @close="showSI=false" @saved="name=>{showSI=false;onInvoiceSaved(name)}"/>
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
        { k: "all", lbl: "All Invoices" },
        { k: "Draft", lbl: "Draft" },
        { k: "Unpaid", lbl: "Unpaid" },
        { k: "Overdue", lbl: "Overdue" },
        { k: "Paid", lbl: "Paid" }
      ];

      const isDraftRow = i => i.status === "Draft" || i.docstatus === 0 || String(i.docstatus) === "0";
      const counts = computed(() => ({
        Draft: list.value.filter(isDraftRow).length,
        Unpaid: list.value.filter(i => !isOverdue(i) && ["Submitted", "Unpaid", "Partly Paid"].includes(i.status)).length,
        Overdue: list.value.filter(isOverdue).length,
        Paid: list.value.filter(i => i.status === "Paid").length,
      }));

      const filtered = computed(() => {
        let r = list.value;
        if (active.value === "Overdue") r = r.filter(isOverdue);
        else if (active.value === "Unpaid") r = r.filter(i => !isOverdue(i) && ["Submitted", "Unpaid", "Partly Paid"].includes(i.status));
        else if (active.value === "Draft") r = r.filter(isDraftRow);
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
        return { Draft: "zb-pc-muted", Unpaid: "zb-pc-amber", Overdue: "zb-pc-red", Paid: "zb-pc-green" }[k] || "zb-pc-muted";
      }

      async function loadList() {
        loading.value = true;
        try {
          list.value = await apiList("Sales Invoice", {
            fields: ["name", "customer", "customer_name", "invoice_number", "posting_date", "due_date", "grand_total", "outstanding_amount", "status", "currency", "docstatus"],
            // Explicitly include draft (0) and submitted (1); exclude only cancelled (2).
            // Without this, some Frappe builds silently omit docstatus=0 invoices.
            filters: [["docstatus", "!=", 2]],
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
        if (["Submitted", "Unpaid", "Partly Paid"].includes(s)) return "zb-chip-partpaid";
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

      function onInvoiceSaved(name) { showNew.value = false; loadList(); router.push({ name: "invoice-detail", params: { name } }); }
      function onDocClick() { showDotMenu.value = false; }
      onMounted(() => {
        loadList();
        if (localStorage.getItem("convert_to_invoice")) {
          showNew.value = true;
        }
        document.addEventListener("click", onDocClick);
      });
      onUnmounted(() => { document.removeEventListener("click", onDocClick); });
      // ── Three-dot menu ──────────────────────────────────────────
      const showDotMenu = ref(false);
      function toggleDotMenu(e) { e.stopPropagation(); showDotMenu.value = !showDotMenu.value; }
      function closeDotMenu() { showDotMenu.value = false; }

      function exportCSV() {
        showDotMenu.value = false;
        const rows = filtered.value;
        if (!rows.length) { toast("No invoices to export", "error"); return; }
        const cols = ["name", "posting_date", "customer_name", "status", "due_date", "grand_total", "outstanding_amount", "currency"];
        const headers = ["Invoice #", "Date", "Customer", "Status", "Due Date", "Amount", "Balance Due", "Currency"];
        const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = [headers.join(","), ...rows.map(r => cols.map(c => escape(r[c])).join(","))].join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      }

      async function deleteSelected() {
        showDotMenu.value = false;
        const names = [...selected.value];
        if (!names.length) { toast("No invoices selected", "error"); return; }
        const draftNames = names.filter(n => {
          const row = list.value.find(i => i.name === n);
          return row && isDraftRow(row);
        });
        if (!draftNames.length) { toast("Only draft invoices can be deleted", "error"); return; }
        if (!confirm(`Delete ${draftNames.length} draft invoice(s)? This cannot be undone.`)) return;
        let ok = 0, fail = 0;
        for (const name of draftNames) {
          try {
            await apiPOST("frappe.client.delete", { doctype: "Sales Invoice", name });
            ok++;
          } catch { fail++; }
        }
        selected.value = new Set();
        await loadList();
        toast(ok ? `Deleted ${ok} invoice(s)${fail ? `, ${fail} failed` : ""}` : "Delete failed", fail ? "error" : "success");
      }

      return {
        list, loading, active, showNew, search, filters, counts, filtered,
        selected, allSelected, sortKey, showDotMenu,
        loadList, goToInvoice, statusChipCls, statusLabel, pillCountCls,
        toggleRow, toggleAll, sortBy, sortArrow, isOverdue, onInvoiceSaved,
        toggleDotMenu, closeDotMenu, exportCSV, deleteSelected,
        fmt, fmtDate, flt, icon
      };
    },
    template: `
<div class="zb-root no-sidebar-pad" style="background:#fff;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <InvoiceModal :show="showNew" @close="showNew=false" @saved="onInvoiceSaved"/>

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
      <div style="position:relative">
        <button @click="toggleDotMenu" title="More options" style="background:none;border:1px solid #e8ecf0;cursor:pointer;color:#6b7280;padding:5px 8px;border-radius:5px;display:inline-flex;align-items:center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
        </button>
        <div v-if="showDotMenu" style="position:absolute;right:0;top:calc(100% + 4px);background:#fff;border:1px solid #e8ecf0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);min-width:180px;z-index:999;overflow:hidden">
          <button @click="exportCSV" style="width:100%;text-align:left;padding:10px 14px;background:none;border:none;cursor:pointer;font-size:13px;color:#1a1d23;display:flex;align-items:center;gap:8px;font-family:inherit" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background='none'">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </button>
          <div style="height:1px;background:#f0f0f0;margin:0 8px"></div>
          <button @click="deleteSelected" style="width:100%;text-align:left;padding:10px 14px;background:none;border:none;cursor:pointer;font-size:13px;color:#dc2626;display:flex;align-items:center;gap:8px;font-family:inherit" onmouseover="this.style.background='#fff5f5'" onmouseout="this.style.background='none'">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            Delete Selected
          </button>
        </div>
      </div>
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
    components: { SendEmailModal, PaymentModal, InvoiceModal },
    setup() {
      const route = useRoute();
      const router = useRouter();
      const invName = computed(() => route.params.name);
      const showSendEmail = ref(false);
      const showSendMenu = ref(false);
      const showNew = ref(false);

      function onInvoiceSaved(savedName) {
        showNew.value = false;
        router.push({ name: "invoice-detail", params: { name: savedName } });
      }

      // ── List (sidebar) ──────────────────────────────────────────
      const list = ref([]), listLoading = ref(true), active = ref("all"), search = ref("");
      const filters = [
        { k: "all", lbl: "All Invoices" },
        { k: "Draft", lbl: "Draft" },
        { k: "Unpaid", lbl: "Unpaid" },
        { k: "Overdue", lbl: "Overdue" },
        { k: "Paid", lbl: "Paid" }
      ];
      const isDraftRow = i => i.status === "Draft" || i.docstatus === 0 || String(i.docstatus) === "0";
      const counts = computed(() => ({
        Draft: list.value.filter(isDraftRow).length,
        Unpaid: list.value.filter(i => !isOverdue(i) && ["Submitted", "Unpaid", "Partly Paid"].includes(i.status)).length,
        Overdue: list.value.filter(isOverdue).length,
        Paid: list.value.filter(i => i.status === "Paid").length,
      }));
      const filtered = computed(() => {
        let r = list.value;
        if (active.value === "Overdue") r = r.filter(isOverdue);
        else if (active.value === "Draft") r = r.filter(isDraftRow);
        else if (active.value === "Unpaid") r = r.filter(i => !isOverdue(i) && ["Submitted", "Unpaid", "Partly Paid"].includes(i.status));
        else if (active.value !== "all") r = r.filter(i => i.status === active.value);
        if (search.value) r = r.filter(i => (i.name + (i.customer || "")).toLowerCase().includes(search.value.toLowerCase()));
        return r;
      });
      async function loadList() {
        listLoading.value = true;
        try {
          list.value = await apiList("Sales Invoice", {
            fields: ["name", "customer", "customer_name", "posting_date", "due_date", "grand_total", "outstanding_amount", "status", "docstatus"],
            filters: [["docstatus", "!=", 2]],
            order: "posting_date desc",
            limit: 100
          });
        }
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
      const allItems = ref([]);
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
        try { allItems.value = await apiList("Item", { fields: ["name", "item_name", "item_code", "standard_rate", "description"], limit: 300, order: "item_name asc" }); } catch { }
        try {
          const accs = await apiGET("zoho_books_clone.api.docs.get_accounts", { company: form.company });
          accounts_ar.value = accs.ar || [];
          accounts_income.value = accs.income || [];
        } catch { }
      }
      async function startEdit() {
        if (!inv.value) return;
        // Capture the invoice's own account values before loading defaults,
        // so we can restore them if loadFormDefaults overwrites with an empty list.
        const savedDebitTo = inv.value.debit_to || "";
        const savedIncomeAcct = inv.value.income_account || "";
        Object.assign(form, {
          customer: inv.value.customer || "", posting_date: inv.value.posting_date || "",
          due_date: inv.value.due_date || "", debit_to: savedDebitTo,
          income_account: savedIncomeAcct, currency: inv.value.currency || "INR",
          notes: inv.value.notes || "", company: inv.value.company || "",
          items: (inv.value.items || []).map(i => ({ ...i })),
          taxes: (inv.value.taxes || []).map(t => ({ ...t })),
        });
        if (!form.items.length) form.items = [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }];
        // Await account/customer lists so the dropdowns are populated before the form renders.
        await loadFormDefaults();
        // Restore the invoice's original account selections in case loadFormDefaults
        // auto-selected defaults (it only auto-selects when the form value is empty).
        if (savedDebitTo) form.debit_to = savedDebitTo;
        if (savedIncomeAcct) form.income_account = savedIncomeAcct;
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
          const saved = await apiPOST("zoho_books_clone.api.docs.save_doc", { doc: JSON.stringify(doc) });
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
      function printPdf() {
        const paper = document.getElementById("zb-inv-paper");
        if (!paper) { window.print(); return; }
        const cssHref = Array.from(document.styleSheets)
          .map(s => { try { return s.href; } catch { return null; } })
          .filter(h => h && h.includes("books.css"))[0] || "";
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
          <title>Invoice</title>
          ${cssHref ? `<link rel="stylesheet" href="${cssHref}">` : ""}
          <style>
            @page { margin: 12mm; }
            body { margin:0; background:#fff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
            .zb-pdf-paper { box-shadow:none!important; max-width:100%!important; padding:20px!important; }
            .zb-sent-ribbon,.zb-draft-ribbon { display:none!important; }
          </style>
        </head><body>
          <div class="zb-pdf-paper">${paper.innerHTML}</div>
          <script>window.onload=function(){window.print();window.close();}<\/script>
        </body></html>`;
        const w = window.open("", "_blank", "width=800,height=900");
        if (!w) { toast("Allow pop-ups to print invoice", "error"); return; }
        w.document.write(html);
        w.document.close();
      }
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
        reference: "", notes: "", ref_no: "",
        invoiceName: "",   // dedicated field — always the authoritative invoice name
        send_thankyou: false
      });

      watch(() => inv.value, (v) => {
        if (v) {
          recPay.amount = flt(v.outstanding_amount) || flt(v.grand_total);
          recPay.ref_no = v.name;
          recPay.invoiceName = v.name;   // keep invoiceName in sync whenever inv changes
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
          recPay.invoiceName = inv.value.name;   // authoritative invoice name for the POST
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
            invoice_name: recPay.invoiceName || invName.value || inv.value?.name || "",
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

      function onItemPick(row) {
        const matching = allItems.value.find(it => it.item_name === row.item_name);
        if (matching) {
          row.rate = matching.standard_rate || 0;
          row.description = matching.description || "";
          recalc();
        }
      }

      return {
        list, listLoading, active, search, filters, counts, filtered, pillBadge, goInvoice, invName,
        inv, detailLoading, detailError, editing, saving, submitting, showSendEmail, showSendMenu, showCustMenu, showRecPay, recPay, recPaySaving, recPayAccounts, saveRecPay, openRecPay, showNew, onInvoiceSaved,
        form, customers, allItems, onItemPick, accounts_ar, accounts_income,
        statusBadgeCls, isDraft, paidAmt, paidPct, netTotal, totalTax, grandTotal,
        startEdit, saveEdit, submitInvoice, printPdf,
        addItem, removeItem, addTax, removeTax, recalc, toAmountWords,
        fmt, fmtDate, flt, icon, openDoc
      };
    },
    template: `
<div class="zb-master-detail no-sidebar-pad" :class="{'zb-mob-hide-list': invName}">

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
          <button class="zb-icon-btn" @click="showNew=true" title="New Invoice">
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
    <!-- Mobile back button -->
    <div class="zb-mob-back no-print" style="display:none;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #e8ecf0;background:#fff;position:sticky;top:0;z-index:20">
      <button @click="$router.push('/invoices')" style="display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;font-size:13px;font-weight:600;color:#2563eb;padding:4px 0;font-family:inherit">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        All Invoices
      </button>
    </div>

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

        <div class="zb-pdf-paper" id="zb-inv-paper">
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
              <searchable-select v-model="form.customer" :options="customers" placeholder="— Select —"/></div>
            <div class="zb-form-field"><label class="zb-form-label">Invoice Date</label>
              <input type="date" v-model="form.posting_date" class="zb-form-input"/></div>
            <div class="zb-form-field"><label class="zb-form-label">Due Date</label>
              <input type="date" v-model="form.due_date" class="zb-form-input"/></div>
            <div class="zb-form-field"><label class="zb-form-label">AR Account</label>
              <searchable-select v-model="form.debit_to" :options="accounts_ar" placeholder="— Select —"/></div>
            <div class="zb-form-field"><label class="zb-form-label">Income Account</label>
              <searchable-select v-model="form.income_account" :options="accounts_income" placeholder="— Select —"/></div>
            <div class="zb-form-field"><label class="zb-form-label">Currency</label>
              <input v-model="form.currency" class="zb-form-input"/></div>
          </div>
          <div class="zb-form-section-title" style="margin-top:18px">Items</div>
          <table class="zb-items-table">
            <thead><tr><th>#</th><th>Item Name</th><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(item,i) in form.items" :key="i">
                <td style="color:#aaa;font-size:11px;text-align:center;width:28px">{{i+1}}</td>
                <td>
                  <searchable-select v-model="item.item_name" :options="allItems" value-key="item_name" label-key="item_name" placeholder="— Select Item —" :compact="true" class="ss-cell-wrap" @update:modelValue="onItemPick(item)"/>
                </td>
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
  <InvoiceModal :show="showNew" @close="showNew=false" @saved="onInvoiceSaved"/>

</div>
`});

  /* ═══════════════════════════════════════════════════════════════
     CUSTOMERS COMPONENT
  ═══════════════════════════════════════════════════════════════ */
  const Customers = defineComponent({
    name: "Customers",
    setup() {
      const router = useRouter();
      const list = ref([]);
      const loading = ref(true);
      const search = ref("");
      const activeFilter = ref("all");
      const showDrawer = ref(false);
      const drawerMode = ref("add"); // "add" | "edit"
      const drawerLoading = ref(false);
      const saving = ref(false);
      const showDelete = ref(false);
      const deleteTarget = ref(null);
      const deleting = ref(false);

      const form = reactive({
        name: "",
        customer_name: "", customer_type: "Company",
        tax_id: "", default_currency: "INR", credit_limit: 0,
        email_id: "", mobile_code: "+91", mobile_no: "", phone: "", website: "",
        address_line1: "", address_line2: "",
        city: "", state: "", pincode: "", country: "India",
        payment_terms: "", disabled: 0,
      });

      const counts = computed(() => ({
        all: list.value.length,
        active: list.value.filter(c => !c.disabled).length,
        disabled: list.value.filter(c => c.disabled).length,
      }));

      const filtered = computed(() => {
        let r = list.value;
        if (activeFilter.value === "active") r = r.filter(c => !c.disabled);
        if (activeFilter.value === "disabled") r = r.filter(c => c.disabled);
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(c =>
          (c.customer_name || "").toLowerCase().includes(q) ||
          (c.name || "").toLowerCase().includes(q) ||
          (c.email_id || "").toLowerCase().includes(q) ||
          (c.mobile_no || "").toLowerCase().includes(q) ||
          (c.tax_id || "").toLowerCase().includes(q)
        );
        return r;
      });

      async function load() {
        loading.value = true;
        try {
          const rows = await apiList("Customer", {
            fields: ["name", "customer_name", "customer_type", "email_id", "mobile_no",
              "tax_id", "city", "state", "disabled", "default_currency", "credit_limit"],
            order: "customer_name asc", limit: 300,
          });
          list.value = rows || [];
        } catch (e) {
          toast("Failed to load customers: " + (e.message || e), "error");
        } finally { loading.value = false; }
      }

      function resetForm() {
        Object.assign(form, {
          name: "", customer_name: "", customer_type: "Company",
          tax_id: "", default_currency: "INR", credit_limit: 0,
          email_id: "", mobile_code: "+91", mobile_no: "", phone: "", website: "",
          address_line1: "", address_line2: "",
          city: "", state: "", pincode: "", country: "India",
          payment_terms: "", disabled: 0,
        });
      }

      function openAdd() {
        resetForm();
        drawerMode.value = "add";
        showDrawer.value = true;
      }

      async function openEdit(name) {
        resetForm();
        drawerMode.value = "edit";
        drawerLoading.value = true;
        showDrawer.value = true;
        try {
          const doc = await apiGET("frappe.client.get", { doctype: "Customer", name });
          Object.assign(form, {
            name: doc.name,
            customer_name: doc.customer_name || "",
            customer_type: doc.customer_type || "Company",
            tax_id: doc.tax_id || "",
            default_currency: doc.default_currency || "INR",
            credit_limit: doc.credit_limit || 0,
            email_id: doc.email_id || "",
            mobile_code: (doc.mobile_no || "").includes(" ") && (doc.mobile_no || "").startsWith("+") ? doc.mobile_no.split(" ")[0] : "+91",
            mobile_no: (doc.mobile_no || "").includes(" ") && (doc.mobile_no || "").startsWith("+") ? doc.mobile_no.substring(doc.mobile_no.indexOf(" ") + 1) : (doc.mobile_no || ""),
            phone: doc.phone || "",
            website: doc.website || "",
            address_line1: doc.address_line1 || "",
            address_line2: doc.address_line2 || "",
            city: doc.city || "",
            state: doc.state || "",
            pincode: doc.pincode || "",
            country: doc.country || "India",
            payment_terms: doc.payment_terms || "",
            disabled: doc.disabled || 0,
          });
        } catch (e) {
          toast("Could not load customer: " + (e.message || e), "error");
          showDrawer.value = false;
        } finally { drawerLoading.value = false; }
      }

      async function saveCustomer() {
        if (!form.customer_name.trim()) { toast("Customer Name is required", "error"); return; }
        if (form.email_id && !form.email_id.includes("@")) { toast("Invalid email address", "error"); return; }
        saving.value = true;
        try {
          const doc = {
            doctype: "Customer",
            ...(drawerMode.value === "edit" ? { name: form.name } : { naming_series: "CUST-.YYYY.-.#####" }),
            customer_name: form.customer_name.trim(),
            customer_type: form.customer_type,
            tax_id: form.tax_id.trim(),
            default_currency: form.default_currency,
            credit_limit: parseFloat(form.credit_limit) || 0,
            email_id: form.email_id.trim(),
            mobile_no: form.mobile_no.trim() ? (form.mobile_code + " " + form.mobile_no.trim()) : "",
            phone: form.phone.trim(),
            website: form.website.trim(),
            address_line1: form.address_line1.trim(),
            address_line2: form.address_line2.trim(),
            city: form.city.trim(),
            state: form.state.trim(),
            pincode: form.pincode.trim(),
            country: form.country.trim() || "India",
            payment_terms: form.payment_terms,
            disabled: form.disabled ? 1 : 0,
          };
          let doc_to_save = doc;
          if (drawerMode.value === "edit") {
            const fresh = await apiGET("frappe.client.get", { doctype: "Customer", name: form.name });
            doc_to_save = { ...fresh, ...doc };
          }
          await apiSave(doc_to_save);
          toast(drawerMode.value === "edit" ? "Customer updated!" : "Customer created!");
          showDrawer.value = false;
          await load();
        } catch (e) {
          toast(e.message || "Could not save customer", "error");
        } finally { saving.value = false; }
      }

      function confirmDelete(c) {
        deleteTarget.value = c;
        showDelete.value = true;
      }

      async function doDelete() {
        if (!deleteTarget.value) return;
        deleting.value = true;
        try {
          await apiDelete("Customer", deleteTarget.value.name);
          toast("Customer deleted");
          showDelete.value = false;
          deleteTarget.value = null;
          await load();
        } catch (e) {
          toast(e.message || "Could not delete customer", "error");
        } finally { deleting.value = false; }
      }

      onMounted(load);

      return {
        list, loading, search, activeFilter, filtered, counts,
        showDrawer, drawerMode, drawerLoading, saving, form,
        showDelete, deleteTarget, deleting,
        load, openAdd, openEdit, saveCustomer, confirmDelete, doDelete,
        icon, fmt, fmtDate,
      };
    },
    template: `
<div class="b-page cust-page">

  <!-- ── Toolbar ── -->
  <div class="cust-toolbar">
    <div class="cust-toolbar-left">
      <div class="cust-filters">
        <button v-for="f in [{k:'all',l:'All'},{k:'active',l:'Active'},{k:'disabled',l:'Disabled'}]"
          :key="f.k" class="zb-inv-pill" :class="{'zb-inv-pill-active': activeFilter===f.k}"
          @click="activeFilter=f.k">
          {{f.l}}
          <span class="zb-pill-cnt" :class="activeFilter===f.k?'':'zb-pc-muted'">{{counts[f.k]}}</span>
        </button>
      </div>
    </div>
    <div class="cust-toolbar-right">
      <div class="cust-search">
        <span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span>
        <input v-model="search" placeholder="Search customers…" class="cust-search-input" autocomplete="off"/>
      </div>
      <button class="zb-tb-btn" @click="load" title="Refresh">
        <span v-html="icon('refresh',13)"></span> Refresh
      </button>
      <button class="zb-tb-btn zb-tb-primary" @click="openAdd">
        <span v-html="icon('plus',13)"></span> New Customer
      </button>
    </div>
  </div>

  <!-- ── Table ── -->
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Type</th>
            <th>GSTIN</th>
            <th>Email</th>
            <th>Mobile</th>
            <th>City / State</th>
            <th>Status</th>
            <th style="text-align:center;width:100px">Actions</th>
          </tr>
        </thead>
        <tbody>
          <!-- Loading -->
          <template v-if="loading">
            <tr v-for="n in 6" :key="n">
              <td colspan="8" style="padding:12px 14px">
                <div class="b-shimmer" style="height:13px;border-radius:4px;width:70%"></div>
              </td>
            </tr>
          </template>
          <!-- Empty -->
          <tr v-else-if="!filtered.length">
            <td colspan="8" class="cust-empty">
              <div class="cust-empty-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </div>
              <div class="cust-empty-title">{{search ? 'No results found' : 'No customers yet'}}</div>
              <div class="cust-empty-sub">{{search ? 'Try a different search term' : 'Add your first customer to get started'}}</div>
              <button v-if="!search" class="nim-btn nim-btn-primary" style="margin-top:12px" @click="openAdd">
                <span v-html="icon('plus',13)"></span> New Customer
              </button>
            </td>
          </tr>
          <!-- Rows -->
          <tr v-else v-for="c in filtered" :key="c.name"
            class="cust-row" :class="c.disabled?'cust-row-disabled':''"
            @click="openEdit(c.name)">
            <td>
              <div class="cust-name">{{c.customer_name}}</div>
              <div class="cust-id">{{c.name}}</div>
            </td>
            <td>
              <span class="b-badge" :class="c.customer_type==='Company'?'b-badge-blue':'b-badge-muted'">
                {{c.customer_type||'—'}}
              </span>
            </td>
            <td class="cust-mono">{{c.tax_id||'—'}}</td>
            <td class="cust-secondary">{{c.email_id||'—'}}</td>
            <td class="cust-secondary">{{c.mobile_no||'—'}}</td>
            <td class="cust-secondary">
              {{c.city ? (c.city + (c.state ? ', '+c.state : '')) : '—'}}
            </td>
            <td>
              <span class="b-badge" :class="c.disabled?'b-badge-red':'b-badge-green'">
                {{c.disabled?'Disabled':'Active'}}
              </span>
            </td>
            <td @click.stop style="text-align:center">
              <div style="display:flex;gap:4px;justify-content:center">
                <button class="cust-act-btn cust-act-edit" @click="openEdit(c.name)" title="Edit">
                  <span v-html="icon('edit',13)"></span>
                </button>
                <button class="cust-act-btn cust-act-del" @click="confirmDelete(c)" title="Delete">
                  <span v-html="icon('trash',13)"></span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">
      Showing {{filtered.length}} of {{list.length}} customers
    </div>
  </div>

  <!-- ── Add / Edit Drawer ── -->
  <teleport to="body">
    <transition name="cust-drawer-fade">
      <div v-if="showDrawer" class="cust-backdrop" @click.self="showDrawer=false">
        <transition name="cust-drawer-slide">
          <div v-if="showDrawer" class="cust-drawer">

            <!-- Drawer Header -->
            <div class="cust-drawer-header">
              <div class="cust-drawer-header-left">
                <div class="cust-drawer-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
                <div>
                  <div class="cust-drawer-title">{{drawerMode==='add'?'New Customer':'Edit Customer'}}</div>
                  <div class="cust-drawer-sub">{{drawerMode==='edit'?form.name:'Fill in customer details'}}</div>
                </div>
              </div>
              <button class="nim-close" @click="showDrawer=false" v-html="icon('x',15)"></button>
            </div>

            <!-- Loading state -->
            <div v-if="drawerLoading" style="flex:1;display:grid;place-items:center;color:#9ca3af;font-size:13px">
              <div>Loading customer…</div>
            </div>

            <!-- Drawer Body -->
            <div v-else class="cust-drawer-body">

              <div class="cust-sec-label">Basic Information</div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field" style="grid-column:span 3">
                  <label class="nim-label">Customer Name <span class="nim-req">*</span></label>
                  <input v-model="form.customer_name" class="nim-input" placeholder="Full name or company name"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Customer Type</label>
                  <select v-model="form.customer_type" class="nim-select">
                    <option>Company</option><option>Individual</option>
                  </select>
                </div>
                <div class="nim-field">
                  <label class="nim-label">GSTIN / Tax ID</label>
                  <input v-model="form.tax_id" class="nim-input" placeholder="27AAPFU0939F1ZV"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Currency</label>
                  <select v-model="form.default_currency" class="nim-select">
                    <option>INR</option><option>USD</option><option>EUR</option><option>GBP</option><option>AED</option><option>SGD</option>
                  </select>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Credit Limit ({{ {'INR':'₹','USD':'$','EUR':'€','GBP':'£','AED':'د.إ','SGD':'S$'}[form.default_currency] || '₹' }})</label>
                  <input v-model.number="form.credit_limit" type="number" min="0" class="nim-input" placeholder="0 = unlimited"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Payment Terms</label>
                  <select v-model="form.payment_terms" class="nim-select">
                    <option value="">Select</option>
                    <option>Net 30</option><option>Net 15</option><option>Net 7</option>
                    <option>Due on Receipt</option><option>End of Month</option>
                  </select>
                </div>
              </div>

              <div class="cust-sec-label">Contact</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field">
                  <label class="nim-label">Email</label>
                  <input v-model="form.email_id" type="email" class="nim-input" placeholder="email@example.com"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Mobile</label>
                  <div style="display:flex;">
                    <select v-model="form.mobile_code" style="width:75px; border-right:none; border-top-right-radius:0; border-bottom-right-radius:0; text-align:center; background:#f9fafb; padding:0 5px;" class="nim-input">
                      <option value="+91">🇮🇳 +91</option><option value="+1">🇺🇸 +1</option>
                      <option value="+44">🇬🇧 +44</option><option value="+61">🇦🇺 +61</option>
                      <option value="+971">🇦🇪 +971</option><option value="+65">🇸🇬 +65</option>
                    </select>
                    <input v-model="form.mobile_no" class="nim-input" style="border-top-left-radius:0; border-bottom-left-radius:0; flex:1;" placeholder="98765 43210"/>
                  </div>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Phone</label>
                  <input v-model="form.phone" class="nim-input" placeholder="Landline"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Website</label>
                  <input v-model="form.website" class="nim-input" placeholder="https://"/>
                </div>
              </div>

              <div class="cust-sec-label">Billing Address</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field" style="grid-column:span 2">
                  <label class="nim-label">Address Line 1</label>
                  <input v-model="form.address_line1" class="nim-input" placeholder="Street, building no."/>
                </div>
                <div class="nim-field" style="grid-column:span 2">
                  <label class="nim-label">Address Line 2</label>
                  <input v-model="form.address_line2" class="nim-input" placeholder="Area, landmark"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">City</label>
                  <input v-model="form.city" class="nim-input" placeholder="Mumbai"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">State</label>
                  <input v-model="form.state" class="nim-input" placeholder="Maharashtra"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Pincode</label>
                  <input v-model="form.pincode" class="nim-input" placeholder="400001"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Country</label>
                  <select v-model="form.country" class="nim-select">
                    <option>India</option><option>United States</option><option>United Kingdom</option>
                    <option>Canada</option><option>Australia</option><option>Singapore</option>
                    <option>United Arab Emirates</option><option>Saudi Arabia</option>
                    <option>Germany</option><option>France</option>
                  </select>
                </div>
              </div>

              <!-- Disable toggle (edit only) -->
              <div v-if="drawerMode==='edit'" class="cust-disable-box" @click="form.disabled = form.disabled?0:1">
                <input type="checkbox" :checked="!!form.disabled" @click.stop="form.disabled=form.disabled?0:1" style="width:16px;height:16px;accent-color:#dc2626;cursor:pointer"/>
                <label style="font-size:13px;color:#dc2626;cursor:pointer">Disable this customer (won't appear in invoice dropdowns)</label>
              </div>

            </div>

            <!-- Drawer Footer -->
            <div class="nim-footer">
              <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">Cancel</button>
              <button class="nim-btn nim-btn-primary" @click="saveCustomer" :disabled="saving">
                <span v-if="saving" v-html="icon('refresh',13)" style="animation:spin 1s linear infinite"></span>
                {{saving ? 'Saving…' : (drawerMode==='add' ? 'Create Customer' : 'Save Changes')}}
              </button>
            </div>

          </div>
        </transition>
      </div>
    </transition>
  </teleport>

  <!-- ── Delete Confirm Modal ── -->
  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left">
            <div class="nim-header-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </div>
            <div class="nim-header-title">Delete Customer?</div>
          </div>
          <button class="nim-close" @click="showDelete=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Are you sure you want to delete <strong>{{deleteTarget?.customer_name}}</strong>?
            This action cannot be undone.
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Cancel</button>
          <button @click="doDelete" :disabled="deleting"
            style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff;display:inline-flex;align-items:center;gap:7px">
            <span v-if="deleting" v-html="icon('refresh',13)" style="animation:spin 1s linear infinite"></span>
            {{deleting ? 'Deleting…' : 'Yes, Delete'}}
          </button>
        </div>
      </div>
    </div>
  </teleport>

</div>
`});


  /* ═══════════════════════════════════════════════════════════════
     VENDORS COMPONENT
  ═══════════════════════════════════════════════════════════════ */
  const Vendors = defineComponent({
    name: "Vendors",
    setup() {
      const list = ref([]);
      const loading = ref(true);
      const search = ref("");
      const activeFilter = ref("all");
      const showDrawer = ref(false);
      const drawerMode = ref("add"); // "add" | "edit"
      const drawerLoading = ref(false);
      const saving = ref(false);
      const showDelete = ref(false);
      const deleteTarget = ref(null);
      const deleting = ref(false);
      const accounts = ref([]);

      const form = reactive({
        name: "",
        supplier_name: "", supplier_type: "Company",
        tax_id: "", default_currency: "INR", payment_terms: "",
        email_id: "", mobile_code: "+91", mobile_no: "", phone: "", website: "",
        address_line1: "", address_line2: "",
        city: "", state: "", pincode: "", country: "India",
        default_payable_account: "", disabled: 0,
      });

      const counts = computed(() => ({
        all: list.value.length,
        active: list.value.filter(v => !v.disabled).length,
        disabled: list.value.filter(v => v.disabled).length,
      }));

      const filtered = computed(() => {
        let r = list.value;
        if (activeFilter.value === "active") r = r.filter(v => !v.disabled);
        if (activeFilter.value === "disabled") r = r.filter(v => v.disabled);
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(v =>
          (v.supplier_name || "").toLowerCase().includes(q) ||
          (v.name || "").toLowerCase().includes(q) ||
          (v.email_id || "").toLowerCase().includes(q) ||
          (v.mobile_no || "").toLowerCase().includes(q) ||
          (v.tax_id || "").toLowerCase().includes(q)
        );
        return r;
      });

      async function load() {
        loading.value = true;
        try {
          const rows = await apiList("Supplier", {
            fields: ["name", "supplier_name", "supplier_type", "email_id", "mobile_no",
              "tax_id", "city", "state", "disabled", "default_currency"],
            order: "supplier_name asc", limit: 300,
          });
          list.value = rows || [];
        } catch (e) {
          toast("Failed to load vendors: " + (e.message || e), "error");
        } finally { loading.value = false; }
      }

      async function loadAccounts() {
        try {
          const rows = await apiList("Account", {
            fields: ["name"],
            filters: [["account_type", "=", "Payable"], ["is_group", "=", 0]],
            limit: 50,
          });
          accounts.value = rows || [];
        } catch { accounts.value = []; }
      }

      function resetForm() {
        Object.assign(form, {
          name: "", supplier_name: "", supplier_type: "Company",
          tax_id: "", default_currency: "INR", payment_terms: "",
          email_id: "", mobile_code: "+91", mobile_no: "", phone: "", website: "",
          address_line1: "", address_line2: "",
          city: "", state: "", pincode: "", country: "India",
          default_payable_account: "", disabled: 0,
        });
      }

      function openAdd() {
        resetForm();
        drawerMode.value = "add";
        showDrawer.value = true;
      }

      async function openEdit(name) {
        resetForm();
        drawerMode.value = "edit";
        drawerLoading.value = true;
        showDrawer.value = true;
        try {
          const doc = await apiGET("frappe.client.get", { doctype: "Supplier", name });
          Object.assign(form, {
            name: doc.name,
            supplier_name: doc.supplier_name || "",
            supplier_type: doc.supplier_type || "Company",
            tax_id: doc.tax_id || "",
            default_currency: doc.default_currency || "INR",
            payment_terms: doc.payment_terms || "",
            email_id: doc.email_id || "",
            mobile_code: (doc.mobile_no || "").includes(" ") && (doc.mobile_no || "").startsWith("+") ? doc.mobile_no.split(" ")[0] : "+91",
            mobile_no: (doc.mobile_no || "").includes(" ") && (doc.mobile_no || "").startsWith("+") ? doc.mobile_no.substring(doc.mobile_no.indexOf(" ") + 1) : (doc.mobile_no || ""),
            phone: doc.phone || "",
            website: doc.website || "",
            address_line1: doc.address_line1 || "",
            address_line2: doc.address_line2 || "",
            city: doc.city || "",
            state: doc.state || "",
            pincode: doc.pincode || "",
            country: doc.country || "India",
            default_payable_account: doc.default_payable_account || "",
            disabled: doc.disabled || 0,
          });
        } catch (e) {
          toast("Could not load vendor: " + (e.message || e), "error");
          showDrawer.value = false;
        } finally { drawerLoading.value = false; }
      }

      async function saveVendor() {
        if (!form.supplier_name.trim()) { toast("Vendor Name is required", "error"); return; }
        if (form.email_id && !form.email_id.includes("@")) { toast("Invalid email address", "error"); return; }
        saving.value = true;
        try {
          const doc = {
            doctype: "Supplier",
            ...(drawerMode.value === "edit" ? { name: form.name } : { naming_series: "SUPP-.YYYY.-.#####" }),
            supplier_name: form.supplier_name.trim(),
            supplier_type: form.supplier_type,
            tax_id: form.tax_id.trim(),
            default_currency: form.default_currency,
            payment_terms: form.payment_terms,
            email_id: form.email_id.trim(),
            mobile_no: form.mobile_no.trim() ? (form.mobile_code + " " + form.mobile_no.trim()) : "",
            phone: form.phone.trim(),
            website: form.website.trim(),
            address_line1: form.address_line1.trim(),
            address_line2: form.address_line2.trim(),
            city: form.city.trim(),
            state: form.state.trim(),
            pincode: form.pincode.trim(),
            country: form.country.trim() || "India",
            default_payable_account: form.default_payable_account,
            disabled: form.disabled ? 1 : 0,
          };
          let doc_to_save = doc;
          if (drawerMode.value === "edit") {
            const fresh = await apiGET("frappe.client.get", { doctype: "Supplier", name: form.name });
            doc_to_save = { ...fresh, ...doc };
          }
          await apiSave(doc_to_save);
          toast(drawerMode.value === "edit" ? "Vendor updated!" : "Vendor created!");
          showDrawer.value = false;
          await load();
        } catch (e) {
          toast(e.message || "Could not save vendor", "error");
        } finally { saving.value = false; }
      }

      function confirmDelete(v) {
        deleteTarget.value = v;
        showDelete.value = true;
      }

      async function doDelete() {
        if (!deleteTarget.value) return;
        deleting.value = true;
        try {
          await apiDelete("Supplier", deleteTarget.value.name);
          toast("Vendor deleted");
          showDelete.value = false;
          deleteTarget.value = null;
          await load();
        } catch (e) {
          toast(e.message || "Could not delete vendor", "error");
        } finally { deleting.value = false; }
      }

      onMounted(() => { load(); loadAccounts(); });

      return {
        list, loading, search, activeFilter, filtered, counts, accounts,
        showDrawer, drawerMode, drawerLoading, saving, form,
        showDelete, deleteTarget, deleting,
        load, openAdd, openEdit, saveVendor, confirmDelete, doDelete,
        icon, fmt, fmtDate,
      };
    },
    template: `
<div class="b-page cust-page">

  <!-- ── Toolbar ── -->
  <div class="cust-toolbar">
    <div class="cust-toolbar-left">
      <div class="cust-filters">
        <button v-for="f in [{k:'all',l:'All'},{k:'active',l:'Active'},{k:'disabled',l:'Disabled'}]"
          :key="f.k" class="zb-inv-pill" :class="{'zb-inv-pill-active': activeFilter===f.k}"
          @click="activeFilter=f.k">
          {{f.l}}
          <span class="zb-pill-cnt" :class="activeFilter===f.k?'':'zb-pc-muted'">{{counts[f.k]}}</span>
        </button>
      </div>
    </div>
    <div class="cust-toolbar-right">
      <div class="cust-search">
        <span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span>
        <input v-model="search" placeholder="Search vendors…" class="cust-search-input" autocomplete="off"/>
      </div>
      <button class="zb-tb-btn" @click="load" title="Refresh">
        <span v-html="icon('refresh',13)"></span> Refresh
      </button>
      <button class="zb-tb-btn zb-tb-primary" @click="openAdd">
        <span v-html="icon('plus',13)"></span> New Vendor
      </button>
    </div>
  </div>

  <!-- ── Table ── -->
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Type</th>
            <th>GSTIN</th>
            <th>Email</th>
            <th>Mobile</th>
            <th>City / State</th>
            <th>Status</th>
            <th style="text-align:center;width:100px">Actions</th>
          </tr>
        </thead>
        <tbody>
          <!-- Loading -->
          <template v-if="loading">
            <tr v-for="n in 6" :key="n">
              <td colspan="8" style="padding:12px 14px">
                <div class="b-shimmer" style="height:13px;border-radius:4px;width:70%"></div>
              </td>
            </tr>
          </template>
          <!-- Empty -->
          <tr v-else-if="!filtered.length">
            <td colspan="8" class="cust-empty">
              <div class="cust-empty-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </div>
              <div class="cust-empty-title">{{search ? 'No results found' : 'No vendors yet'}}</div>
              <div class="cust-empty-sub">{{search ? 'Try a different search term' : 'Add your first vendor to get started'}}</div>
              <button v-if="!search" class="nim-btn nim-btn-primary" style="margin-top:12px" @click="openAdd">
                <span v-html="icon('plus',13)"></span> New Vendor
              </button>
            </td>
          </tr>
          <!-- Rows -->
          <tr v-else v-for="v in filtered" :key="v.name"
            class="cust-row" :class="v.disabled?'cust-row-disabled':''"
            @click="openEdit(v.name)">
            <td>
              <div class="cust-name">{{v.supplier_name}}</div>
              <div class="cust-id">{{v.name}}</div>
            </td>
            <td>
              <span class="b-badge" :class="v.supplier_type==='Company'?'b-badge-amber':'b-badge-muted'">
                {{v.supplier_type||'—'}}
              </span>
            </td>
            <td class="cust-mono">{{v.tax_id||'—'}}</td>
            <td class="cust-secondary">{{v.email_id||'—'}}</td>
            <td class="cust-secondary">{{v.mobile_no||'—'}}</td>
            <td class="cust-secondary">
              {{v.city ? (v.city + (v.state ? ', '+v.state : '')) : '—'}}
            </td>
            <td>
              <span class="b-badge" :class="v.disabled?'b-badge-red':'b-badge-green'">
                {{v.disabled?'Disabled':'Active'}}
              </span>
            </td>
            <td @click.stop style="text-align:center">
              <div style="display:flex;gap:4px;justify-content:center">
                <button class="cust-act-btn cust-act-edit" @click="openEdit(v.name)" title="Edit">
                  <span v-html="icon('edit',13)"></span>
                </button>
                <button class="cust-act-btn" style="color:#6b7280;border-color:#e5e7eb"
                  @click="window.open('/app/supplier/'+encodeURIComponent(v.name),'_blank')" title="Open in Frappe">
                  <span v-html="icon('ext',13)"></span>
                </button>
                <button class="cust-act-btn cust-act-del" @click="confirmDelete(v)" title="Delete">
                  <span v-html="icon('trash',13)"></span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">
      Showing {{filtered.length}} of {{list.length}} vendors
    </div>
  </div>

  <!-- ── Add / Edit Drawer ── -->
  <teleport to="body">
    <transition name="cust-drawer-fade">
      <div v-if="showDrawer" class="cust-backdrop" @click.self="showDrawer=false">
        <transition name="cust-drawer-slide">
          <div v-if="showDrawer" class="cust-drawer">

            <!-- Drawer Header -->
            <div class="cust-drawer-header">
              <div class="cust-drawer-header-left">
                <div class="cust-drawer-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div>
                  <div class="cust-drawer-title">{{drawerMode==='add'?'New Vendor':'Edit Vendor'}}</div>
                  <div class="cust-drawer-sub">{{drawerMode==='edit'?form.name:'Fill in vendor details'}}</div>
                </div>
              </div>
              <button class="nim-close" @click="showDrawer=false" v-html="icon('x',15)"></button>
            </div>

            <!-- Loading state -->
            <div v-if="drawerLoading" style="flex:1;display:grid;place-items:center;color:#9ca3af;font-size:13px">
              <div>Loading vendor…</div>
            </div>

            <!-- Drawer Body -->
            <div v-else class="cust-drawer-body">

              <div class="cust-sec-label">Basic Information</div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field" style="grid-column:span 3">
                  <label class="nim-label">Vendor Name <span class="nim-req">*</span></label>
                  <input v-model="form.supplier_name" class="nim-input" placeholder="Company or individual name"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Vendor Type</label>
                  <select v-model="form.supplier_type" class="nim-select">
                    <option>Company</option><option>Individual</option>
                  </select>
                </div>
                <div class="nim-field">
                  <label class="nim-label">GSTIN / Tax ID</label>
                  <input v-model="form.tax_id" class="nim-input" placeholder="27AAPFU0939F1ZV"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Currency</label>
                  <select v-model="form.default_currency" class="nim-select">
                    <option>INR</option><option>USD</option><option>EUR</option><option>GBP</option><option>AED</option><option>SGD</option>
                  </select>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Payment Terms</label>
                  <select v-model="form.payment_terms" class="nim-select">
                    <option value="">Select</option>
                    <option>Net 30</option><option>Net 15</option><option>Net 7</option>
                    <option>Due on Receipt</option><option>End of Month</option>
                  </select>
                </div>
              </div>

              <div class="cust-sec-label">Contact</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field">
                  <label class="nim-label">Email</label>
                  <input v-model="form.email_id" type="email" class="nim-input" placeholder="email@vendor.com"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Mobile</label>
                  <div style="display:flex;">
                    <select v-model="form.mobile_code" style="width:75px; border-right:none; border-top-right-radius:0; border-bottom-right-radius:0; text-align:center; background:#f9fafb; padding:0 5px;" class="nim-input">
                      <option value="+91">🇮🇳 +91</option><option value="+1">🇺🇸 +1</option>
                      <option value="+44">🇬🇧 +44</option><option value="+61">🇦🇺 +61</option>
                      <option value="+971">🇦🇪 +971</option><option value="+65">🇸🇬 +65</option>
                    </select>
                    <input v-model="form.mobile_no" class="nim-input" style="border-top-left-radius:0; border-bottom-left-radius:0; flex:1;" placeholder="98765 43210"/>
                  </div>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Phone</label>
                  <input v-model="form.phone" class="nim-input" placeholder="Landline"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Website</label>
                  <input v-model="form.website" class="nim-input" placeholder="https://"/>
                </div>
              </div>

              <div class="cust-sec-label">Address</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field" style="grid-column:span 2">
                  <label class="nim-label">Address Line 1</label>
                  <input v-model="form.address_line1" class="nim-input" placeholder="Street, building no."/>
                </div>
                <div class="nim-field" style="grid-column:span 2">
                  <label class="nim-label">Address Line 2</label>
                  <input v-model="form.address_line2" class="nim-input" placeholder="Area, landmark"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">City</label>
                  <input v-model="form.city" class="nim-input" placeholder="Mumbai"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">State</label>
                  <input v-model="form.state" class="nim-input" placeholder="Maharashtra"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Pincode</label>
                  <input v-model="form.pincode" class="nim-input" placeholder="400001"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Country</label>
                  <select v-model="form.country" class="nim-select">
                    <option>India</option><option>United States</option><option>United Kingdom</option>
                    <option>Canada</option><option>Australia</option><option>Singapore</option>
                    <option>United Arab Emirates</option><option>Saudi Arabia</option>
                    <option>Germany</option><option>France</option>
                  </select>
                </div>
              </div>

              <div class="cust-sec-label">Account Settings</div>
              <div class="nim-grid-1 nim-mb">
                <div class="nim-field">
                  <label class="nim-label">Default Payable Account</label>
                  <select v-model="form.default_payable_account" class="nim-select">
                    <option value="">Select</option>
                    <option v-for="a in accounts" :key="a.name" :value="a.name">{{a.name}}</option>
                  </select>
                </div>
              </div>

              <!-- Disable toggle (edit only) -->
              <div v-if="drawerMode==='edit'" class="cust-disable-box" @click="form.disabled=form.disabled?0:1">
                <input type="checkbox" :checked="!!form.disabled" @click.stop="form.disabled=form.disabled?0:1" style="width:16px;height:16px;accent-color:#dc2626;cursor:pointer"/>
                <label style="font-size:13px;color:#dc2626;cursor:pointer">Disable this vendor (won't appear in bill dropdowns)</label>
              </div>

            </div>

            <!-- Drawer Footer -->
            <div class="nim-footer">
              <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">Cancel</button>
              <button class="nim-btn nim-btn-primary" @click="saveVendor" :disabled="saving">
                <span v-if="saving" v-html="icon('refresh',13)" style="animation:spin 1s linear infinite"></span>
                {{saving ? 'Saving…' : (drawerMode==='add' ? 'Create Vendor' : 'Save Changes')}}
              </button>
            </div>

          </div>
        </transition>
      </div>
    </transition>
  </teleport>

  <!-- ── Delete Confirm Modal ── -->
  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left">
            <div class="nim-header-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </div>
            <div class="nim-header-title">Delete Vendor?</div>
          </div>
          <button class="nim-close" @click="showDelete=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Are you sure you want to delete <strong>{{deleteTarget?.supplier_name}}</strong>?
            This action cannot be undone.
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Cancel</button>
          <button @click="doDelete" :disabled="deleting"
            style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff;display:inline-flex;align-items:center;gap:7px">
            <span v-if="deleting" v-html="icon('refresh',13)" style="animation:spin 1s linear infinite"></span>
            {{deleting ? 'Deleting…' : 'Yes, Delete'}}
          </button>
        </div>
      </div>
    </div>
  </teleport>

</div>
`});



  /* ═══════════════════════════════════════════════════════════════
     QUOTES COMPONENT
  ═══════════════════════════════════════════════════════════════ */
  const Quotes = defineComponent({
    name: "Quotes",
    setup() {
      const router = useRouter();
      const list = ref([]);
      const customers = ref([]);
      const allItems = ref([]);
      const loading = ref(true);
      const search = ref("");
      const activeFilter = ref("all");

      // Summary
      const summary = computed(() => ({
        total: list.value.length,
        sent: list.value.filter(q => q.status === "Sent").length,
        accepted: list.value.filter(q => q.status === "Accepted").length,
        value: list.value.reduce((s, q) => s + flt(q.grand_total), 0),
      }));

      function isExpired(q) {
        return q.status !== "Converted" && q.status !== "Accepted" &&
          q.expiry && new Date(q.expiry) < new Date();
      }
      function displayStatus(q) {
        if (isExpired(q)) return { label: "Expired", cls: "b-badge-red" };
        return {
          Draft: { label: "Draft", cls: "b-badge-muted" }, Sent: { label: "Sent", cls: "b-badge-blue" },
          Accepted: { label: "Accepted", cls: "b-badge-green" }, Declined: { label: "Declined", cls: "b-badge-red" },
          Converted: { label: "Converted", cls: "b-badge-green" }, Expired: { label: "Expired", cls: "b-badge-red" }
        }
        [q.status] || { label: q.status, cls: "b-badge-muted" };
      }

      const counts = computed(() => ({
        Draft: list.value.filter(q => q.status === "Draft" && !isExpired(q)).length,
        Sent: list.value.filter(q => q.status === "Sent" && !isExpired(q)).length,
        Accepted: list.value.filter(q => q.status === "Accepted").length,
        Expired: list.value.filter(q => isExpired(q)).length,
        Converted: list.value.filter(q => q.status === "Converted").length,
      }));

      const filtered = computed(() => {
        let r = list.value;
        const f = activeFilter.value;
        if (f === "Draft") r = r.filter(q => q.status === "Draft" && !isExpired(q));
        if (f === "Sent") r = r.filter(q => q.status === "Sent" && !isExpired(q));
        if (f === "Accepted") r = r.filter(q => q.status === "Accepted");
        if (f === "Expired") r = r.filter(q => isExpired(q));
        if (f === "Converted") r = r.filter(q => q.status === "Converted");
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(x => (x.name + x.customer + (x.subject || "")).toLowerCase().includes(q));
        return r;
      });

      // ── Drawer state ──
      const showDrawer = ref(false);
      const drawerMode = ref("add");
      const saving = ref(false);
      const selCustomer = ref("");
      const custSearch = ref("");
      const showCustDrop = ref(false);
      const custDropItems = computed(() => {
        const q = custSearch.value.toLowerCase();
        return customers.value.filter(c =>
          (c.customer_name || c.name).toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
        ).slice(0, 40);
      });

      const form = reactive({
        name: "", customer: "", date: "", expiry: "", subject: "",
        status: "Draft", terms: "", notes: "",
        items: [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
        taxes: [],
      });

      const netTotal = computed(() => form.items.reduce((s, r) => s + flt(r.amount), 0));
      const taxTotal = computed(() => form.taxes.reduce((s, t) => s + flt(t.tax_amount), 0));
      const grandTotal = computed(() => Math.round((netTotal.value + taxTotal.value) * 100) / 100);

      function recalc() {
        form.items.forEach(r => { r.amount = Math.round(flt(r.qty) * flt(r.rate) * 100) / 100; });
        form.taxes.forEach(t => { t.tax_amount = flt(t.rate) > 0 ? Math.round(netTotal.value * flt(t.rate) / 100 * 100) / 100 : 0; });
      }

      function addItem() { form.items.push({ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }); }
      function removeItem(i) { if (form.items.length > 1) { form.items.splice(i, 1); recalc(); } }
      function addTax() { form.taxes.push({ tax_type: "CGST", description: "CGST", rate: 9, tax_amount: 0 }); recalc(); }
      function removeTax(i) { form.taxes.splice(i, 1); recalc(); }

      // ── Convert modal ──
      const showConvert = ref(false);
      const convertTarget = ref(null);
      // ── Delete modal ──
      const showDelete = ref(false);
      const deleteTarget = ref(null);
      const deleting = ref(false);

      // ── localStorage helpers ──
      function storeList(q) { try { localStorage.setItem("books_quotes", JSON.stringify(q)); } catch { } }
      function readList() { try { return JSON.parse(localStorage.getItem("books_quotes") || "[]"); } catch { return []; } }
      function nextNum() {
        const nums = readList().map(q => parseInt((q.name || "QT-0").replace(/\D/g, "")) || 0);
        return "QT-" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
      }
      function todayStr() { return new Date().toISOString().slice(0, 10); }
      function addDays(d, n) { const dt = new Date(d); dt.setDate(dt.getDate() + n); return dt.toISOString().slice(0, 10); }

      async function load() {
        loading.value = true;
        list.value = readList();
        loading.value = false;
        try { customers.value = await apiList("Customer", { fields: ["name", "customer_name"], filters: [["disabled", "=", 0]], order: "customer_name asc", limit: 300 }); } catch { }
        try { allItems.value = await apiList("Item", { fields: ["name", "item_name", "item_code", "standard_rate", "description"], limit: 300 }); } catch { }
      }

      function openAdd() {
        drawerMode.value = "add";
        selCustomer.value = "";
        custSearch.value = "";
        Object.assign(form, {
          name: "", customer: "", date: todayStr(), expiry: addDays(todayStr(), 30),
          subject: "", status: "Draft", terms: "", notes: "",
          items: [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }], taxes: [],
        });
        showDrawer.value = true;
      }

      function openEdit(name) {
        const q = list.value.find(x => x.name === name);
        if (!q) return;
        drawerMode.value = "edit";
        selCustomer.value = q.customer || "";
        custSearch.value = q.customer || "";
        Object.assign(form, {
          name: q.name, customer: q.customer || "", date: q.date || todayStr(),
          expiry: q.expiry || "", subject: q.subject || "", status: q.status || "Draft",
          terms: q.terms || "", notes: q.notes || "",
          items: (q.items || [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }]).map(r => ({ ...r })),
          taxes: (q.taxes || []).map(t => ({ ...t })),
        });
        showDrawer.value = true;
      }

      function pickCustomer(c) {
        selCustomer.value = c.name;
        custSearch.value = c.customer_name || c.name;
        form.customer = c.name;
        showCustDrop.value = false;
      }

      function saveQuote(status) {
        const cust = selCustomer.value || custSearch.value.trim();
        if (!cust) { toast("Please select a customer", "error"); return; }
        if (!form.items.some(r => r.item_name && r.item_name.trim() !== "")) {
          toast("Please select at least one item", "error"); return;
        }
        const doc = {
          name: drawerMode.value === "edit" ? form.name : nextNum(),
          customer: cust, date: form.date, expiry: form.expiry,
          subject: form.subject, status: status,
          items: form.items.filter(r => r.item_name || r.rate).map(r => ({ ...r })),
          taxes: form.taxes.map(t => ({ ...t })),
          net_total: Math.round(netTotal.value * 100) / 100,
          grand_total: grandTotal.value,
          terms: form.terms, notes: form.notes,
          created_at: drawerMode.value === "edit"
            ? (list.value.find(q => q.name === form.name) || {}).created_at || todayStr()
            : todayStr(),
        };
        const arr = readList();
        const idx = arr.findIndex(q => q.name === doc.name);
        if (idx >= 0) arr[idx] = doc; else arr.unshift(doc);
        storeList(arr);
        list.value = arr;
        toast(status === "Sent" ? "Quote saved & marked Sent" : "Quote saved as Draft");
        showDrawer.value = false;
      }

      function confirmDelete(q) { deleteTarget.value = q; showDelete.value = true; }
      function doDelete() {
        deleting.value = true;
        const arr = readList().filter(q => q.name !== deleteTarget.value.name);
        storeList(arr); list.value = arr;
        toast("Quote deleted"); showDelete.value = false; deleting.value = false;
      }
      function openConvert(q) { convertTarget.value = q; showConvert.value = true; }
      function doConvert() {
        const arr = readList();
        const idx = arr.findIndex(q => q.name === convertTarget.value.name);
        if (idx >= 0) {
          const q = arr[idx];
          q.source_type = "Quote";
          q.source_name = q.name;
          localStorage.setItem("convert_to_invoice", JSON.stringify(q));
        }
        toast("Drafting invoice — please save it to confirm", "info");
        showConvert.value = false;
        router.push({ name: "invoices" });
      }

      function onItemPick(row) {
        const matching = allItems.value.find(it => it.item_name === row.item_name);
        if (matching) {
          row.rate = matching.standard_rate || 0;
          row.description = matching.description || "";
          recalc();
        }
      }

      onMounted(load);

      return {
        list, loading, allItems, customers, search, activeFilter, filtered, counts, summary, isExpired, displayStatus,
        showDrawer, drawerMode, saving, form, selCustomer, custSearch, showCustDrop,
        custDropItems, netTotal, taxTotal, grandTotal,
        recalc, addItem, removeItem, addTax, removeTax, onItemPick,
        pickCustomer, saveQuote, openAdd, openEdit,
        showConvert, convertTarget, openConvert, doConvert,
        showDelete, deleteTarget, deleting, confirmDelete, doDelete,
        load, icon, fmt, fmtDate, flt,
      };
    },
    template: `
<div class="b-page">

  <!-- Summary strip -->
  <div class="qt-summary">
    <div class="qt-sum-card">
      <div class="qt-sum-label">Total Quotes</div>
      <div class="qt-sum-value">{{summary.total}}</div>
    </div>
    <div class="qt-sum-card">
      <div class="qt-sum-label" style="color:#2563eb">Sent</div>
      <div class="qt-sum-value" style="color:#2563eb">{{summary.sent}}</div>
    </div>
    <div class="qt-sum-card">
      <div class="qt-sum-label" style="color:#059669">Accepted</div>
      <div class="qt-sum-value" style="color:#059669">{{summary.accepted}}</div>
    </div>
    <div class="qt-sum-card">
      <div class="qt-sum-label" style="color:#d97706">Quote Value</div>
      <div class="qt-sum-value" style="color:#d97706">{{fmt(summary.value)}}</div>
    </div>
  </div>

  <!-- Toolbar -->
  <div class="cust-toolbar">
    <div class="cust-toolbar-left">
      <div class="cust-filters">
        <button class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter==='all'}" @click="activeFilter='all'">All</button>
        <button v-for="f in ['Draft','Sent','Accepted','Expired','Converted']" :key="f"
          class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter===f}"
          @click="activeFilter=f">
          {{f}} <span class="zb-pill-cnt" :class="activeFilter===f?'':'zb-pc-muted'">{{counts[f]}}</span>
        </button>
      </div>
    </div>
    <div class="cust-toolbar-right">
      <div class="cust-search">
        <span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span>
        <input v-model="search" placeholder="Search quote, customer…" class="cust-search-input" autocomplete="off"/>
      </div>
      <button class="zb-tb-btn" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="zb-tb-btn zb-tb-primary" @click="openAdd"><span v-html="icon('plus',13)"></span> New Quote</button>
    </div>
  </div>

  <!-- Table -->
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead>
          <tr>
            <th>Quote #</th>
            <th>Customer</th>
            <th>Date</th>
            <th>Valid Until</th>
            <th style="text-align:right">Amount</th>
            <th>Status</th>
            <th style="text-align:center;width:120px">Actions</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading">
            <tr v-for="n in 5" :key="n"><td colspan="7" style="padding:12px 14px"><div class="b-shimmer" style="height:13px;border-radius:4px;width:65%"></div></td></tr>
          </template>
          <tr v-else-if="!filtered.length">
            <td colspan="7" class="cust-empty">
              <div class="cust-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></div>
              <div class="cust-empty-title">{{search?'No results found':'No quotes yet'}}</div>
              <div class="cust-empty-sub">{{search?'Try a different search term':'Create your first quote to send to customers'}}</div>
              <button v-if="!search" class="nim-btn nim-btn-primary" style="margin-top:12px" @click="openAdd"><span v-html="icon('plus',13)"></span> New Quote</button>
            </td>
          </tr>
          <tr v-else v-for="q in filtered" :key="q.name" class="cust-row" @click="openEdit(q.name)">
            <td>
              <div style="color:#2563eb;font-family:monospace;font-size:12px;font-weight:700">{{q.name}}</div>
              <div v-if="q.subject" style="font-size:11.5px;color:#9ca3af;margin-top:1px">{{q.subject}}</div>
            </td>
            <td class="cust-name">{{q.customer||'—'}}</td>
            <td class="cust-secondary">{{fmtDate(q.date)}}</td>
            <td :style="{color: isExpired(q)?'#dc2626':'#374151', fontWeight: isExpired(q)?'600':'400'}" class="cust-secondary">{{fmtDate(q.expiry)||'—'}}</td>
            <td style="text-align:right;font-family:monospace;font-weight:600;color:#111827">{{fmt(q.grand_total)}}</td>
            <td><span class="b-badge" :class="displayStatus(q).cls">{{displayStatus(q).label}}</span></td>
            <td @click.stop style="text-align:center">
              <div style="display:flex;gap:4px;justify-content:center">
                <button class="cust-act-btn cust-act-edit" @click="openEdit(q.name)" title="Edit"><span v-html="icon('edit',13)"></span></button>
                <button v-if="q.status!=='Converted'" class="cust-act-btn" style="color:#059669;border-color:rgba(5,150,105,.3);background:none;width:28px;height:28px;border-radius:6px;border-width:1.5px;cursor:pointer;display:grid;place-items:center;transition:.15s"
                  @click="openConvert(q)" title="Convert to Invoice">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                </button>
                <button class="cust-act-btn cust-act-del" @click="confirmDelete(q)" title="Delete"><span v-html="icon('trash',13)"></span></button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">Showing {{filtered.length}} of {{list.length}} quotes</div>
  </div>

  <!-- ── Add / Edit Drawer ── -->
  <teleport to="body">
    <transition name="cust-drawer-fade">
      <div v-if="showDrawer" class="cust-backdrop" @click.self="showDrawer=false">
        <transition name="cust-drawer-slide">
          <div v-if="showDrawer" class="cust-drawer" style="width:700px">
            <!-- Header -->
            <div class="cust-drawer-header">
              <div class="cust-drawer-header-left">
                <div class="cust-drawer-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                </div>
                <div>
                  <div class="cust-drawer-title">{{drawerMode==='add'?'New Quote':'Edit Quote'}}</div>
                  <div class="cust-drawer-sub">{{drawerMode==='edit'?form.name:'Fill in quote details'}}</div>
                </div>
              </div>
              <button class="nim-close" @click="showDrawer=false" v-html="icon('x',15)"></button>
            </div>

            <!-- Body -->
            <div class="cust-drawer-body">

              <!-- Quote Details -->
              <div class="cust-sec-label">Quote Details</div>
              <div class="nim-grid-3 nim-mb">
                <!-- Customer typeahead -->
                <div class="nim-field" style="position:relative">
                  <label class="nim-label">Customer <span class="nim-req">*</span></label>
                  <input v-model="custSearch" class="nim-input" placeholder="Search customer…"
                    autocomplete="off"
                    @focus="showCustDrop=true"
                    @blur="setTimeout(()=>showCustDrop=false,200)"
                    @input="showCustDrop=true"/>
                  <div v-if="showCustDrop && custDropItems.length" class="qt-cust-drop">
                    <div v-for="c in custDropItems" :key="c.name" class="qt-drop-item" @mousedown.prevent="pickCustomer(c)">
                      <div style="font-weight:600;font-size:13px">{{c.customer_name||c.name}}</div>
                      <div v-if="c.name!==c.customer_name" style="font-size:11px;color:#9ca3af">{{c.name}}</div>
                    </div>
                  </div>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Quote Date <span class="nim-req">*</span></label>
                  <input v-model="form.date" type="date" class="nim-input"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Valid Until</label>
                  <input v-model="form.expiry" type="date" class="nim-input"/>
                </div>
                <div class="nim-field" style="grid-column:span 2">
                  <label class="nim-label">Subject / Title</label>
                  <input v-model="form.subject" class="nim-input" placeholder="e.g. Proposal for Website Design"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Status</label>
                  <select v-model="form.status" class="nim-select">
                    <option>Draft</option><option>Sent</option><option>Accepted</option>
                    <option>Declined</option><option>Expired</option>
                  </select>
                </div>
              </div>

              <!-- Items -->
              <div class="nim-section-header" style="margin-bottom:8px">
                <div class="cust-sec-label" style="margin:0">Line Items</div>
              </div>
              <div class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th style="width:28%">Item / Service </th>
                    <th style="width:25%">Description</th>
                    <th style="width:10%;text-align:center">Qty</th>
                    <th style="width:16%;text-align:right">Rate (₹)</th>
                    <th style="width:16%;text-align:right">Amount (₹)</th>
                    <th style="width:5%"></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(item,i) in form.items" :key="i" class="nim-tr">
                      <td>
                        <searchable-select v-model="item.item_name" :options="allItems" value-key="item_name" label-key="item_name" placeholder="— Select Item —" :compact="true" class="ss-cell-wrap" @update:modelValue="onItemPick(item)"/>
                      </td>
                      <td><input v-model="item.description" class="nim-cell" placeholder="Description"/></td>
                      <td style="text-align:center"><input v-model.number="item.qty" type="number" min="0.01" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                      <td style="text-align:right"><input v-model.number="item.rate" type="number" min="0" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                      <td class="nim-amount" style="text-align:right">{{flt(item.amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                      <td style="text-align:center"><button v-if="form.items.length>1" @click="removeItem(i)" class="nim-del-btn" v-html="icon('trash',13)"></button></td>
                    </tr>
                  </tbody>
                </table>
                <div class="nim-table-footer"><button @click="addItem" class="nim-add-btn"><span v-html="icon('plus',12)"></span> Add Row</button></div>
              </div>

              <!-- Taxes -->
              <div class="nim-section-header nim-mb-sm">
                <div class="cust-sec-label" style="margin:0">Taxes</div>
                <button @click="addTax" class="nim-add-btn"><span v-html="icon('plus',12)"></span> Add Tax</button>
              </div>
              <div v-if="form.taxes.length" class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th style="width:20%">Type</th><th style="width:30%">Description</th>
                    <th style="width:14%;text-align:center">Rate %</th>
                    <th style="width:32%;text-align:right">Amount (₹)</th><th style="width:4%"></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(tax,i) in form.taxes" :key="i" class="nim-tr">
                      <td><select v-model="tax.tax_type" class="nim-cell" @change="tax.description=tax.tax_type;recalc()"><option>CGST</option><option>SGST</option><option>IGST</option><option>Cess</option><option>Other</option></select></td>
                      <td><input v-model="tax.description" class="nim-cell"/></td>
                      <td style="text-align:center"><input v-model.number="tax.rate" type="number" min="0" max="100" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                      <td class="nim-amount" style="text-align:right">{{flt(tax.tax_amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                      <td style="text-align:center"><button @click="removeTax(i)" class="nim-del-btn" v-html="icon('trash',13)"></button></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Totals + Notes -->
              <div class="nim-bottom-row">
                <div class="nim-field" style="flex:1">
                  <label class="nim-label">Terms &amp; Conditions</label>
                  <textarea v-model="form.terms" class="nim-input nim-textarea" rows="3" placeholder="Payment terms, delivery conditions…"></textarea>
                  <label class="nim-label" style="margin-top:10px">Internal Notes <span style="color:#9ca3af;font-weight:400">(not visible to customer)</span></label>
                  <textarea v-model="form.notes" class="nim-input nim-textarea" rows="2" placeholder="Internal notes…"></textarea>
                </div>
                <div class="nim-totals">
                  <div class="nim-total-row"><span class="nim-total-label">Subtotal</span><span class="nim-total-val">{{fmt(netTotal)}}</span></div>
                  <div v-for="tax in form.taxes" :key="tax.tax_type" class="nim-total-row nim-tax-row">
                    <span class="nim-total-label">{{tax.description||tax.tax_type}} ({{tax.rate}}%)</span>
                    <span class="nim-total-val">{{fmt(tax.tax_amount)}}</span>
                  </div>
                  <div class="nim-total-grand"><span>Grand Total</span><span>{{fmt(grandTotal)}}</span></div>
                </div>
              </div>

            </div><!-- /body -->

            <!-- Footer -->
            <div class="nim-footer">
              <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">Cancel</button>
              <div style="display:flex;gap:8px">
                <button class="nim-btn nim-btn-outline" @click="saveQuote('Draft')" :disabled="saving">Save as Draft</button>
                <button class="nim-btn nim-btn-primary" @click="saveQuote('Sent')" :disabled="saving">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Save &amp; Mark Sent
                </button>
              </div>
            </div>
          </div>
        </transition>
      </div>
    </transition>
  </teleport>

  <!-- ── Convert Modal ── -->
  <teleport to="body">
    <div v-if="showConvert" class="nim-overlay" @click.self="showConvert=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header">
          <div class="nim-header-left">
            <div class="nim-header-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div>
            <div class="nim-header-title">Convert Quote</div>
          </div>
          <button class="nim-close" @click="showConvert=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Convert <strong>{{convertTarget?.name}}</strong> for <strong>{{convertTarget?.customer}}</strong>
            worth <strong>{{fmt(convertTarget?.grand_total)}}</strong> to an invoice?
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showConvert=false">Cancel</button>
          <button class="nim-btn nim-btn-primary" @click="doConvert">→ Convert to Invoice</button>
        </div>
      </div>
    </div>
  </teleport>

  <!-- ── Delete Modal ── -->
  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left">
            <div class="nim-header-icon"><span v-html="icon('trash',16)"></span></div>
            <div class="nim-header-title">Delete Quote?</div>
          </div>
          <button class="nim-close" @click="showDelete=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Delete <strong>{{deleteTarget?.name}}</strong>? This cannot be undone.
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Cancel</button>
          <button @click="doDelete" :disabled="deleting"
            style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff">
            {{deleting?'Deleting…':'Yes, Delete'}}
          </button>
        </div>
      </div>
    </div>
  </teleport>

</div>
`});

  /* ═══════════════════════════════════════════════════════════════
     SALES ORDERS COMPONENT
  ═══════════════════════════════════════════════════════════════ */
  const SalesOrders = defineComponent({
    name: "SalesOrders",
    setup() {
      const router = useRouter();

      // ── State ──
      const list = ref([]);
      const customers = ref([]);
      const allItems = ref([]);
      const loading = ref(true);
      const search = ref("");
      const activeFilter = ref("all");

      // Summary
      const summary = computed(() => ({
        total: list.value.length,
        confirmed: list.value.filter(o => o.status === "Confirmed").length,
        progress: list.value.filter(o => o.status === "Processing").length,
        value: list.value.reduce((s, o) => s + flt(o.grand_total), 0),
      }));

      const STATUS_CFG = {
        Draft: { cls: "b-badge-muted", lbl: "Draft" },
        Confirmed: { cls: "b-badge-blue", lbl: "Confirmed" },
        Processing: { cls: "b-badge-amber", lbl: "Processing" },
        Ready: { cls: "b-badge-green", lbl: "Ready" },
        Invoiced: { cls: "b-badge-green", lbl: "Invoiced" },
        Cancelled: { cls: "b-badge-red", lbl: "Cancelled" },
      };
      const STEPS = ["Draft", "Confirmed", "Processing", "Ready", "Invoiced"];

      const counts = computed(() => {
        const r = {};
        ["Draft", "Confirmed", "Processing", "Ready", "Invoiced"].forEach(s => {
          r[s] = list.value.filter(o => o.status === s).length;
        });
        return r;
      });

      function billedPct(o) {
        const gt = flt(o.grand_total);
        return gt > 0 ? Math.min(100, Math.round(flt(o.billed_amount) / gt * 100)) : 0;
      }

      const filtered = computed(() => {
        let r = list.value;
        if (activeFilter.value !== "all") r = r.filter(o => o.status === activeFilter.value);
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(o => (o.name + o.customer + (o.ref_quote || "")).toLowerCase().includes(q));
        return r;
      });

      // ── localStorage ──
      const LKEY = "books_sales_orders";
      function storeList(d) { try { localStorage.setItem(LKEY, JSON.stringify(d)); } catch { } }
      function readList() { try { return JSON.parse(localStorage.getItem(LKEY) || "[]"); } catch { return []; } }
      function nextNum() {
        const nums = readList().map(o => parseInt((o.name || "SO-0").replace(/\D/g, "")) || 0);
        return "SO-" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
      }
      function todayStr() { return new Date().toISOString().slice(0, 10); }
      function addDays(d, n) { const dt = new Date(d); dt.setDate(dt.getDate() + n); return dt.toISOString().slice(0, 10); }

      async function load() {
        loading.value = true;
        list.value = readList();
        loading.value = false;
        try { customers.value = await apiList("Customer", { fields: ["name", "customer_name"], filters: [["disabled", "=", 0]], order: "customer_name asc", limit: 300 }); } catch { }
        try { allItems.value = await apiList("Item", { fields: ["name", "item_name", "item_code", "standard_rate", "description"], order: "item_name asc", limit: 300 }); } catch { }
      }

      // ── Drawer ──
      const showDrawer = ref(false);
      const drawerMode = ref("add"); // "add" | "edit" | "view"
      const saving = ref(false);
      const selCustomer = ref("");
      const custSearch = ref("");
      const showCustDrop = ref(false);
      const custDropItems = computed(() => {
        const q = custSearch.value.toLowerCase();
        return customers.value.filter(c =>
          (c.customer_name || c.name).toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
        ).slice(0, 40);
      });

      const form = reactive({
        name: "", customer: "", order_date: "", delivery_date: "",
        status: "Draft", ref_quote: "", po_number: "", shipping_address: "", terms: "",
        items: [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
        taxes: [],
        net_total: 0, total_tax: 0, grand_total: 0, billed_amount: 0, created_at: "",
      });

      const viewOrder = ref(null); // for read-only view

      const netTotal = computed(() => form.items.reduce((s, r) => s + flt(r.amount), 0));
      const taxTotal = computed(() => form.taxes.reduce((s, t) => s + flt(t.tax_amount), 0));
      const grandTotal = computed(() => Math.round((netTotal.value + taxTotal.value) * 100) / 100);

      function recalc() {
        form.items.forEach(r => { r.amount = Math.round(flt(r.qty) * flt(r.rate) * 100) / 100; });
        form.taxes.forEach(t => { t.tax_amount = flt(t.rate) > 0 ? Math.round(netTotal.value * flt(t.rate) / 100 * 100) / 100 : 0; });
      }
      function addItem() { form.items.push({ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }); }
      function removeItem(i) { if (form.items.length > 1) { form.items.splice(i, 1); recalc(); } }
      function addTax() { form.taxes.push({ tax_type: "CGST", description: "CGST", rate: 9, tax_amount: 0 }); recalc(); }
      function removeTax(i) { form.taxes.splice(i, 1); recalc(); }

      function resetForm(fromOrder) {
        const o = fromOrder || {};
        Object.assign(form, {
          name: o.name || "",
          customer: o.customer || "",
          order_date: o.order_date || todayStr(),
          delivery_date: o.delivery_date || addDays(todayStr(), 14),
          status: o.status || "Draft",
          ref_quote: o.ref_quote || "",
          po_number: o.po_number || "",
          shipping_address: o.shipping_address || "",
          terms: o.terms || "",
          items: o.items?.length ? o.items.map(r => ({ ...r })) : [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
          taxes: (o.taxes || []).map(t => ({ ...t })),
          billed_amount: o.billed_amount || 0,
          created_at: o.created_at || todayStr(),
        });
        selCustomer.value = o.customer || "";
        custSearch.value = o.customer || "";
        showCustDrop.value = false;
      }

      function openAdd() {
        drawerMode.value = "add";
        resetForm();
        showDrawer.value = true;
      }
      function openEdit(name) {
        const o = list.value.find(x => x.name === name);
        if (!o) return;
        drawerMode.value = "edit";
        resetForm(o);
        showDrawer.value = true;
      }
      function openView(name) {
        const o = list.value.find(x => x.name === name);
        if (!o) return;
        viewOrder.value = o;
        drawerMode.value = "view";
        showDrawer.value = true;
      }

      function pickCustomer(c) {
        selCustomer.value = c.name;
        custSearch.value = c.customer_name || c.name;
        form.customer = c.name;
        showCustDrop.value = false;
      }

      function saveOrder(status) {
        const cust = selCustomer.value || custSearch.value.trim();
        if (!cust) { toast("Please select a customer", "error"); return; }
        if (!form.items.some(r => r.item_name && r.item_name.trim() !== "")) {
          toast("Please select at least one item", "error"); return;
        }
        const existing = list.value.find(o => o.name === form.name);
        const doc = {
          name: drawerMode.value === "edit" ? form.name : nextNum(),
          customer: cust,
          order_date: form.order_date || todayStr(),
          delivery_date: form.delivery_date || "",
          status: status,
          ref_quote: form.ref_quote.trim(),
          po_number: form.po_number.trim(),
          shipping_address: form.shipping_address.trim(),
          terms: form.terms.trim(),
          items: form.items.filter(r => r.item_name || r.rate).map(r => ({ ...r })),
          taxes: form.taxes.map(t => ({ ...t })),
          net_total: Math.round(netTotal.value * 100) / 100,
          total_tax: Math.round(taxTotal.value * 100) / 100,
          grand_total: grandTotal.value,
          billed_amount: existing?.billed_amount || 0,
          created_at: existing?.created_at || todayStr(),
        };
        const arr = readList();
        const idx = arr.findIndex(o => o.name === doc.name);
        if (idx >= 0) arr[idx] = doc; else arr.unshift(doc);
        storeList(arr); list.value = arr;
        toast(status === "Confirmed" ? "Order confirmed!" : "Order saved as Draft");
        showDrawer.value = false;
      }

      function advanceStatus(name, newStatus) {
        const arr = readList();
        const o = arr.find(x => x.name === name);
        if (!o) return;
        o.status = newStatus;
        storeList(arr); list.value = arr;
        toast("Order " + name + " → " + newStatus);
        showDrawer.value = false;
      }

      // ── Convert modal ──
      const showConvert = ref(false);
      const convertTarget = ref(null);
      function openConvert(o) { convertTarget.value = o; showConvert.value = true; }
      function doConvert() {
        const arr = readList();
        const o = arr.find(x => x.name === convertTarget.value.name);
        if (o) {
          o.source_type = "Sales Order";
          o.source_name = o.name;
          localStorage.setItem("convert_to_invoice", JSON.stringify(o));
        }
        toast("Drafting invoice — please save it to confirm", "info");
        showConvert.value = false; showDrawer.value = false;
        router.push({ name: "invoices" });
      }

      // ── Delete modal ──
      const showDelete = ref(false);
      const deleteTarget = ref(null);
      const deleting = ref(false);
      function confirmDelete(o) { deleteTarget.value = o; showDelete.value = true; }
      function doDelete() {
        deleting.value = true;
        const arr = readList().filter(o => o.name !== deleteTarget.value.name);
        storeList(arr); list.value = arr;
        toast("Order deleted"); showDelete.value = false; deleting.value = false; showDrawer.value = false;
      }

      function onItemPick(row) {
        const matching = allItems.value.find(it => it.item_name === row.item_name);
        if (matching) {
          row.rate = matching.standard_rate || 0;
          row.description = matching.description || "";
          recalc();
        }
      }

      onMounted(load);

      return {
        list, customers, allItems, loading, search, activeFilter, filtered, counts, summary, billedPct,
        STATUS_CFG, STEPS, showDrawer, drawerMode, saving, viewOrder,
        form, selCustomer, custSearch, showCustDrop, custDropItems,
        netTotal, taxTotal, grandTotal,
        recalc, addItem, removeItem, addTax, removeTax, onItemPick,
        pickCustomer, saveOrder, advanceStatus, openAdd, openEdit, openView,
        showConvert, convertTarget, openConvert, doConvert,
        showDelete, deleteTarget, deleting, confirmDelete, doDelete,
        load, icon, fmt, fmtDate, flt,
      };
    },
    template: `
<div class="b-page">

  <!-- Summary strip -->
  <div class="qt-summary">
    <div class="qt-sum-card"><div class="qt-sum-label">Total Orders</div><div class="qt-sum-value">{{summary.total}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#2563eb">Confirmed</div><div class="qt-sum-value" style="color:#2563eb">{{summary.confirmed}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#d97706">In Progress</div><div class="qt-sum-value" style="color:#d97706">{{summary.progress}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#059669">Order Value</div><div class="qt-sum-value" style="color:#059669">{{fmt(summary.value)}}</div></div>
  </div>

  <!-- Toolbar -->
  <div class="cust-toolbar">
    <div class="cust-toolbar-left">
      <div class="cust-filters">
        <button class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter==='all'}" @click="activeFilter='all'">All</button>
        <button v-for="f in ['Draft','Confirmed','Processing','Ready','Invoiced']" :key="f"
          class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter===f}"
          @click="activeFilter=f">
          {{f}} <span class="zb-pill-cnt" :class="activeFilter===f?'':'zb-pc-muted'">{{counts[f]}}</span>
        </button>
      </div>
    </div>
    <div class="cust-toolbar-right">
      <div class="cust-search">
        <span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span>
        <input v-model="search" placeholder="Search order, customer…" class="cust-search-input" autocomplete="off"/>
      </div>
      <button class="zb-tb-btn" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="zb-tb-btn zb-tb-primary" @click="openAdd"><span v-html="icon('plus',13)"></span> New Order</button>
    </div>
  </div>

  <!-- Table -->
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead>
          <tr>
            <th>Order #</th>
            <th>Customer</th>
            <th>Order Date</th>
            <th>Delivery Date</th>
            <th style="text-align:right">Amount</th>
            <th style="min-width:110px">Billed</th>
            <th>Status</th>
            <th style="text-align:center;width:120px">Actions</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading">
            <tr v-for="n in 5" :key="n"><td colspan="8" style="padding:12px 14px"><div class="b-shimmer" style="height:13px;border-radius:4px;width:65%"></div></td></tr>
          </template>
          <tr v-else-if="!filtered.length">
            <td colspan="8" class="cust-empty">
              <div class="cust-empty-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
              </div>
              <div class="cust-empty-title">{{search?'No results found':'No sales orders yet'}}</div>
              <div class="cust-empty-sub">{{search?'Try a different search term':'Create a sales order to track fulfilment'}}</div>
              <button v-if="!search" class="nim-btn nim-btn-primary" style="margin-top:12px" @click="openAdd"><span v-html="icon('plus',13)"></span> New Order</button>
            </td>
          </tr>
          <tr v-else v-for="o in filtered" :key="o.name" class="cust-row" @click="openView(o.name)">
            <td>
              <div style="color:#2563eb;font-family:monospace;font-size:12px;font-weight:700">{{o.name}}</div>
              <div v-if="o.ref_quote" style="font-size:11px;color:#9ca3af;margin-top:1px">from {{o.ref_quote}}</div>
            </td>
            <td class="cust-name">{{o.customer||'—'}}</td>
            <td class="cust-secondary">{{fmtDate(o.order_date)}}</td>
            <td class="cust-secondary">{{fmtDate(o.delivery_date)||'—'}}</td>
            <td style="text-align:right;font-family:monospace;font-weight:600;color:#111827">{{fmt(o.grand_total)}}</td>
            <td>
              <div style="display:flex;align-items:center;gap:8px">
                <div style="flex:1;background:#e4e8f0;border-radius:20px;height:6px;overflow:hidden;min-width:60px">
                  <div :style="{width:billedPct(o)+'%',height:'100%',borderRadius:'20px',background:billedPct(o)>=100?'#059669':billedPct(o)>0?'#d97706':'#e4e8f0',transition:'width .3s'}"></div>
                </div>
                <span style="font-size:11px;color:#9ca3af;white-space:nowrap">{{billedPct(o)}}%</span>
              </div>
            </td>
            <td><span class="b-badge" :class="(STATUS_CFG[o.status]||STATUS_CFG.Draft).cls">{{(STATUS_CFG[o.status]||STATUS_CFG.Draft).lbl}}</span></td>
            <td @click.stop style="text-align:center">
              <div style="display:flex;gap:4px;justify-content:center">
                <button class="cust-act-btn cust-act-edit" @click="openView(o.name)" title="View">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
                <button v-if="o.status!=='Invoiced'&&o.status!=='Cancelled'" class="cust-act-btn" style="color:#059669;border-color:rgba(5,150,105,.3);background:none;width:28px;height:28px;border-radius:6px;border-width:1.5px;cursor:pointer;display:grid;place-items:center;transition:.15s"
                  @click="openConvert(o)" title="Create Invoice">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </button>
                <button v-if="o.status==='Draft'" class="cust-act-btn cust-act-del" @click="confirmDelete(o)" title="Delete"><span v-html="icon('trash',13)"></span></button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">Showing {{filtered.length}} of {{list.length}} orders</div>
  </div>

  <!-- ── Drawer (Add / Edit / View) ── -->
  <teleport to="body">
    <transition name="cust-drawer-fade">
      <div v-if="showDrawer" class="cust-backdrop" @click.self="showDrawer=false">
        <transition name="cust-drawer-slide">
          <div v-if="showDrawer" class="cust-drawer" style="width:740px">

            <!-- Header -->
            <div class="cust-drawer-header">
              <div class="cust-drawer-header-left">
                <div class="cust-drawer-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                </div>
                <div>
                  <div class="cust-drawer-title">
                    {{drawerMode==='add'?'New Sales Order':drawerMode==='edit'?'Edit Order':viewOrder?.name}}
                  </div>
                  <div class="cust-drawer-sub">
                    {{drawerMode==='view'?'Customer: '+viewOrder?.customer:(drawerMode==='edit'?form.name:'Fill in order details')}}
                  </div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <span v-if="drawerMode==='view'" class="b-badge" :class="(STATUS_CFG[viewOrder?.status]||STATUS_CFG.Draft).cls">
                  {{(STATUS_CFG[viewOrder?.status]||STATUS_CFG.Draft).lbl}}
                </span>
                <button class="nim-close" @click="showDrawer=false" v-html="icon('x',15)"></button>
              </div>
            </div>

            <!-- ── VIEW MODE ── -->
            <div v-if="drawerMode==='view' && viewOrder" class="cust-drawer-body">
              <!-- Status timeline -->
              <div class="so-timeline">
                <div v-for="(step,i) in STEPS" :key="step" class="so-tl-step">
                  <div class="so-tl-dot" :class="STEPS.indexOf(viewOrder.status)>i?'so-done':STEPS.indexOf(viewOrder.status)===i?'so-active':'so-pending'">
                    <svg v-if="STEPS.indexOf(viewOrder.status)>i" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    <span v-else>{{i+1}}</span>
                  </div>
                  <span class="so-tl-label" :class="STEPS.indexOf(viewOrder.status)>=i?'so-tl-active':'so-tl-pending'">{{step}}</span>
                  <div v-if="i<STEPS.length-1" class="so-tl-line" :class="STEPS.indexOf(viewOrder.status)>i?'so-line-done':''"></div>
                </div>
              </div>

              <!-- Details grid -->
              <div class="cust-sec-label" style="margin-top:0">Order Details</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field"><label class="nim-label">Customer</label><div style="font-size:13.5px;font-weight:600;color:#111827;padding:4px 0">{{viewOrder.customer}}</div></div>
                <div class="nim-field"><label class="nim-label">Order Date</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmtDate(viewOrder.order_date)}}</div></div>
                <div class="nim-field"><label class="nim-label">Delivery Date</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmtDate(viewOrder.delivery_date)||'—'}}</div></div>
                <div class="nim-field"><label class="nim-label">Reference Quote</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{viewOrder.ref_quote||'—'}}</div></div>
                <div v-if="viewOrder.po_number" class="nim-field"><label class="nim-label">Customer PO No.</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{viewOrder.po_number}}</div></div>
                <div v-if="viewOrder.shipping_address" class="nim-field" style="grid-column:span 2"><label class="nim-label">Shipping Address</label><div style="font-size:13px;color:#374151;white-space:pre-line;padding:4px 0">{{viewOrder.shipping_address}}</div></div>
              </div>

              <!-- Items -->
              <div class="cust-sec-label">Line Items</div>
              <div class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th>Item</th><th>Description</th>
                    <th style="text-align:center">Qty</th>
                    <th style="text-align:right">Rate</th>
                    <th style="text-align:right">Amount</th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="r in (viewOrder.items||[])" :key="r.item_name" class="nim-tr">
                      <td style="font-weight:600">{{r.item_name||'—'}}</td>
                      <td class="cust-secondary">{{r.description||''}}</td>
                      <td style="text-align:center">{{r.qty||1}}</td>
                      <td class="nim-amount" style="text-align:right">{{fmt(r.rate)}}</td>
                      <td class="nim-amount" style="text-align:right">{{fmt(r.amount)}}</td>
                    </tr>
                    <tr v-if="!viewOrder.items?.length"><td colspan="5" style="text-align:center;padding:14px;color:#9ca3af">No items</td></tr>
                  </tbody>
                </table>
              </div>

              <!-- Totals -->
              <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
                <div class="nim-totals">
                  <div class="nim-total-row"><span class="nim-total-label">Subtotal</span><span class="nim-total-val">{{fmt(viewOrder.net_total)}}</span></div>
                  <div v-if="viewOrder.total_tax" class="nim-total-row nim-tax-row"><span class="nim-total-label">Tax</span><span class="nim-total-val">{{fmt(viewOrder.total_tax)}}</span></div>
                  <div class="nim-total-grand"><span>Grand Total</span><span>{{fmt(viewOrder.grand_total)}}</span></div>
                </div>
              </div>

              <div v-if="viewOrder.terms" class="nim-field nim-mb">
                <label class="nim-label">Terms & Conditions</label>
                <div style="font-size:13px;color:#6b7280;line-height:1.6;white-space:pre-line">{{viewOrder.terms}}</div>
              </div>
            </div>

            <!-- ── EDIT/ADD FORM ── -->
            <div v-else-if="drawerMode!=='view'" class="cust-drawer-body">
              <div class="cust-sec-label" style="margin-top:0">Order Details</div>
              <div class="nim-grid-3 nim-mb">
                <!-- Customer -->
                <div class="nim-field" style="position:relative">
                  <label class="nim-label">Customer <span class="nim-req">*</span></label>
                  <input v-model="custSearch" class="nim-input" placeholder="Search customer…"
                    autocomplete="off"
                    @focus="showCustDrop=true"
                    @blur="setTimeout(()=>showCustDrop=false,200)"
                    @input="showCustDrop=true"/>
                  <div v-if="showCustDrop && custDropItems.length" class="qt-cust-drop">
                    <div v-for="c in custDropItems" :key="c.name" class="qt-drop-item" @mousedown.prevent="pickCustomer(c)">
                      <div style="font-weight:600;font-size:13px">{{c.customer_name||c.name}}</div>
                      <div v-if="c.name!==c.customer_name" style="font-size:11px;color:#9ca3af">{{c.name}}</div>
                    </div>
                  </div>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Order Date <span class="nim-req">*</span></label>
                  <input v-model="form.order_date" type="date" class="nim-input"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Expected Delivery</label>
                  <input v-model="form.delivery_date" type="date" class="nim-input"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Status</label>
                  <select v-model="form.status" class="nim-select">
                    <option>Draft</option><option>Confirmed</option><option>Processing</option><option>Ready</option>
                  </select>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Reference Quote #</label>
                  <input v-model="form.ref_quote" class="nim-input" placeholder="QT-0001"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Customer PO No.</label>
                  <input v-model="form.po_number" class="nim-input" placeholder="Customer purchase order"/>
                </div>
                <div class="nim-field" style="grid-column:span 3">
                  <label class="nim-label">Shipping Address</label>
                  <textarea v-model="form.shipping_address" class="nim-input nim-textarea" rows="2" placeholder="Delivery address (if different from billing)"></textarea>
                </div>
              </div>

              <!-- Items -->
              <div class="nim-section-header" style="margin-bottom:8px">
                <div class="cust-sec-label" style="margin:0">Line Items</div>
              </div>
              <div class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th style="width:28%">Item / Service <span class="nim-req">*</span></th><th style="width:25%">Description</th>
                    <th style="width:10%;text-align:center">Qty</th>
                    <th style="width:16%;text-align:right">Rate (₹)</th>
                    <th style="width:16%;text-align:right">Amount (₹)</th>
                    <th style="width:5%"></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(item,i) in form.items" :key="i" class="nim-tr">
                      <td>
                        <searchable-select v-model="item.item_name" :options="allItems" value-key="item_name" label-key="item_name" placeholder="— Select Item —" :compact="true" class="ss-cell-wrap" @update:modelValue="onItemPick(item)"/>
                      </td>
                      <td><input v-model="item.description" class="nim-cell" placeholder="Description"/></td>
                      <td style="text-align:center"><input v-model.number="item.qty" type="number" min="0.01" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                      <td style="text-align:right"><input v-model.number="item.rate" type="number" min="0" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                      <td class="nim-amount" style="text-align:right">{{flt(item.amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                      <td style="text-align:center"><button v-if="form.items.length>1" @click="removeItem(i)" class="nim-del-btn" v-html="icon('trash',13)"></button></td>
                    </tr>
                  </tbody>
                </table>
                <div class="nim-table-footer"><button @click="addItem" class="nim-add-btn"><span v-html="icon('plus',12)"></span> Add Row</button></div>
              </div>

              <!-- Taxes -->
              <div class="nim-section-header nim-mb-sm">
                <div class="cust-sec-label" style="margin:0">Taxes</div>
                <button @click="addTax" class="nim-add-btn"><span v-html="icon('plus',12)"></span> Add Tax</button>
              </div>
              <div v-if="form.taxes.length" class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th style="width:20%">Type</th><th style="width:30%">Description</th>
                    <th style="width:14%;text-align:center">Rate %</th>
                    <th style="width:32%;text-align:right">Amount (₹)</th><th style="width:4%"></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(tax,i) in form.taxes" :key="i" class="nim-tr">
                      <td><select v-model="tax.tax_type" class="nim-cell" @change="tax.description=tax.tax_type;recalc()"><option>CGST</option><option>SGST</option><option>IGST</option><option>Cess</option><option>Other</option></select></td>
                      <td><input v-model="tax.description" class="nim-cell"/></td>
                      <td style="text-align:center"><input v-model.number="tax.rate" type="number" min="0" max="100" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                      <td class="nim-amount" style="text-align:right">{{flt(tax.tax_amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                      <td style="text-align:center"><button @click="removeTax(i)" class="nim-del-btn" v-html="icon('trash',13)"></button></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Totals + Terms -->
              <div class="nim-bottom-row">
                <div class="nim-field" style="flex:1">
                  <label class="nim-label">Terms &amp; Conditions</label>
                  <textarea v-model="form.terms" class="nim-input nim-textarea" rows="4" placeholder="Delivery terms, payment terms, warranty…"></textarea>
                </div>
                <div class="nim-totals">
                  <div class="nim-total-row"><span class="nim-total-label">Subtotal</span><span class="nim-total-val">{{fmt(netTotal)}}</span></div>
                  <div v-for="tax in form.taxes" :key="tax.tax_type" class="nim-total-row nim-tax-row">
                    <span class="nim-total-label">{{tax.description||tax.tax_type}} ({{tax.rate}}%)</span>
                    <span class="nim-total-val">{{fmt(tax.tax_amount)}}</span>
                  </div>
                  <div class="nim-total-grand"><span>Grand Total</span><span>{{fmt(grandTotal)}}</span></div>
                </div>
              </div>
            </div>

            <!-- Footer -->
            <div class="nim-footer">
              <!-- View mode footer -->
              <template v-if="drawerMode==='view' && viewOrder">
                <div style="font-size:12px;color:#9ca3af">Created {{fmtDate(viewOrder.created_at)}}</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="nim-btn nim-btn-ghost" @click="openEdit(viewOrder.name)"><span v-html="icon('edit',13)"></span> Edit</button>
                  <button v-if="viewOrder.status==='Draft'" class="nim-btn" style="background:#2563eb;color:#fff;height:37px;padding:0 14px;border-radius:8px;font-size:13.5px;font-weight:600;border:none;cursor:pointer"
                    @click="advanceStatus(viewOrder.name,'Confirmed')">Confirm Order</button>
                  <button v-if="viewOrder.status==='Confirmed'" class="nim-btn" style="background:#d97706;color:#fff;height:37px;padding:0 14px;border-radius:8px;font-size:13.5px;font-weight:600;border:none;cursor:pointer"
                    @click="advanceStatus(viewOrder.name,'Processing')">Mark Processing</button>
                  <button v-if="viewOrder.status==='Processing'" class="nim-btn" style="background:#059669;color:#fff;height:37px;padding:0 14px;border-radius:8px;font-size:13.5px;font-weight:600;border:none;cursor:pointer"
                    @click="advanceStatus(viewOrder.name,'Ready')">Mark Ready</button>
                  <button v-if="viewOrder.status!=='Invoiced'&&viewOrder.status!=='Cancelled'" class="nim-btn nim-btn-primary" @click="openConvert(viewOrder)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    Create Invoice
                  </button>
                </div>
              </template>
              <!-- Add/Edit footer -->
              <template v-else-if="drawerMode!=='view'">
                <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">Cancel</button>
                <div style="display:flex;gap:8px">
                  <button class="nim-btn nim-btn-outline" @click="saveOrder('Draft')" :disabled="saving">Save as Draft</button>
                  <button class="nim-btn nim-btn-primary" @click="saveOrder(drawerMode==='edit'?form.status:'Confirmed')" :disabled="saving">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {{drawerMode==='edit'?'Save Changes':'Confirm Order'}}
                  </button>
                </div>
              </template>
            </div>
          </div>
        </transition>
      </div>
    </transition>
  </teleport>

  <!-- ── Convert to Invoice Modal ── -->
  <teleport to="body">
    <div v-if="showConvert" class="nim-overlay" @click.self="showConvert=false">
      <div class="nim-dialog" style="max-width:440px">
        <div class="nim-header">
          <div class="nim-header-left">
            <div class="nim-header-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
            <div class="nim-header-title">Create Invoice from Order</div>
          </div>
          <button class="nim-close" @click="showConvert=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Create a Sales Invoice from order <strong>{{convertTarget?.name}}</strong> for
            <strong>{{convertTarget?.customer}}</strong> — <strong>{{fmt(convertTarget?.grand_total)}}</strong>?
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showConvert=false">Cancel</button>
          <button class="nim-btn nim-btn-primary" @click="doConvert">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Create Invoice
          </button>
        </div>
      </div>
    </div>
  </teleport>

  <!-- ── Delete Modal ── -->
  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left">
            <div class="nim-header-icon"><span v-html="icon('trash',16)"></span></div>
            <div class="nim-header-title">Delete Sales Order?</div>
          </div>
          <button class="nim-close" @click="showDelete=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Delete order <strong>{{deleteTarget?.name}}</strong>? This cannot be undone.
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Keep It</button>
          <button @click="doDelete" :disabled="deleting"
            style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff">
            {{deleting?'Deleting…':'Yes, Delete'}}
          </button>
        </div>
      </div>
    </div>
  </teleport>

</div>
`});

  /* ═══════════════════════════════════════════════════════════════
     RECURRING INVOICES COMPONENT
  ═══════════════════════════════════════════════════════════════ */
  const RecurringInvoices = defineComponent({
    name: "RecurringInvoices",
    setup() {
      const LKEY = "books_recurring";
      const FREQ_DAYS = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, halfyearly: 182, yearly: 365 };
      const FREQ_LABEL = { weekly: "Weekly", biweekly: "Every 2 Weeks", monthly: "Monthly", quarterly: "Quarterly", halfyearly: "Half Yearly", yearly: "Yearly" };

      const list = ref([]);
      const customers = ref([]);
      const allItems = ref([]);
      const loading = ref(true);
      const search = ref("");
      const activeFilter = ref("all");

      // ── Storage ──
      function storeList(d) { try { localStorage.setItem(LKEY, JSON.stringify(d)); } catch { } }
      function readList() { try { return JSON.parse(localStorage.getItem(LKEY) || "[]"); } catch { return []; } }
      function nextNum() {
        const nums = readList().map(s => parseInt((s.name || "REC-0").replace(/\D/g, "")) || 0);
        return "REC-" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
      }
      function todayStr() { return new Date().toISOString().slice(0, 10); }

      // ── Frequency helpers ──
      function addFreq(dateStr, freq) {
        const d = new Date(dateStr);
        switch (freq) {
          case "weekly": d.setDate(d.getDate() + 7); break;
          case "biweekly": d.setDate(d.getDate() + 14); break;
          case "monthly": d.setMonth(d.getMonth() + 1); break;
          case "quarterly": d.setMonth(d.getMonth() + 3); break;
          case "halfyearly": d.setMonth(d.getMonth() + 6); break;
          case "yearly": d.setFullYear(d.getFullYear() + 1); break;
        }
        return d.toISOString().slice(0, 10);
      }
      function getNextDates(start, freq, end, count = 6) {
        const dates = []; let cur = start;
        const endD = end ? new Date(end) : null;
        while (dates.length < count) {
          const d = new Date(cur);
          if (endD && d > endD) break;
          dates.push(cur);
          const next = addFreq(cur, freq);
          if (next === cur) break;
          cur = next;
        }
        return dates;
      }
      function getNextDue(sched) {
        if (sched.status !== "Active") return null;
        const hist = sched.history || [];
        const lastDate = hist.length ? hist[hist.length - 1].date : null;
        const base = lastDate ? addFreq(lastDate, sched.frequency) : sched.start_date;
        const endD = sched.end_date ? new Date(sched.end_date) : null;
        if (endD && new Date(base) > endD) return null;
        return base;
      }
      function daysUntil(dateStr) {
        if (!dateStr) return null;
        return Math.round((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
      }

      // ── Summary ──
      const summary = computed(() => {
        const active = list.value.filter(s => s.status === "Active");
        const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
        const due = active.filter(s => { const n = getNextDue(s); return n && new Date(n) <= weekEnd; });
        const monthly = active.reduce((sum, s) => {
          const d = FREQ_DAYS[s.frequency] || 30;
          return sum + flt(s.grand_total) * (30 / d);
        }, 0);
        return { total: list.value.length, active: active.length, due: due.length, value: Math.round(monthly) };
      });

      const counts = computed(() => ({
        Active: list.value.filter(s => s.status === "Active").length,
        Paused: list.value.filter(s => s.status === "Paused").length,
        Ended: list.value.filter(s => s.status === "Ended").length,
      }));

      const filtered = computed(() => {
        let r = activeFilter.value === "all" ? list.value : list.value.filter(s => s.status === activeFilter.value);
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(s => (s.name + s.customer + (s.schedule_name || "")).toLowerCase().includes(q));
        return r;
      });

      // ── Drawer ──
      const showDrawer = ref(false);
      const drawerMode = ref("add");
      const saving = ref(false);
      const selCustomer = ref("");
      const custSearch = ref("");
      const showCustDrop = ref(false);
      const custDropItems = computed(() => {
        const q = custSearch.value.toLowerCase();
        return customers.value.filter(c =>
          (c.customer_name || c.name).toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
        ).slice(0, 40);
      });

      const form = reactive({
        name: "", customer: "", schedule_name: "",
        frequency: "monthly", start_date: "", end_date: "",
        payment_terms: "", status: "Active", notes: "",
        items: [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
        taxes: [], history: [],
      });

      const netTotal = computed(() => form.items.reduce((s, r) => s + flt(r.amount), 0));
      const taxTotal = computed(() => form.taxes.reduce((s, t) => s + flt(t.tax_amount), 0));
      const grandTotal = computed(() => Math.round((netTotal.value + taxTotal.value) * 100) / 100);

      const previewDates = computed(() => {
        if (!form.start_date) return [];
        return getNextDates(form.start_date, form.frequency, form.end_date, 6);
      });

      function recalc() {
        form.items.forEach(r => { r.amount = Math.round(flt(r.qty) * flt(r.rate) * 100) / 100; });
        form.taxes.forEach(t => { t.tax_amount = flt(t.rate) > 0 ? Math.round(netTotal.value * flt(t.rate) / 100 * 100) / 100 : 0; });
      }
      function addItem() { form.items.push({ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }); }
      function removeItem(i) { if (form.items.length > 1) { form.items.splice(i, 1); recalc(); } }
      function addTax() { form.taxes.push({ tax_type: "CGST", description: "CGST", rate: 9, tax_amount: 0 }); recalc(); }
      function removeTax(i) { form.taxes.splice(i, 1); recalc(); }

      function pickCustomer(c) {
        selCustomer.value = c.name;
        custSearch.value = c.customer_name || c.name;
        form.customer = c.name;
        showCustDrop.value = false;
      }

      function resetForm(from) {
        const s = from || {};
        Object.assign(form, {
          name: s.name || "", customer: s.customer || "", schedule_name: s.schedule_name || "",
          frequency: s.frequency || "monthly", start_date: s.start_date || todayStr(),
          end_date: s.end_date || "", payment_terms: s.payment_terms || "",
          status: s.status || "Active", notes: s.notes || "",
          items: s.items?.length ? s.items.map(r => ({ ...r })) : [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
          taxes: (s.taxes || []).map(t => ({ ...t })),
          history: s.history || [],
        });
        selCustomer.value = s.customer || "";
        custSearch.value = s.customer || "";
        showCustDrop.value = false;
      }

      function openAdd() {
        drawerMode.value = "add"; resetForm();
        showDrawer.value = true;
      }
      function openEdit(name) {
        const s = list.value.find(x => x.name === name); if (!s) return;
        drawerMode.value = "edit"; resetForm(s);
        showDrawer.value = true;
      }

      function saveSchedule(status) {
        const cust = selCustomer.value || custSearch.value.trim();
        if (!cust) { toast("Please select a customer", "error"); return; }
        if (!form.start_date) { toast("Please set a Start Date", "error"); return; }
        const existing = list.value.find(s => s.name === form.name);
        const doc = {
          name: drawerMode.value === "edit" ? form.name : nextNum(),
          customer: cust, schedule_name: form.schedule_name.trim(),
          frequency: form.frequency, start_date: form.start_date,
          end_date: form.end_date, payment_terms: form.payment_terms,
          status: status, notes: form.notes.trim(),
          items: form.items.filter(r => r.item_name || r.rate).map(r => ({ ...r })),
          taxes: form.taxes.map(t => ({ ...t })),
          net_total: Math.round(netTotal.value * 100) / 100,
          total_tax: Math.round(taxTotal.value * 100) / 100,
          grand_total: grandTotal.value,
          history: existing?.history || form.history || [],
          created_at: existing?.created_at || todayStr(),
        };
        const arr = readList();
        const idx = arr.findIndex(s => s.name === doc.name);
        if (idx >= 0) arr[idx] = doc; else arr.unshift(doc);
        storeList(arr); list.value = arr;
        toast(status === "Active" ? (drawerMode.value === "edit" ? "Schedule updated" : "Schedule activated!") : "Schedule saved");
        showDrawer.value = false;
      }

      function toggleStatus(s) {
        const arr = readList();
        const o = arr.find(x => x.name === s.name); if (!o) return;
        o.status = o.status === "Active" ? "Paused" : "Active";
        storeList(arr); list.value = arr;
        toast("Schedule " + o.status.toLowerCase());
      }

      // ── Generate modal ──
      const showGenerate = ref(false);
      const generateTarget = ref(null);
      function openGenerate(s) { generateTarget.value = s; showGenerate.value = true; }
      function doGenerate() {
        const arr = readList();
        const s = arr.find(x => x.name === generateTarget.value.name); if (!s) { showGenerate.value = false; return; }
        const entry = { date: todayStr(), amount: s.grand_total, inv_ref: "INV-AUTO-" + Date.now().toString(36).toUpperCase() };
        s.history = (s.history || []);
        s.history.push(entry);
        storeList(arr); list.value = arr;
        toast(`Invoice ${entry.inv_ref} generated for ${s.customer}`, "info");
        showGenerate.value = false;
      }

      // ── History modal ──
      const showHistory = ref(false);
      const histTarget = ref(null);
      function openHistory(s) { histTarget.value = s; showHistory.value = true; }

      // ── Delete modal ──
      const showDelete = ref(false);
      const deleteTarget = ref(null);
      const deleting = ref(false);
      function confirmDelete(s) { deleteTarget.value = s; showDelete.value = true; }
      function doDelete() {
        deleting.value = true;
        const arr = readList().filter(s => s.name !== deleteTarget.value.name);
        storeList(arr); list.value = arr;
        toast("Schedule deleted"); showDelete.value = false; deleting.value = false;
      }

      async function load() {
        loading.value = true;
        list.value = readList();
        loading.value = false;
        try { customers.value = await apiList("Customer", { fields: ["name", "customer_name"], filters: [["disabled", "=", 0]], order: "customer_name asc", limit: 300 }); } catch { }
        try { allItems.value = await apiList("Item", { fields: ["name", "item_name", "item_code", "standard_rate", "description"], limit: 300, order: "item_name asc" }); } catch { }
      }

      onMounted(load);

      function onItemPick(row) {
        const matching = allItems.value.find(it => it.item_name === row.item_name);
        if (matching) {
          row.rate = matching.standard_rate || 0;
          row.description = matching.description || "";
          recalc();
        }
      }

      return {
        list, loading, search, allItems, activeFilter, filtered, counts, summary,
        FREQ_LABEL, getNextDue, daysUntil,
        showDrawer, drawerMode, saving, form, selCustomer, custSearch, showCustDrop, custDropItems,
        netTotal, taxTotal, grandTotal, previewDates, todayStr,
        recalc, addItem, removeItem, addTax, removeTax, onItemPick,
        pickCustomer, saveSchedule, toggleStatus, openAdd, openEdit,
        showGenerate, generateTarget, openGenerate, doGenerate,
        showHistory, histTarget, openHistory,
        showDelete, deleteTarget, deleting, confirmDelete, doDelete,
        load, icon, fmt, fmtDate, flt,
      };
    },
    template: `
<div class="b-page">

  <!-- Summary strip -->
  <div class="qt-summary">
    <div class="qt-sum-card"><div class="qt-sum-label">Total Schedules</div><div class="qt-sum-value">{{summary.total}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#059669">Active</div><div class="qt-sum-value" style="color:#059669">{{summary.active}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#d97706">Due This Week</div><div class="qt-sum-value" style="color:#d97706">{{summary.due}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#2563eb">Monthly Value</div><div class="qt-sum-value" style="color:#2563eb">{{fmt(summary.value)}}</div></div>
  </div>

  <!-- Toolbar -->
  <div class="cust-toolbar">
    <div class="cust-toolbar-left">
      <div class="cust-filters">
        <button class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter==='all'}" @click="activeFilter='all'">All</button>
        <button v-for="f in ['Active','Paused','Ended']" :key="f"
          class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter===f}"
          @click="activeFilter=f">
          {{f}} <span class="zb-pill-cnt" :class="activeFilter===f?'':'zb-pc-muted'">{{counts[f]}}</span>
        </button>
      </div>
    </div>
    <div class="cust-toolbar-right">
      <div class="cust-search">
        <span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span>
        <input v-model="search" placeholder="Search schedule, customer…" class="cust-search-input" autocomplete="off"/>
      </div>
      <button class="zb-tb-btn" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="zb-tb-btn zb-tb-primary" @click="openAdd"><span v-html="icon('plus',13)"></span> New Schedule</button>
    </div>
  </div>

  <!-- Table -->
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead>
          <tr>
            <th>Schedule</th>
            <th>Customer</th>
            <th>Frequency</th>
            <th>Amount</th>
            <th>Next Invoice</th>
            <th>End Date</th>
            <th style="text-align:center">Invoices</th>
            <th>Status</th>
            <th style="text-align:center;width:130px">Actions</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading">
            <tr v-for="n in 4" :key="n"><td colspan="9" style="padding:12px 14px"><div class="b-shimmer" style="height:13px;border-radius:4px;width:65%"></div></td></tr>
          </template>
          <tr v-else-if="!filtered.length">
            <td colspan="9" class="cust-empty">
              <div class="cust-empty-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              </div>
              <div class="cust-empty-title">{{search?'No schedules match':'No recurring invoices yet'}}</div>
              <div class="cust-empty-sub">{{search?'Try a different search':'Set up automatic invoice generation for subscriptions and retainers'}}</div>
              <button v-if="!search" class="nim-btn nim-btn-primary" style="margin-top:12px" @click="openAdd"><span v-html="icon('plus',13)"></span> New Schedule</button>
            </td>
          </tr>
          <tr v-else v-for="s in filtered" :key="s.name" class="cust-row" @click="openEdit(s.name)">
            <td>
              <div style="color:#2563eb;font-family:monospace;font-size:12px;font-weight:700">{{s.name}}</div>
              <div v-if="s.schedule_name" style="font-size:11.5px;color:#9ca3af;margin-top:1px">{{s.schedule_name}}</div>
            </td>
            <td class="cust-name">{{s.customer||'—'}}</td>
            <td class="cust-secondary">{{FREQ_LABEL[s.frequency]||s.frequency}}</td>
            <td style="font-family:monospace;font-weight:600;color:#111827">{{fmt(s.grand_total)}}</td>
            <td>
              <template v-if="s.status==='Active' && getNextDue(s)">
                <span :class="['ri-next-chip', daysUntil(getNextDue(s))===0?'ri-today':daysUntil(getNextDue(s))<=3?'ri-soon':'ri-ok']">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  {{daysUntil(getNextDue(s))===0?'Today':daysUntil(getNextDue(s))===1?'Tomorrow':fmtDate(getNextDue(s))}}
                </span>
              </template>
              <span v-else class="ri-next-chip ri-none">—</span>
            </td>
            <td class="cust-secondary">{{fmtDate(s.end_date)||'No end'}}</td>
            <td style="text-align:center;font-family:monospace;font-size:13px;font-weight:600;color:#2563eb">{{(s.history||[]).length}}</td>
            <td>
              <span class="b-badge" :class="s.status==='Active'?'b-badge-green':s.status==='Paused'?'b-badge-amber':'b-badge-muted'">
                {{s.status}}
              </span>
            </td>
            <td @click.stop style="text-align:center">
              <div style="display:flex;gap:3px;justify-content:center;flex-wrap:wrap">
                <!-- Generate now -->
                <button v-if="s.status==='Active'" class="cust-act-btn" style="color:#059669;border-color:rgba(5,150,105,.3);background:none;width:28px;height:28px;border-radius:6px;border-width:1.5px;cursor:pointer;display:grid;place-items:center"
                  @click="openGenerate(s)" title="Generate Invoice Now">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                </button>
                <!-- Pause/Resume -->
                <button v-if="s.status==='Active'" class="cust-act-btn" style="color:#d97706;border-color:rgba(217,119,6,.3);background:none;width:28px;height:28px;border-radius:6px;border-width:1.5px;cursor:pointer;display:grid;place-items:center"
                  @click="toggleStatus(s)" title="Pause">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
                <button v-else-if="s.status==='Paused'" class="cust-act-btn" style="color:#059669;border-color:rgba(5,150,105,.3);background:none;width:28px;height:28px;border-radius:6px;border-width:1.5px;cursor:pointer;display:grid;place-items:center"
                  @click="toggleStatus(s)" title="Resume">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
                <!-- History -->
                <button class="cust-act-btn cust-act-edit" @click="openHistory(s)" title="Invoice History">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="12 8 12 12 14 14"/><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/></svg>
                </button>
                <!-- Delete -->
                <button class="cust-act-btn cust-act-del" @click="confirmDelete(s)" title="Delete"><span v-html="icon('trash',13)"></span></button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">Showing {{filtered.length}} of {{list.length}} schedules</div>
  </div>

  <!-- ── Add/Edit Drawer ── -->
  <teleport to="body">
    <transition name="cust-drawer-fade">
      <div v-if="showDrawer" class="cust-backdrop" @click.self="showDrawer=false">
        <transition name="cust-drawer-slide">
          <div v-if="showDrawer" class="cust-drawer" style="width:700px">
            <div class="cust-drawer-header">
              <div class="cust-drawer-header-left">
                <div class="cust-drawer-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                </div>
                <div>
                  <div class="cust-drawer-title">{{drawerMode==='add'?'New Recurring Invoice':'Edit Schedule'}}</div>
                  <div class="cust-drawer-sub">{{drawerMode==='edit'?form.name:'Set up automatic invoice generation'}}</div>
                </div>
              </div>
              <button class="nim-close" @click="showDrawer=false" v-html="icon('x',15)"></button>
            </div>

            <div class="cust-drawer-body">

              <!-- Schedule Details -->
              <div class="cust-sec-label" style="margin-top:0">Schedule Details</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field" style="position:relative">
                  <label class="nim-label">Customer <span class="nim-req">*</span></label>
                  <input v-model="custSearch" class="nim-input" placeholder="Search customer…"
                    autocomplete="off" @focus="showCustDrop=true" @blur="setTimeout(()=>showCustDrop=false,200)" @input="showCustDrop=true"/>
                  <div v-if="showCustDrop && custDropItems.length" class="qt-cust-drop">
                    <div v-for="c in custDropItems" :key="c.name" class="qt-drop-item" @mousedown.prevent="pickCustomer(c)">
                      <div style="font-weight:600;font-size:13px">{{c.customer_name||c.name}}</div>
                      <div v-if="c.name!==c.customer_name" style="font-size:11px;color:#9ca3af">{{c.name}}</div>
                    </div>
                  </div>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Schedule Name</label>
                  <input v-model="form.schedule_name" class="nim-input" placeholder="e.g. Monthly Retainer — ACME Corp"/>
                </div>
              </div>

              <div class="nim-grid-3 nim-mb">
                <div class="nim-field">
                  <label class="nim-label">Frequency <span class="nim-req">*</span></label>
                  <select v-model="form.frequency" class="nim-select">
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Every 2 Weeks</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="halfyearly">Half Yearly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Start Date <span class="nim-req">*</span></label>
                  <input v-model="form.start_date" type="date" class="nim-input"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">End Date</label>
                  <input v-model="form.end_date" type="date" class="nim-input"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Payment Terms</label>
                  <select v-model="form.payment_terms" class="nim-select">
                    <option value="">Select</option>
                    <option>Net 30</option><option>Net 15</option><option>Net 7</option><option>Due on Receipt</option>
                  </select>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Status</label>
                  <select v-model="form.status" class="nim-select">
                    <option>Active</option><option>Paused</option>
                  </select>
                </div>
              </div>

              <!-- Schedule preview -->
              <div class="ri-schedule-preview nim-mb" v-if="previewDates.length">
                <div class="ri-preview-label">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  Next invoice dates
                </div>
                <div class="ri-preview-dates">
                  <span v-for="(d,i) in previewDates" :key="d"
                    :class="['ri-sdate', d<todayStr()?'ri-sdate-past':i===previewDates.findIndex(x=>x>=todayStr())?'ri-sdate-next':'']">
                    {{fmtDate(d)}}
                  </span>
                </div>
              </div>

              <!-- Items -->
              <div class="nim-section-header" style="margin-bottom:8px">
                <div class="cust-sec-label" style="margin:0">Invoice Items</div>
              </div>
              <div class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th style="width:30%">Item / Service</th><th style="width:26%">Description</th>
                    <th style="width:10%;text-align:center">Qty</th>
                    <th style="width:16%;text-align:right">Rate (₹)</th>
                    <th style="width:14%;text-align:right">Amount</th>
                    <th style="width:4%"></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(item,i) in form.items" :key="i" class="nim-tr">
                      <td>
                        <searchable-select v-model="item.item_name" :options="allItems" value-key="item_name" label-key="item_name" placeholder="— Select Item —" :compact="true" class="ss-cell-wrap" @update:modelValue="onItemPick(item)"/>
                      </td>
                      <td><input v-model="item.description" class="nim-cell" placeholder="Description"/></td>
                      <td style="text-align:center"><input v-model.number="item.qty" type="number" min="0.01" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                      <td style="text-align:right"><input v-model.number="item.rate" type="number" min="0" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                      <td class="nim-amount" style="text-align:right">{{flt(item.amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                      <td style="text-align:center"><button v-if="form.items.length>1" @click="removeItem(i)" class="nim-del-btn" v-html="icon('trash',13)"></button></td>
                    </tr>
                  </tbody>
                </table>
                <div class="nim-table-footer"><button @click="addItem" class="nim-add-btn"><span v-html="icon('plus',12)"></span> Add Row</button></div>
              </div>

              <!-- Taxes -->
              <div class="nim-section-header nim-mb-sm">
                <div class="cust-sec-label" style="margin:0">Taxes</div>
                <button @click="addTax" class="nim-add-btn"><span v-html="icon('plus',12)"></span> Add Tax</button>
              </div>
              <div v-if="form.taxes.length" class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th style="width:20%">Type</th><th style="width:30%">Description</th>
                    <th style="width:14%;text-align:center">Rate %</th>
                    <th style="width:32%;text-align:right">Amount (₹)</th><th style="width:4%"></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(tax,i) in form.taxes" :key="i" class="nim-tr">
                      <td><select v-model="tax.tax_type" class="nim-cell" @change="tax.description=tax.tax_type;recalc()"><option>CGST</option><option>SGST</option><option>IGST</option><option>Cess</option><option>Other</option></select></td>
                      <td><input v-model="tax.description" class="nim-cell"/></td>
                      <td style="text-align:center"><input v-model.number="tax.rate" type="number" min="0" max="100" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                      <td class="nim-amount" style="text-align:right">{{flt(tax.tax_amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                      <td style="text-align:center"><button @click="removeTax(i)" class="nim-del-btn" v-html="icon('trash',13)"></button></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Totals + Notes -->
              <div class="nim-bottom-row">
                <div class="nim-field" style="flex:1">
                  <label class="nim-label">Notes / Email Message</label>
                  <textarea v-model="form.notes" class="nim-input nim-textarea" rows="3" placeholder="Message to include on each generated invoice…"></textarea>
                </div>
                <div class="nim-totals">
                  <div class="nim-total-row"><span class="nim-total-label">Per Invoice Subtotal</span><span class="nim-total-val">{{fmt(netTotal)}}</span></div>
                  <div v-for="tax in form.taxes" :key="tax.tax_type" class="nim-total-row nim-tax-row">
                    <span class="nim-total-label">{{tax.description||tax.tax_type}} ({{tax.rate}}%)</span>
                    <span class="nim-total-val">{{fmt(tax.tax_amount)}}</span>
                  </div>
                  <div class="nim-total-grand"><span>Per Invoice Total</span><span>{{fmt(grandTotal)}}</span></div>
                </div>
              </div>

            </div>

            <div class="nim-footer">
              <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">Cancel</button>
              <div style="display:flex;gap:8px">
                <button class="nim-btn nim-btn-outline" @click="saveSchedule(form.status||'Active')" :disabled="saving">Save</button>
                <button class="nim-btn nim-btn-primary" @click="saveSchedule('Active')" :disabled="saving">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Save &amp; Activate
                </button>
              </div>
            </div>
          </div>
        </transition>
      </div>
    </transition>
  </teleport>

  <!-- ── Generate Now Modal ── -->
  <teleport to="body">
    <div v-if="showGenerate" class="nim-overlay" @click.self="showGenerate=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header">
          <div class="nim-header-left">
            <div class="nim-header-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>
            <div class="nim-header-title">Generate Invoice Now?</div>
          </div>
          <button class="nim-close" @click="showGenerate=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Generate an invoice for <strong>{{generateTarget?.customer}}</strong> for
            <strong>{{fmt(generateTarget?.grand_total)}}</strong> right now?
            This will be recorded in the invoice history.
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showGenerate=false">Cancel</button>
          <button class="nim-btn nim-btn-primary" @click="doGenerate">Generate Invoice</button>
        </div>
      </div>
    </div>
  </teleport>

  <!-- ── History Modal ── -->
  <teleport to="body">
    <div v-if="showHistory && histTarget" class="nim-overlay" @click.self="showHistory=false">
      <div class="nim-dialog" style="max-width:560px">
        <div class="nim-header">
          <div class="nim-header-left">
            <div class="nim-header-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="12 8 12 12 14 14"/><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/></svg></div>
            <div class="nim-header-title">Invoice History — {{histTarget.name}}</div>
          </div>
          <button class="nim-close" @click="showHistory=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:0;max-height:60vh;overflow-y:auto">
          <template v-if="(histTarget.history||[]).length">
            <table class="cust-table">
              <thead><tr>
                <th>Date</th><th>Invoice Ref</th><th style="text-align:right">Amount</th>
              </tr></thead>
              <tbody>
                <tr v-for="h in (histTarget.history||[]).slice().reverse()" :key="h.inv_ref" class="nim-tr">
                  <td class="cust-secondary">{{fmtDate(h.date)}}</td>
                  <td style="font-family:monospace;color:#2563eb;font-size:12px;font-weight:700">{{h.inv_ref||'—'}}</td>
                  <td class="nim-amount" style="text-align:right">{{fmt(h.amount)}}</td>
                </tr>
              </tbody>
            </table>
            <div style="padding:10px 14px;background:#f8f9fc;border-top:1px solid #e4e8f0;display:flex;justify-content:space-between;font-size:13px">
              <span style="color:#9ca3af">{{(histTarget.history||[]).length}} invoice(s) generated</span>
              <span style="font-weight:700;font-family:monospace">{{fmt((histTarget.history||[]).reduce((s,h)=>s+flt(h.amount),0))}}</span>
            </div>
          </template>
          <div v-else style="text-align:center;padding:40px;color:#9ca3af;font-size:13px">No invoices generated yet</div>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showHistory=false">Close</button>
        </div>
      </div>
    </div>
  </teleport>

  <!-- ── Delete Modal ── -->
  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left">
            <div class="nim-header-icon"><span v-html="icon('trash',16)"></span></div>
            <div class="nim-header-title">Delete Schedule?</div>
          </div>
          <button class="nim-close" @click="showDelete=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Delete <strong>{{deleteTarget?.name}}</strong>? All invoice history will be lost.
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Keep It</button>
          <button @click="doDelete" :disabled="deleting"
            style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff">
            {{deleting?'Deleting…':'Yes, Delete'}}
          </button>
        </div>
      </div>
    </div>
  </teleport>

</div>
`});

  /* ═══════════════════════════════════════════════════════════════
     CREDIT NOTES COMPONENT
  ═══════════════════════════════════════════════════════════════ */
  const CreditNotes = defineComponent({
    name: "CreditNotes",
    setup() {
      const LKEY = "books_credit_notes";
      const list = ref([]);
      const allInvoices = ref([]);
      const customers = ref([]);
      const allItems = ref([]);
      const loading = ref(true);
      const search = ref("");
      const activeFilter = ref("all");

      function storeList(d) { try { localStorage.setItem(LKEY, JSON.stringify(d)); } catch { } }
      function readList() { try { return JSON.parse(localStorage.getItem(LKEY) || "[]"); } catch { return []; } }
      function nextNum() {
        const n = readList().map(x => parseInt((x.name || "CN-0").replace(/\D/g, "")) || 0);
        return "CN-" + String((n.length ? Math.max(...n) : 0) + 1).padStart(4, "0");
      }
      function todayStr() { return new Date().toISOString().slice(0, 10); }

      const STATUS_CFG = {
        Draft: { cls: "b-badge-muted", lbl: "Draft" },
        Submitted: { cls: "b-badge-blue", lbl: "Submitted" },
        Applied: { cls: "b-badge-green", lbl: "Applied" },
        Cancelled: { cls: "b-badge-red", lbl: "Cancelled" },
      };

      const summary = computed(() => ({
        total: list.value.length,
        submitted: list.value.filter(n => n.status === "Submitted").length,
        applied: list.value.filter(n => n.status === "Applied").length,
        value: list.value.reduce((s, n) => s + flt(n.grand_total), 0),
      }));

      const counts = computed(() => ({
        Draft: list.value.filter(n => n.status === "Draft").length,
        Submitted: list.value.filter(n => n.status === "Submitted").length,
        Applied: list.value.filter(n => n.status === "Applied").length,
      }));

      const filtered = computed(() => {
        let r = activeFilter.value === "all" ? list.value : list.value.filter(n => n.status === activeFilter.value);
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(n => (n.name + n.customer + (n.against_invoice || "") + (n.reason || "")).toLowerCase().includes(q));
        return r;
      });

      // ── Drawer ──
      const showDrawer = ref(false);
      const drawerMode = ref("add");
      const saving = ref(false);
      const selCustomer = ref("");
      const custSearch = ref("");
      const showCustDrop = ref(false);
      const selInvoice = ref(null);
      const invSearch = ref("");
      const showInvDrop = ref(false);
      const viewNote = ref(null);

      const custDropItems = computed(() => {
        const q = custSearch.value.toLowerCase();
        return customers.value.filter(c => (c.customer_name || c.name).toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).slice(0, 40);
      });
      const invDropItems = computed(() => {
        const q = invSearch.value.toLowerCase().trim();
        return allInvoices.value.filter(i =>
          (selCustomer.value ? i.customer === selCustomer.value : true) &&
          (!q || i.name.toLowerCase().includes(q) || (i.customer || "").toLowerCase().includes(q) || (i.customer_name || "").toLowerCase().includes(q))
        ).slice(0, 50);
      });

      const form = reactive({
        name: "", customer: "", against_invoice: "", date: "", reason: "",
        status: "Draft", notes: "",
        items: [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
        taxes: [],
      });

      const netTotal = computed(() => form.items.reduce((s, r) => s + flt(r.amount), 0));
      const taxTotal = computed(() => form.taxes.reduce((s, t) => s + flt(t.tax_amount), 0));
      const grandTotal = computed(() => Math.round((netTotal.value + taxTotal.value) * 100) / 100);

      function recalc() {
        form.items.forEach(r => { r.amount = Math.round(flt(r.qty) * flt(r.rate) * 100) / 100; });
        form.taxes.forEach(t => { t.tax_amount = flt(t.rate) > 0 ? Math.round(netTotal.value * flt(t.rate) / 100 * 100) / 100 : 0; });
      }
      function addItem() { form.items.push({ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }); }
      function removeItem(i) { if (form.items.length > 1) { form.items.splice(i, 1); recalc(); } }
      function addTax() { form.taxes.push({ tax_type: "CGST", description: "CGST", rate: 9, tax_amount: 0 }); recalc(); }
      function removeTax(i) { form.taxes.splice(i, 1); recalc(); }

      function pickCustomer(c) { selCustomer.value = c.name; custSearch.value = c.customer_name || c.name; form.customer = c.name; showCustDrop.value = false; selInvoice.value = null; invSearch.value = ""; }
      function pickInvoice(inv) {
        selInvoice.value = inv; invSearch.value = inv.name; form.against_invoice = inv.name;
        if (!form.items[0].item_name && !form.items[0].rate) { form.items[0] = { item_name: "Credit Adjustment", description: "Credit against " + inv.name, qty: 1, rate: flt(inv.grand_total), amount: flt(inv.grand_total) }; recalc(); }
        showInvDrop.value = false;
      }

      function resetForm(from) {
        const s = from || {};
        Object.assign(form, { name: s.name || "", customer: s.customer || "", against_invoice: s.against_invoice || "", date: s.date || todayStr(), reason: s.reason || "", status: s.status || "Draft", notes: s.notes || "", items: s.items?.length ? s.items.map(r => ({ ...r })) : [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }], taxes: (s.taxes || []).map(t => ({ ...t })) });
        selCustomer.value = s.customer || ""; custSearch.value = s.customer || ""; selInvoice.value = null; invSearch.value = s.against_invoice || ""; showCustDrop.value = false; showInvDrop.value = false;
      }

      function openAdd() { drawerMode.value = "add"; resetForm(); showDrawer.value = true; }
      function openEdit(n) { const s = list.value.find(x => x.name === n); if (!s) return; drawerMode.value = "edit"; resetForm(s); showDrawer.value = true; }
      function openView(n) { const s = list.value.find(x => x.name === n); if (!s) return; viewNote.value = s; drawerMode.value = "view"; showDrawer.value = true; }

      function saveNote(status) {
        const cust = selCustomer.value || custSearch.value.trim();
        if (!cust) { toast("Please select a customer", "error"); return; }
        // Validate: every item row must have an item selected
        const emptyItem = form.items.find(r => !r.item_name || !r.item_name.trim());
        if (emptyItem) { toast("Please select an item for every row in the Items table", "error"); return; }
        if (!form.items.length) { toast("Please add at least one item", "error"); return; }
        const existing = list.value.find(s => s.name === form.name);
        const doc = { name: drawerMode.value === "edit" ? form.name : nextNum(), customer: cust, against_invoice: invSearch.value.trim(), date: form.date || todayStr(), reason: form.reason, status, notes: form.notes, items: form.items.filter(r => r.item_name || r.rate).map(r => ({ ...r })), taxes: form.taxes.map(t => ({ ...t })), net_total: Math.round(netTotal.value * 100) / 100, total_tax: Math.round(taxTotal.value * 100) / 100, grand_total: grandTotal.value, created_at: existing?.created_at || todayStr() };
        const arr = readList(); const idx = arr.findIndex(s => s.name === doc.name);
        if (idx >= 0) arr[idx] = doc; else arr.unshift(doc);
        storeList(arr); list.value = arr;
        toast(status === "Submitted" ? "Credit note submitted!" : "Credit note saved as Draft");
        showDrawer.value = false;
      }

      // ── Delete ──
      const showDelete = ref(false);
      const deleteTarget = ref(null);
      const deleting = ref(false);
      function confirmDelete(n) { deleteTarget.value = n; showDelete.value = true; }
      function doDelete() { deleting.value = true; const arr = readList().filter(s => s.name !== deleteTarget.value.name); storeList(arr); list.value = arr; toast("Credit note deleted"); showDelete.value = false; deleting.value = false; }

      async function load() {
        loading.value = true; list.value = readList(); loading.value = false;
        try { customers.value = await apiList("Customer", { fields: ["name", "customer_name"], filters: [["disabled", "=", 0]], order: "customer_name asc", limit: 300 }); } catch { }
        try { allInvoices.value = await apiList("Sales Invoice", { fields: ["name", "customer", "customer_name", "posting_date", "grand_total", "outstanding_amount"], filters: [["docstatus", "=", 1]], order: "posting_date desc", limit: 300 }); } catch { }
        try { allItems.value = await apiList("Item", { fields: ["name", "item_name", "item_code", "standard_rate", "description"], order: "item_name asc", limit: 300 }); } catch { }
      }
      onMounted(load);

      function onItemPick(row) {
        const matching = allItems.value.find(it => it.item_name === row.item_name);
        if (matching) {
          row.rate = matching.standard_rate || 0;
          row.description = matching.description || "";
          recalc();
        }
      }

      return { list, loading, search, allItems, onItemPick, activeFilter, filtered, counts, summary, STATUS_CFG, showDrawer, drawerMode, saving, viewNote, form, selCustomer, custSearch, showCustDrop, custDropItems, selInvoice, invSearch, showInvDrop, invDropItems, netTotal, taxTotal, grandTotal, recalc, addItem, removeItem, addTax, removeTax, pickCustomer, pickInvoice, saveNote, openAdd, openEdit, openView, showDelete, deleteTarget, deleting, confirmDelete, doDelete, load, icon, fmt, fmtDate, flt };
    },
    template: `
<div class="b-page">
  <div class="qt-summary">
    <div class="qt-sum-card"><div class="qt-sum-label">Total Notes</div><div class="qt-sum-value">{{summary.total}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#2563eb">Submitted</div><div class="qt-sum-value" style="color:#2563eb">{{summary.submitted}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#059669">Applied</div><div class="qt-sum-value" style="color:#059669">{{summary.applied}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#dc2626">Total Value</div><div class="qt-sum-value" style="color:#dc2626">{{fmt(summary.value)}}</div></div>
  </div>
  <div class="cust-toolbar">
    <div class="cust-toolbar-left"><div class="cust-filters">
      <button class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter==='all'}" @click="activeFilter='all'">All</button>
      <button v-for="f in ['Draft','Submitted','Applied']" :key="f" class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter===f}" @click="activeFilter=f">
        {{f}} <span class="zb-pill-cnt" :class="activeFilter===f?'':'zb-pc-muted'">{{counts[f]}}</span>
      </button>
    </div></div>
    <div class="cust-toolbar-right">
      <div class="cust-search"><span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span><input v-model="search" placeholder="Search note, customer, invoice…" class="cust-search-input" autocomplete="off"/></div>
      <button class="zb-tb-btn" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="zb-tb-btn" style="background:#dc2626;color:#fff;border-color:#dc2626" @click="openAdd"><span v-html="icon('plus',13)"></span> New Credit Note</button>
    </div>
  </div>
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead><tr><th>Note #</th><th>Customer</th><th>Against Invoice</th><th>Date</th><th>Reason</th><th style="text-align:right">Amount</th><th>Status</th><th style="text-align:center;width:100px">Actions</th></tr></thead>
        <tbody>
          <template v-if="loading"><tr v-for="n in 4" :key="n"><td colspan="8" style="padding:12px 14px"><div class="b-shimmer" style="height:13px;border-radius:4px;width:65%"></div></td></tr></template>
          <tr v-else-if="!filtered.length"><td colspan="8" class="cust-empty">
            <div class="cust-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg></div>
            <div class="cust-empty-title">{{search?'No results':'No credit notes yet'}}</div>
            <div class="cust-empty-sub">{{search?'Try a different search':'Issue a credit note against a submitted invoice'}}</div>
            <button v-if="!search" class="nim-btn" style="margin-top:12px;background:#dc2626;color:#fff;height:37px;padding:0 14px;border-radius:8px;font-size:13.5px;font-weight:600;border:none;cursor:pointer" @click="openAdd"><span v-html="icon('plus',13)"></span> New Credit Note</button>
          </td></tr>
          <tr v-else v-for="n in filtered" :key="n.name" class="cust-row" @click="openView(n.name)">
            <td><div style="color:#dc2626;font-family:monospace;font-size:12px;font-weight:700">{{n.name}}</div></td>
            <td class="cust-name">{{n.customer||'—'}}</td>
            <td style="font-family:monospace;font-size:12px;color:#2563eb">{{n.against_invoice||'—'}}</td>
            <td class="cust-secondary">{{fmtDate(n.date)}}</td>
            <td class="cust-secondary" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{n.reason||'—'}}</td>
            <td style="text-align:right;font-family:monospace;font-weight:700;color:#dc2626">{{fmt(n.grand_total)}}</td>
            <td><span class="b-badge" :class="(STATUS_CFG[n.status]||STATUS_CFG.Draft).cls">{{n.status}}</span></td>
            <td @click.stop style="text-align:center"><div style="display:flex;gap:4px;justify-content:center">
              <button class="cust-act-btn cust-act-edit" @click="openEdit(n.name)" title="Edit"><span v-html="icon('edit',13)"></span></button>
              <button class="cust-act-btn cust-act-del" @click="confirmDelete(n)" title="Delete"><span v-html="icon('trash',13)"></span></button>
            </div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">Showing {{filtered.length}} of {{list.length}} credit notes</div>
  </div>
  <!-- Drawer -->
  <teleport to="body">
    <transition name="cust-drawer-fade">
      <div v-if="showDrawer" class="cust-backdrop" @click.self="showDrawer=false">
        <transition name="cust-drawer-slide">
          <div v-if="showDrawer" class="cust-drawer" style="width:700px">
            <div class="cust-drawer-header">
              <div class="cust-drawer-header-left">
                <div class="cust-drawer-icon" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                </div>
                <div>
                  <div class="cust-drawer-title">{{drawerMode==='add'?'New Credit Note':drawerMode==='edit'?'Edit Credit Note':'View Credit Note'}}</div>
                  <div class="cust-drawer-sub">{{drawerMode==='view'?viewNote?.name:drawerMode==='edit'?form.name:'Issue a credit against an invoice'}}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <span v-if="drawerMode==='view'" class="b-badge" :class="(STATUS_CFG[viewNote?.status]||STATUS_CFG.Draft).cls">{{viewNote?.status}}</span>
                <button class="nim-close" @click="showDrawer=false" v-html="icon('x',15)"></button>
              </div>
            </div>
            <!-- View -->
            <div v-if="drawerMode==='view' && viewNote" class="cust-drawer-body">
              <div class="cust-sec-label" style="margin-top:0">Credit Note Details</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field"><label class="nim-label">Customer</label><div style="font-size:13.5px;font-weight:600;color:#111827;padding:4px 0">{{viewNote.customer}}</div></div>
                <div class="nim-field"><label class="nim-label">Against Invoice</label><div style="font-size:13.5px;color:#2563eb;font-family:monospace;font-weight:700;padding:4px 0">{{viewNote.against_invoice||'—'}}</div></div>
                <div class="nim-field"><label class="nim-label">Date</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmtDate(viewNote.date)}}</div></div>
                <div class="nim-field"><label class="nim-label">Reason</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{viewNote.reason||'—'}}</div></div>
              </div>
              <div class="cust-sec-label">Items</div>
              <div class="nim-table-wrap nim-mb">
                <table class="nim-table"><thead><tr><th>Item</th><th>Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
                <tbody><tr v-for="r in (viewNote.items||[])" :key="r.item_name" class="nim-tr">
                  <td style="font-weight:600">{{r.item_name||'—'}}</td><td class="cust-secondary">{{r.description||''}}</td>
                  <td style="text-align:center">{{r.qty||1}}</td><td class="nim-amount" style="text-align:right">{{fmt(r.rate)}}</td>
                  <td class="nim-amount" style="text-align:right;color:#dc2626">{{fmt(r.amount)}}</td>
                </tr></tbody></table>
              </div>
              <div style="display:flex;justify-content:flex-end">
                <div class="nim-totals">
                  <div class="nim-total-row"><span class="nim-total-label">Subtotal</span><span class="nim-total-val">{{fmt(viewNote.net_total)}}</span></div>
                  <div class="nim-total-grand" style="color:#dc2626"><span>Credit Total</span><span>{{fmt(viewNote.grand_total)}}</span></div>
                </div>
              </div>
              <div v-if="viewNote.notes" class="nim-field" style="margin-top:16px"><label class="nim-label">Notes</label><div style="font-size:13px;color:#6b7280;line-height:1.6">{{viewNote.notes}}</div></div>
            </div>
            <!-- Add/Edit -->
            <div v-else-if="drawerMode!=='view'" class="cust-drawer-body">
              <div class="cust-sec-label" style="margin-top:0">Credit Note Details</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field" style="position:relative">
                  <label class="nim-label">Customer <span class="nim-req">*</span></label>
                  <input v-model="custSearch" class="nim-input" placeholder="Search customer…" autocomplete="off" @focus="showCustDrop=true" @blur="setTimeout(()=>showCustDrop=false,200)" @input="showCustDrop=true"/>
                  <div v-if="showCustDrop && custDropItems.length" class="qt-cust-drop">
                    <div v-for="c in custDropItems" :key="c.name" class="qt-drop-item" @mousedown.prevent="pickCustomer(c)">
                      <div style="font-weight:600;font-size:13px">{{c.customer_name||c.name}}</div>
                    </div>
                  </div>
                </div>
                <div class="nim-field" style="position:relative">
                  <label class="nim-label">Against Invoice</label>
                  <div style="position:relative">
                    <input v-model="invSearch" class="nim-input" placeholder="Search invoice…" autocomplete="off"
                      style="padding-right:32px"
                      @focus="showInvDrop=true" @blur="setTimeout(()=>showInvDrop=false,250)" @input="showInvDrop=true"/>
                    <span @mousedown.prevent="showInvDrop=!showInvDrop" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);cursor:pointer;color:#6b7280;pointer-events:all">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                    </span>
                  </div>
                  <div v-if="showInvDrop" style="position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #e8ecf0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:999;max-height:220px;overflow-y:auto">
                    <div v-if="!invDropItems.length" style="padding:12px 14px;font-size:13px;color:#9ca3af">
                      {{selCustomer ? 'No submitted invoices for this customer' : 'No submitted invoices found'}}
                    </div>
                    <div v-for="inv in invDropItems" :key="inv.name"
                      @mousedown.prevent="pickInvoice(inv)"
                      style="padding:10px 14px;cursor:pointer;border-bottom:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:center"
                      onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background='#fff'">
                      <div>
                        <div style="font-weight:600;font-size:13px;color:#2563eb;font-family:monospace">{{inv.name}}</div>
                        <div style="font-size:11px;color:#6b7280;margin-top:1px">{{inv.customer}} · {{fmtDate(inv.posting_date)}}</div>
                      </div>
                      <div style="text-align:right;flex-shrink:0;margin-left:12px">
                        <div style="font-size:13px;font-weight:700;color:#1a1d23">{{fmt(inv.grand_total)}}</div>
                        <div style="font-size:11px;color:#e03131" v-if="flt(inv.outstanding_amount)>0">{{fmt(inv.outstanding_amount)}} due</div>
                        <div style="font-size:11px;color:#059669" v-else>Paid</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="nim-field"><label class="nim-label">Credit Note Date</label><input v-model="form.date" type="date" class="nim-input"/></div>
                <div class="nim-field"><label class="nim-label">Status</label><select v-model="form.status" class="nim-select"><option>Draft</option><option>Submitted</option><option>Applied</option></select></div>
                <div class="nim-field" style="grid-column:span 2"><label class="nim-label">Reason</label><input v-model="form.reason" class="nim-input" placeholder="Reason for credit note (returns, overcharge, etc.)"/></div>
              </div>
              <div class="nim-section-header" style="margin-bottom:8px"><div class="cust-sec-label" style="margin:0">Items</div></div>
              <div class="nim-table-wrap nim-mb">
                <table class="nim-table"><thead><tr>
                  <th style="width:30%">Item <span style="color:#e03131">*</span></th>
                  <th style="width:26%">Description</th>
                  <th style="width:10%;text-align:center">Qty</th>
                  <th style="width:16%;text-align:right">Rate (₹)</th>
                  <th style="width:14%;text-align:right">Amount</th>
                  <th style="width:4%"></th>
                </tr></thead>
                <tbody><tr v-for="(item,i) in form.items" :key="i" class="nim-tr">
                  <td>
                    <searchable-select v-model="item.item_name" :options="allItems" value-key="item_name" label-key="item_name" placeholder="— Select Item —" :compact="true" class="ss-cell-wrap" @update:modelValue="onItemPick(item)"/>
                  </td>
                  <td><input v-model="item.description" class="nim-cell" placeholder="Description"/></td>
                  <td style="text-align:center"><input v-model.number="item.qty" type="number" min="0.01" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                  <td style="text-align:right"><input v-model.number="item.rate" type="number" min="0" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                  <td class="nim-amount" style="text-align:right;color:#dc2626">{{flt(item.amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                  <td style="text-align:center"><button v-if="form.items.length>1" @click="removeItem(i)" class="nim-del-btn" v-html="icon('trash',13)"></button></td>
                </tr></tbody></table>
                <div class="nim-table-footer"><button @click="addItem" class="nim-add-btn"><span v-html="icon('plus',12)"></span> Add Row</button></div>
              </div>
              <div class="nim-section-header nim-mb-sm"><div class="cust-sec-label" style="margin:0">Taxes</div><button @click="addTax" class="nim-add-btn"><span v-html="icon('plus',12)"></span> Add Tax</button></div>
              <div v-if="form.taxes.length" class="nim-table-wrap nim-mb"><table class="nim-table"><thead><tr><th style="width:20%">Type</th><th style="width:30%">Desc</th><th style="width:14%;text-align:center">Rate %</th><th style="width:32%;text-align:right">Amount</th><th style="width:4%"></th></tr></thead>
                <tbody><tr v-for="(tax,i) in form.taxes" :key="i" class="nim-tr">
                  <td><select v-model="tax.tax_type" class="nim-cell" @change="tax.description=tax.tax_type;recalc()"><option>CGST</option><option>SGST</option><option>IGST</option><option>Cess</option><option>Other</option></select></td>
                  <td><input v-model="tax.description" class="nim-cell"/></td>
                  <td style="text-align:center"><input v-model.number="tax.rate" type="number" min="0" max="100" step="0.01" class="nim-cell nim-num" @input="recalc"/></td>
                  <td class="nim-amount" style="text-align:right">{{flt(tax.tax_amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                  <td style="text-align:center"><button @click="removeTax(i)" class="nim-del-btn" v-html="icon('trash',13)"></button></td>
                </tr></tbody></table></div>
              <div class="nim-bottom-row">
                <div class="nim-field" style="flex:1"><label class="nim-label">Notes</label><textarea v-model="form.notes" class="nim-input nim-textarea" rows="3" placeholder="Internal notes…"></textarea></div>
                <div class="nim-totals">
                  <div class="nim-total-row"><span class="nim-total-label">Subtotal</span><span class="nim-total-val">{{fmt(netTotal)}}</span></div>
                  <div v-for="tax in form.taxes" :key="tax.tax_type" class="nim-total-row nim-tax-row"><span class="nim-total-label">{{tax.description}} ({{tax.rate}}%)</span><span class="nim-total-val">{{fmt(tax.tax_amount)}}</span></div>
                  <div class="nim-total-grand" style="color:#dc2626"><span>Credit Total</span><span>{{fmt(grandTotal)}}</span></div>
                </div>
              </div>
            </div>
            <div class="nim-footer">
              <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">{{drawerMode==='view'?'Close':'Cancel'}}</button>
              <div v-if="drawerMode!=='view'" style="display:flex;gap:8px">
                <button class="nim-btn nim-btn-outline" @click="saveNote('Draft')" :disabled="saving">Save as Draft</button>
                <button class="nim-btn" style="background:#dc2626;color:#fff;height:37px;padding:0 14px;border-radius:8px;font-size:13.5px;font-weight:600;border:none;cursor:pointer" @click="saveNote('Submitted')" :disabled="saving">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Submit Credit Note
                </button>
              </div>
              <div v-else style="display:flex;gap:8px">
                <button class="nim-btn nim-btn-outline" @click="openEdit(viewNote.name)"><span v-html="icon('edit',13)"></span> Edit</button>
              </div>
            </div>
          </div>
        </transition>
      </div>
    </transition>
  </teleport>
  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left"><div class="nim-header-icon"><span v-html="icon('trash',16)"></span></div><div class="nim-header-title">Delete Credit Note?</div></div>
          <button class="nim-close" @click="showDelete=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px"><p style="font-size:14px;color:#374151;line-height:1.6">Delete <strong>{{deleteTarget?.name}}</strong>? This cannot be undone.</p></div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Keep It</button>
          <button @click="doDelete" :disabled="deleting" style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff">{{deleting?'Deleting…':'Yes, Delete'}}</button>
        </div>
      </div>
    </div>
  </teleport>
</div>
`});

  /* ═══════════════════════════════════════════════════════════════
     PAYMENTS RECEIVED COMPONENT
  ═══════════════════════════════════════════════════════════════ */
  const PaymentsReceived = defineComponent({
    name: "PaymentsReceived",
    setup() {
      const LKEY = "books_payments_received";
      const list = ref([]);
      const customers = ref([]);
      const loading = ref(true);
      const search = ref("");
      const activeFilter = ref("all");

      function storeList(d) { try { localStorage.setItem(LKEY, JSON.stringify(d)); } catch { } }
      function readList() { try { return JSON.parse(localStorage.getItem(LKEY) || "[]"); } catch { return []; } }
      function nextNum() {
        const n = readList().map(x => parseInt((x.name || "PAY-0").replace(/\D/g, "")) || 0);
        return "PAY-" + String((n.length ? Math.max(...n) : 0) + 1).padStart(4, "0");
      }
      function todayStr() { return new Date().toISOString().slice(0, 10); }

      const MODES = ["Cash", "Bank Transfer", "UPI", "Cheque", "Card", "Other"];
      const MODE_CSS = { Cash: "#f0fff4|#276539", "Bank Transfer": "#eff6ff|#2563eb", UPI: "#f3e8ff|#7c3aed", Cheque: "#fefce8|#854d0e", Card: "#fdf2f8|#9d174d", Other: "#f3f4f6|#374151" };

      const summary = computed(() => {
        const total = list.value.reduce((s, p) => s + flt(p.amount), 0);
        const now = new Date(); const mo = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
        const moTotal = list.value.filter(p => (p.date || "").startsWith(mo)).reduce((s, p) => s + flt(p.amount), 0);
        const avg = list.value.length ? Math.round(total / list.value.length) : 0;
        return { total, moTotal, count: list.value.length, avg };
      });

      const counts = computed(() => {
        const r = {};
        MODES.forEach(m => { r[m] = list.value.filter(p => p.mode === m).length; });
        return r;
      });

      const filtered = computed(() => {
        let r = activeFilter.value === "all" ? list.value : list.value.filter(p => p.mode === activeFilter.value);
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(p => (p.name + p.customer + (p.ref || "") + (p.mode || "")).toLowerCase().includes(q));
        return r;
      });

      // Drawer
      const showDrawer = ref(false);
      const drawerMode = ref("add");
      const saving = ref(false);
      const selCustomer = ref("");
      const custSearch = ref("");
      const showCustDrop = ref(false);
      const showCheque = ref(false);

      const custDropItems = computed(() => {
        const q = custSearch.value.toLowerCase();
        return customers.value.filter(c => (c.customer_name || c.name).toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).slice(0, 40);
      });

      const form = reactive({ name: "", customer: "", date: "", mode: "Bank Transfer", amount: 0, ref: "", remarks: "", cheque_no: "", cheque_date: "", bank_name: "" });

      function pickCustomer(c) { selCustomer.value = c.name; custSearch.value = c.customer_name || c.name; form.customer = c.name; showCustDrop.value = false; }

      function resetForm(from) {
        const s = from || {};
        Object.assign(form, { name: s.name || "", customer: s.customer || "", date: s.date || todayStr(), mode: s.mode || "Bank Transfer", amount: s.amount || 0, ref: s.ref || "", remarks: s.remarks || "", cheque_no: s.cheque_no || "", cheque_date: s.cheque_date || "", bank_name: s.bank_name || "" });
        selCustomer.value = s.customer || ""; custSearch.value = s.customer || ""; showCustDrop.value = false; showCheque.value = (s.mode === "Cheque");
      }

      function openAdd() { drawerMode.value = "add"; resetForm(); showDrawer.value = true; }
      function openEdit(n) { const s = list.value.find(x => x.name === n); if (!s) return; drawerMode.value = "edit"; resetForm(s); showDrawer.value = true; }

      function savePayment() {
        const cust = selCustomer.value || custSearch.value.trim();
        if (!cust) { toast("Please select a customer", "error"); return; }
        if (!flt(form.amount)) { toast("Please enter an amount", "error"); return; }
        const existing = list.value.find(s => s.name === form.name);
        const doc = { name: drawerMode.value === "edit" ? form.name : nextNum(), customer: cust, date: form.date || todayStr(), mode: form.mode, amount: flt(form.amount), ref: form.ref.trim(), remarks: form.remarks.trim(), cheque_no: form.cheque_no, cheque_date: form.cheque_date, bank_name: form.bank_name, created_at: existing?.created_at || todayStr() };
        const arr = readList(); const idx = arr.findIndex(s => s.name === doc.name);
        if (idx >= 0) arr[idx] = doc; else arr.unshift(doc);
        storeList(arr); list.value = arr;
        toast("Payment recorded!"); showDrawer.value = false;
      }

      // Receipt modal
      const showReceipt = ref(false);
      const receiptData = ref(null);
      function openReceipt(n) { receiptData.value = list.value.find(x => x.name === n); showReceipt.value = true; }

      // Delete
      const showDelete = ref(false);
      const deleteTarget = ref(null);
      const deleting = ref(false);
      function confirmDelete(n) { deleteTarget.value = n; showDelete.value = true; }
      function doDelete() { deleting.value = true; const arr = readList().filter(s => s.name !== deleteTarget.value.name); storeList(arr); list.value = arr; toast("Payment deleted"); showDelete.value = false; deleting.value = false; }

      async function load() {
        loading.value = true; list.value = readList(); loading.value = false;
        try {
          const frappe = await apiList("Payment Entry", { fields: ["name", "party", "posting_date", "mode_of_payment", "paid_amount", "reference_no", "remarks", "docstatus"], filters: [["payment_type", "=", "Receive"], ["docstatus", "=", 1]], order: "posting_date desc", limit: 300 });
          const existing = new Set(list.value.filter(p => p.from_frappe).map(p => p.frappe_ref));
          const newFromFrappe = (frappe || []).filter(r => !existing.has(r.name)).map(r => ({ name: nextNum(), frappe_ref: r.name, from_frappe: true, customer: r.party, date: r.posting_date, mode: r.mode_of_payment || "Bank Transfer", amount: r.paid_amount, ref: r.reference_no || "", remarks: r.remarks || "", created_at: r.posting_date }));
          if (newFromFrappe.length) { const arr = [...readList(), ...newFromFrappe]; storeList(arr); list.value = arr; }
        } catch { }
        try { customers.value = await apiList("Customer", { fields: ["name", "customer_name"], filters: [["disabled", "=", 0]], order: "customer_name asc", limit: 300 }); } catch { }
      }
      onMounted(load);

      return { list, loading, search, activeFilter, filtered, counts, summary, MODES, MODE_CSS, showDrawer, drawerMode, saving, form, selCustomer, custSearch, showCustDrop, custDropItems, showCheque, pickCustomer, savePayment, openAdd, openEdit, showReceipt, receiptData, openReceipt, showDelete, deleteTarget, deleting, confirmDelete, doDelete, load, icon, fmt, fmtDate, flt };
    },
    template: `
<div class="b-page">
  <div class="qt-summary">
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#059669">Total Received</div><div class="qt-sum-value" style="color:#059669">{{fmt(summary.total)}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#2563eb">This Month</div><div class="qt-sum-value" style="color:#2563eb">{{fmt(summary.moTotal)}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label">Total Payments</div><div class="qt-sum-value">{{summary.count}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#7c3aed">Average</div><div class="qt-sum-value" style="color:#7c3aed">{{fmt(summary.avg)}}</div></div>
  </div>
  <div class="cust-toolbar">
    <div class="cust-toolbar-left"><div class="cust-filters">
      <button class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter==='all'}" @click="activeFilter='all'">All</button>
      <button v-for="m in MODES" :key="m" class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter===m}" @click="activeFilter=m">
        {{m}} <span class="zb-pill-cnt" :class="activeFilter===m?'':'zb-pc-muted'">{{counts[m]||0}}</span>
      </button>
    </div></div>
    <div class="cust-toolbar-right">
      <div class="cust-search"><span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span><input v-model="search" placeholder="Search payment, customer…" class="cust-search-input" autocomplete="off"/></div>
      <button class="zb-tb-btn" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="zb-tb-btn zb-tb-primary" @click="openAdd"><span v-html="icon('plus',13)"></span> Record Payment</button>
    </div>
  </div>
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead><tr><th>Ref #</th><th>Customer</th><th>Date</th><th>Mode</th><th style="text-align:right">Amount</th><th>Reference No.</th><th>Remarks</th><th style="text-align:center;width:90px">Actions</th></tr></thead>
        <tbody>
          <template v-if="loading"><tr v-for="n in 5" :key="n"><td colspan="8" style="padding:12px 14px"><div class="b-shimmer" style="height:13px;border-radius:4px;width:65%"></div></td></tr></template>
          <tr v-else-if="!filtered.length"><td colspan="8" class="cust-empty">
            <div class="cust-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg></div>
            <div class="cust-empty-title">{{search?'No results':'No payments recorded yet'}}</div>
            <div class="cust-empty-sub">{{search?'Try a different search':'Record customer payments received'}}</div>
            <button v-if="!search" class="nim-btn nim-btn-primary" style="margin-top:12px" @click="openAdd"><span v-html="icon('plus',13)"></span> Record Payment</button>
          </td></tr>
          <tr v-else v-for="p in filtered" :key="p.name" class="cust-row" @click="openReceipt(p.name)">
            <td><div style="color:#2563eb;font-family:monospace;font-size:12px;font-weight:700">{{p.name}}</div></td>
            <td class="cust-name">{{p.customer||'—'}}</td>
            <td class="cust-secondary">{{fmtDate(p.date)}}</td>
            <td>
              <span class="b-badge" :style="{background:MODE_CSS[p.mode]?.split('|')[0]||'#f3f4f6',color:MODE_CSS[p.mode]?.split('|')[1]||'#374151'}">{{p.mode||'Other'}}</span>
            </td>
            <td style="text-align:right;font-family:monospace;font-weight:700;font-size:14px;color:#059669">{{fmt(p.amount)}}</td>
            <td class="cust-mono" style="font-size:12px">{{p.ref||'—'}}</td>
            <td class="cust-secondary" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{p.remarks||'—'}}</td>
            <td @click.stop style="text-align:center"><div style="display:flex;gap:4px;justify-content:center">
              <button class="cust-act-btn cust-act-edit" @click="openEdit(p.name)" title="Edit"><span v-html="icon('edit',13)"></span></button>
              <button class="cust-act-btn cust-act-del" @click="confirmDelete(p)" title="Delete"><span v-html="icon('trash',13)"></span></button>
            </div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">Showing {{filtered.length}} of {{list.length}} payments</div>
  </div>
  <!-- Add/Edit Drawer -->
  <teleport to="body">
    <transition name="cust-drawer-fade">
      <div v-if="showDrawer" class="cust-backdrop" @click.self="showDrawer=false">
        <transition name="cust-drawer-slide">
          <div v-if="showDrawer" class="cust-drawer" style="width:560px">
            <div class="cust-drawer-header">
              <div class="cust-drawer-header-left">
                <div class="cust-drawer-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg></div>
                <div><div class="cust-drawer-title">{{drawerMode==='add'?'Record Payment':'Edit Payment'}}</div><div class="cust-drawer-sub">{{drawerMode==='edit'?form.name:'Enter payment details'}}</div></div>
              </div>
              <button class="nim-close" @click="showDrawer=false" v-html="icon('x',15)"></button>
            </div>
            <div class="cust-drawer-body">
              <div class="cust-sec-label" style="margin-top:0">Payment Details</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field" style="position:relative">
                  <label class="nim-label">Customer <span class="nim-req">*</span></label>
                  <input v-model="custSearch" class="nim-input" placeholder="Search customer…" autocomplete="off" @focus="showCustDrop=true" @blur="setTimeout(()=>showCustDrop=false,200)" @input="showCustDrop=true"/>
                  <div v-if="showCustDrop && custDropItems.length" class="qt-cust-drop">
                    <div v-for="c in custDropItems" :key="c.name" class="qt-drop-item" @mousedown.prevent="pickCustomer(c)"><div style="font-weight:600;font-size:13px">{{c.customer_name||c.name}}</div></div>
                  </div>
                </div>
                <div class="nim-field"><label class="nim-label">Payment Date</label><input v-model="form.date" type="date" class="nim-input"/></div>
                <div class="nim-field"><label class="nim-label">Amount <span class="nim-req">*</span></label><input v-model.number="form.amount" type="number" min="0" step="0.01" class="nim-input nim-amount-input" placeholder="0.00"/></div>
                <div class="nim-field"><label class="nim-label">Mode of Payment</label>
                  <select v-model="form.mode" class="nim-select" @change="showCheque=form.mode==='Cheque'">
                    <option v-for="m in MODES" :key="m">{{m}}</option>
                  </select>
                </div>
                <div class="nim-field"><label class="nim-label">Reference No. (UTR / Txn ID)</label><input v-model="form.ref" class="nim-input" placeholder="e.g. UTR123456789"/></div>
                <div class="nim-field"><label class="nim-label">Remarks</label><input v-model="form.remarks" class="nim-input" placeholder="Optional note"/></div>
              </div>
              <template v-if="showCheque">
                <div class="cust-sec-label">Cheque Details</div>
                <div class="nim-grid-3 nim-mb">
                  <div class="nim-field"><label class="nim-label">Cheque No.</label><input v-model="form.cheque_no" class="nim-input" placeholder="Cheque number"/></div>
                  <div class="nim-field"><label class="nim-label">Cheque Date</label><input v-model="form.cheque_date" type="date" class="nim-input"/></div>
                  <div class="nim-field"><label class="nim-label">Bank Name</label><input v-model="form.bank_name" class="nim-input" placeholder="Bank name"/></div>
                </div>
              </template>
            </div>
            <div class="nim-footer">
              <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">Cancel</button>
              <button class="nim-btn nim-btn-primary" @click="savePayment" :disabled="saving">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                {{drawerMode==='edit'?'Save Changes':'Record Payment'}}
              </button>
            </div>
          </div>
        </transition>
      </div>
    </transition>
  </teleport>
  <!-- Receipt modal -->
  <teleport to="body">
    <div v-if="showReceipt && receiptData" class="nim-overlay" @click.self="showReceipt=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header">
          <div class="nim-header-left"><div class="nim-header-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg></div><div class="nim-header-title">Payment Receipt</div></div>
          <button class="nim-close" @click="showReceipt=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <div style="text-align:center;margin-bottom:16px"><div style="font-size:28px;font-weight:800;color:#059669">{{fmt(receiptData.amount)}}</div><div style="font-size:13px;color:#9ca3af;margin-top:4px">Received from {{receiptData.customer}}</div></div>
          <div class="nim-grid-2" style="gap:10px">
            <div class="nim-field"><label class="nim-label">Date</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmtDate(receiptData.date)}}</div></div>
            <div class="nim-field"><label class="nim-label">Mode</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{receiptData.mode}}</div></div>
            <div v-if="receiptData.ref" class="nim-field"><label class="nim-label">Reference No.</label><div style="font-size:13px;font-family:monospace;color:#2563eb;padding:4px 0">{{receiptData.ref}}</div></div>
            <div v-if="receiptData.remarks" class="nim-field" style="grid-column:span 2"><label class="nim-label">Remarks</label><div style="font-size:13px;color:#6b7280;padding:4px 0">{{receiptData.remarks}}</div></div>
          </div>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showReceipt=false">Close</button>
          <button class="nim-btn nim-btn-outline" @click="openEdit(receiptData.name);showReceipt=false"><span v-html="icon('edit',13)"></span> Edit</button>
        </div>
      </div>
    </div>
  </teleport>
  <!-- Delete -->
  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left"><div class="nim-header-icon"><span v-html="icon('trash',16)"></span></div><div class="nim-header-title">Delete Payment?</div></div>
          <button class="nim-close" @click="showDelete=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px"><p style="font-size:14px;color:#374151;line-height:1.6">Delete payment <strong>{{deleteTarget?.name}}</strong>? This cannot be undone.</p></div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Keep It</button>
          <button @click="doDelete" :disabled="deleting" style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff">{{deleting?'Deleting…':'Yes, Delete'}}</button>
        </div>
      </div>
    </div>
  </teleport>
</div>
`});

  /* ═══════════════════════════════════════════════════════════════
     E-WAY BILLS COMPONENT
  ═══════════════════════════════════════════════════════════════ */
  const EwayBills = defineComponent({
    name: "EwayBills",
    setup() {
      const LKEY = "books_eway_bills";
      const list = ref([]);
      const loading = ref(true);
      const search = ref("");
      const activeFilter = ref("all");

      function storeList(d) { try { localStorage.setItem(LKEY, JSON.stringify(d)); } catch { } }
      function readList() { try { return JSON.parse(localStorage.getItem(LKEY) || "[]"); } catch { return []; } }
      function nextNum() {
        const n = readList().map(x => parseInt((x.name || "EWB-0").replace(/\D/g, "")) || 0);
        return "EWB-" + String((n.length ? Math.max(...n) : 0) + 1).padStart(6, "0");
      }
      function todayStr() { return new Date().toISOString().slice(0, 10); }

      function calcValidDays(dist, vehicleType) {
        const d = parseInt(dist) || 0;
        if (vehicleType === "Over Dimensional Cargo") return 20;
        if (d < 100) return 1; if (d < 300) return 3; if (d < 500) return 5;
        if (d < 1000) return 10; return 15;
      }
      function calcExpiry(genDate, dist, vehicleType) {
        if (!genDate) return "";
        const dt = new Date(genDate); dt.setDate(dt.getDate() + calcValidDays(dist, vehicleType));
        return dt.toISOString().slice(0, 10);
      }
      function isExpired(b) {
        if (b.status === "Cancelled") return false;
        return b.expiry_date && new Date(b.expiry_date) < new Date();
      }
      function effectiveStatus(b) { return isExpired(b) ? "Expired" : b.status || "Active"; }

      const STATUS_CFG = { Active: { cls: "b-badge-green", lbl: "Active" }, Expired: { cls: "b-badge-red", lbl: "Expired" }, Cancelled: { cls: "b-badge-muted", lbl: "Cancelled" } };

      const summary = computed(() => {
        const active = list.value.filter(b => effectiveStatus(b) === "Active").length;
        const expiring = list.value.filter(b => { if (effectiveStatus(b) !== "Active") return false; const d = Math.round((new Date(b.expiry_date) - new Date()) / (1000 * 60 * 60 * 24)); return d >= 0 && d <= 2; }).length;
        const value = list.value.reduce((s, b) => s + flt(b.taxable_value), 0);
        return { total: list.value.length, active, expiring, value };
      });

      const counts = computed(() => ({
        Active: list.value.filter(b => effectiveStatus(b) === "Active").length,
        Expired: list.value.filter(b => effectiveStatus(b) === "Expired").length,
        Cancelled: list.value.filter(b => b.status === "Cancelled").length,
      }));

      const filtered = computed(() => {
        let r = activeFilter.value === "all" ? list.value : list.value.filter(b => effectiveStatus(b) === activeFilter.value);
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(b => (b.name + (b.from_gstin || "") + (b.to_gstin || "") + (b.vehicle_no || "") + (b.invoice_no || "")).toLowerCase().includes(q));
        return r;
      });

      // Drawer
      const showDrawer = ref(false);
      const drawerMode = ref("add");
      const saving = ref(false);
      const viewBill = ref(null);

      const form = reactive({ name: "", ewb_no: "", invoice_no: "", invoice_date: "", doc_type: "Tax Invoice", supply_type: "Outward", from_gstin: "", from_name: "", from_address: "", to_gstin: "", to_name: "", to_address: "", taxable_value: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, hsn_code: "", description: "", quantity: 0, unit: "NOS", transport_mode: "Road", distance: 0, transporter_id: "", transporter_name: "", vehicle_no: "", vehicle_type: "Regular", generated_date: "", expiry_date: "", status: "Active" });

      function updateExpiry() { if (form.generated_date && form.distance) form.expiry_date = calcExpiry(form.generated_date, form.distance, form.vehicle_type); }

      function resetForm(from) {
        const s = from || {};
        Object.assign(form, { name: s.name || "", ewb_no: s.ewb_no || "", invoice_no: s.invoice_no || "", invoice_date: s.invoice_date || todayStr(), doc_type: s.doc_type || "Tax Invoice", supply_type: s.supply_type || "Outward", from_gstin: s.from_gstin || "", from_name: s.from_name || "", from_address: s.from_address || "", to_gstin: s.to_gstin || "", to_name: s.to_name || "", to_address: s.to_address || "", taxable_value: s.taxable_value || 0, igst: s.igst || 0, cgst: s.cgst || 0, sgst: s.sgst || 0, cess: s.cess || 0, hsn_code: s.hsn_code || "", description: s.description || "", quantity: s.quantity || 0, unit: s.unit || "NOS", transport_mode: s.transport_mode || "Road", distance: s.distance || 0, transporter_id: s.transporter_id || "", transporter_name: s.transporter_name || "", vehicle_no: s.vehicle_no || "", vehicle_type: s.vehicle_type || "Regular", generated_date: s.generated_date || todayStr(), expiry_date: s.expiry_date || calcExpiry(todayStr(), s.distance || 0, s.vehicle_type || "Regular"), status: s.status || "Active" });
      }

      function openAdd() { drawerMode.value = "add"; resetForm(); showDrawer.value = true; }
      function openView(n) { const b = list.value.find(x => x.name === n); if (!b) return; viewBill.value = b; drawerMode.value = "view"; showDrawer.value = true; }
      function openEdit(n) { const b = list.value.find(x => x.name === n); if (!b) return; drawerMode.value = "edit"; resetForm(b); showDrawer.value = true; }

      function saveEWB() {
        if (!form.invoice_no.trim()) { toast("Please enter Invoice No.", "error"); return; }
        const existing = list.value.find(s => s.name === form.name);
        const doc = { ...form, name: drawerMode.value === "edit" ? form.name : nextNum(), created_at: existing?.created_at || todayStr() };
        const arr = readList(); const idx = arr.findIndex(s => s.name === doc.name);
        if (idx >= 0) arr[idx] = doc; else arr.unshift(doc);
        storeList(arr); list.value = arr; toast("E-Way Bill saved!"); showDrawer.value = false;
      }

      function cancelBill(b) {
        const arr = readList(); const o = arr.find(x => x.name === b.name); if (!o) return;
        o.status = "Cancelled"; storeList(arr); list.value = arr; toast("E-Way Bill cancelled"); showDrawer.value = false;
      }

      // Delete
      const showDelete = ref(false);
      const deleteTarget = ref(null);
      const deleting = ref(false);
      function confirmDelete(b) { deleteTarget.value = b; showDelete.value = true; }
      function doDelete() { deleting.value = true; const arr = readList().filter(s => s.name !== deleteTarget.value.name); storeList(arr); list.value = arr; toast("E-Way Bill deleted"); showDelete.value = false; deleting.value = false; }

      function daysLeft(b) {
        if (!b.expiry_date || effectiveStatus(b) !== "Active") return null;
        return Math.round((new Date(b.expiry_date) - new Date()) / (1000 * 60 * 60 * 24));
      }

      async function load() { loading.value = true; list.value = readList(); loading.value = false; }
      onMounted(load);

      return { list, loading, search, activeFilter, filtered, counts, summary, STATUS_CFG, effectiveStatus, daysLeft, showDrawer, drawerMode, saving, viewBill, form, updateExpiry, resetForm, saveEWB, cancelBill, openAdd, openEdit, openView, showDelete, deleteTarget, deleting, confirmDelete, doDelete, load, icon, fmt, fmtDate, flt };
    },
    template: `
<div class="b-page">
  <div class="qt-summary">
    <div class="qt-sum-card"><div class="qt-sum-label">Total E-Way Bills</div><div class="qt-sum-value">{{summary.total}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#059669">Active</div><div class="qt-sum-value" style="color:#059669">{{summary.active}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#d97706">Expiring Soon</div><div class="qt-sum-value" style="color:#d97706">{{summary.expiring}}</div></div>
    <div class="qt-sum-card"><div class="qt-sum-label" style="color:#2563eb">Taxable Value</div><div class="qt-sum-value" style="color:#2563eb">{{fmt(summary.value)}}</div></div>
  </div>
  <div class="cust-toolbar">
    <div class="cust-toolbar-left"><div class="cust-filters">
      <button class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter==='all'}" @click="activeFilter='all'">All</button>
      <button v-for="f in ['Active','Expired','Cancelled']" :key="f" class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter===f}" @click="activeFilter=f">
        {{f}} <span class="zb-pill-cnt" :class="activeFilter===f?'':'zb-pc-muted'">{{counts[f]||0}}</span>
      </button>
    </div></div>
    <div class="cust-toolbar-right">
      <div class="cust-search"><span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span><input v-model="search" placeholder="Search EWB, GSTIN, invoice…" class="cust-search-input" autocomplete="off"/></div>
      <button class="zb-tb-btn" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="zb-tb-btn zb-tb-primary" @click="openAdd"><span v-html="icon('plus',13)"></span> New E-Way Bill</button>
    </div>
  </div>
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead><tr><th>EWB No.</th><th>Invoice No.</th><th>From GSTIN</th><th>To GSTIN</th><th>Vehicle</th><th style="text-align:right">Taxable Value</th><th>Valid Until</th><th>Status</th><th style="text-align:center;width:90px">Actions</th></tr></thead>
        <tbody>
          <template v-if="loading"><tr v-for="n in 4" :key="n"><td colspan="9" style="padding:12px 14px"><div class="b-shimmer" style="height:13px;border-radius:4px;width:65%"></div></td></tr></template>
          <tr v-else-if="!filtered.length"><td colspan="9" class="cust-empty">
            <div class="cust-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></div>
            <div class="cust-empty-title">{{search?'No results':'No E-Way Bills yet'}}</div>
            <div class="cust-empty-sub">{{search?'Try a different search':'Create E-Way Bills for goods transport'}}</div>
            <button v-if="!search" class="nim-btn nim-btn-primary" style="margin-top:12px" @click="openAdd"><span v-html="icon('plus',13)"></span> New E-Way Bill</button>
          </td></tr>
          <tr v-else v-for="b in filtered" :key="b.name" class="cust-row" @click="openView(b.name)">
            <td>
              <div style="color:#2563eb;font-family:monospace;font-size:12px;font-weight:700">{{b.ewb_no||b.name}}</div>
              <div style="font-size:11px;color:#9ca3af">{{fmtDate(b.generated_date)}}</div>
            </td>
            <td style="font-family:monospace;font-size:12px;color:#374151;font-weight:600">{{b.invoice_no||'—'}}</td>
            <td class="cust-mono" style="font-size:11.5px">{{b.from_gstin||'—'}}</td>
            <td class="cust-mono" style="font-size:11.5px">{{b.to_gstin||'—'}}</td>
            <td class="cust-secondary">{{b.vehicle_no||'—'}}</td>
            <td style="text-align:right;font-family:monospace;font-weight:600;color:#111827">{{fmt(b.taxable_value)}}</td>
            <td>
              <template v-if="effectiveStatus(b)==='Active' && daysLeft(b)!==null">
                <span :class="['ri-next-chip', daysLeft(b)<=0?'ri-today':daysLeft(b)<=2?'ri-soon':'ri-ok']">
                  {{daysLeft(b)<=0?'Today':daysLeft(b)===1?'Tomorrow':fmtDate(b.expiry_date)}}
                </span>
              </template>
              <span v-else class="cust-secondary">{{fmtDate(b.expiry_date)||'—'}}</span>
            </td>
            <td><span class="b-badge" :class="STATUS_CFG[effectiveStatus(b)]?.cls||'b-badge-muted'">{{effectiveStatus(b)}}</span></td>
            <td @click.stop style="text-align:center"><div style="display:flex;gap:4px;justify-content:center">
              <button class="cust-act-btn cust-act-edit" @click="openEdit(b.name)" title="Edit"><span v-html="icon('edit',13)"></span></button>
              <button class="cust-act-btn cust-act-del" @click="confirmDelete(b)" title="Delete"><span v-html="icon('trash',13)"></span></button>
            </div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">Showing {{filtered.length}} of {{list.length}} E-Way Bills</div>
  </div>
  <!-- Drawer -->
  <teleport to="body">
    <transition name="cust-drawer-fade">
      <div v-if="showDrawer" class="cust-backdrop" @click.self="showDrawer=false">
        <transition name="cust-drawer-slide">
          <div v-if="showDrawer" class="cust-drawer" style="width:720px">
            <div class="cust-drawer-header">
              <div class="cust-drawer-header-left">
                <div class="cust-drawer-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></div>
                <div><div class="cust-drawer-title">{{drawerMode==='add'?'New E-Way Bill':drawerMode==='edit'?'Edit E-Way Bill':'E-Way Bill Details'}}</div><div class="cust-drawer-sub">{{drawerMode==='view'?(viewBill?.ewb_no||viewBill?.name):drawerMode==='edit'?form.name:'Enter transport and goods details'}}</div></div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <span v-if="drawerMode==='view'" class="b-badge" :class="STATUS_CFG[effectiveStatus(viewBill||{})]?.cls||'b-badge-muted'">{{effectiveStatus(viewBill||{})}}</span>
                <button class="nim-close" @click="showDrawer=false" v-html="icon('x',15)"></button>
              </div>
            </div>
            <!-- View mode -->
            <div v-if="drawerMode==='view' && viewBill" class="cust-drawer-body">
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field"><label class="nim-label">EWB Number</label><div style="font-size:14px;font-weight:700;color:#2563eb;font-family:monospace;padding:4px 0">{{viewBill.ewb_no||viewBill.name}}</div></div>
                <div class="nim-field"><label class="nim-label">Invoice No.</label><div style="font-size:13.5px;font-weight:600;color:#374151;font-family:monospace;padding:4px 0">{{viewBill.invoice_no||'—'}}</div></div>
                <div class="nim-field"><label class="nim-label">Invoice Date</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmtDate(viewBill.invoice_date)}}</div></div>
                <div class="nim-field"><label class="nim-label">Document Type</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{viewBill.doc_type}}</div></div>
                <div class="nim-field"><label class="nim-label">Generated On</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmtDate(viewBill.generated_date)}}</div></div>
                <div class="nim-field"><label class="nim-label">Valid Until</label><div :style="{fontSize:'13.5px',fontWeight:'700',color:effectiveStatus(viewBill)==='Expired'?'#dc2626':daysLeft(viewBill)<=2?'#d97706':'#059669',padding:'4px 0'}">{{fmtDate(viewBill.expiry_date)||'—'}}</div></div>
              </div>
              <div class="cust-sec-label">Consignor (From)</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field"><label class="nim-label">GSTIN</label><div style="font-size:13px;font-family:monospace;color:#374151;padding:4px 0">{{viewBill.from_gstin||'—'}}</div></div>
                <div class="nim-field"><label class="nim-label">Name</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{viewBill.from_name||'—'}}</div></div>
                <div v-if="viewBill.from_address" class="nim-field" style="grid-column:span 2"><label class="nim-label">Address</label><div style="font-size:13px;color:#6b7280;padding:4px 0">{{viewBill.from_address}}</div></div>
              </div>
              <div class="cust-sec-label">Consignee (To)</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field"><label class="nim-label">GSTIN</label><div style="font-size:13px;font-family:monospace;color:#374151;padding:4px 0">{{viewBill.to_gstin||'—'}}</div></div>
                <div class="nim-field"><label class="nim-label">Name</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{viewBill.to_name||'—'}}</div></div>
              </div>
              <div class="cust-sec-label">Transport</div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field"><label class="nim-label">Mode</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{viewBill.transport_mode}}</div></div>
                <div class="nim-field"><label class="nim-label">Vehicle No.</label><div style="font-size:13.5px;font-family:monospace;font-weight:700;color:#374151;padding:4px 0">{{viewBill.vehicle_no||'—'}}</div></div>
                <div class="nim-field"><label class="nim-label">Distance</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{viewBill.distance||0}} km</div></div>
              </div>
              <div class="cust-sec-label">Tax Details</div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field"><label class="nim-label">Taxable Value</label><div style="font-size:15px;font-weight:700;color:#111827;padding:4px 0">{{fmt(viewBill.taxable_value)}}</div></div>
                <div class="nim-field"><label class="nim-label">IGST</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmt(viewBill.igst)}}</div></div>
                <div class="nim-field"><label class="nim-label">CGST + SGST</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmt(flt(viewBill.cgst)+flt(viewBill.sgst))}}</div></div>
              </div>
            </div>
            <!-- Add/Edit form -->
            <div v-else-if="drawerMode!=='view'" class="cust-drawer-body">
              <div class="cust-sec-label" style="margin-top:0">Bill Details</div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field"><label class="nim-label">EWB Number (auto/manual)</label><input v-model="form.ewb_no" class="nim-input" placeholder="e.g. 123456789012"/></div>
                <div class="nim-field"><label class="nim-label">Invoice No. <span class="nim-req">*</span></label><input v-model="form.invoice_no" class="nim-input" placeholder="INV-2026-00001"/></div>
                <div class="nim-field"><label class="nim-label">Invoice Date</label><input v-model="form.invoice_date" type="date" class="nim-input"/></div>
                <div class="nim-field"><label class="nim-label">Document Type</label><select v-model="form.doc_type" class="nim-select"><option>Tax Invoice</option><option>Bill of Supply</option><option>Delivery Challan</option></select></div>
                <div class="nim-field"><label class="nim-label">Supply Type</label><select v-model="form.supply_type" class="nim-select"><option>Outward</option><option>Inward</option></select></div>
                <div class="nim-field"><label class="nim-label">Status</label><select v-model="form.status" class="nim-select"><option>Active</option><option>Cancelled</option></select></div>
              </div>
              <div class="cust-sec-label">Consignor (From)</div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field"><label class="nim-label">GSTIN</label><input v-model="form.from_gstin" class="nim-input" placeholder="27AAPFU0939F1ZV"/></div>
                <div class="nim-field"><label class="nim-label">Name</label><input v-model="form.from_name" class="nim-input" placeholder="Sender name"/></div>
                <div class="nim-field" style="grid-column:span 1"><label class="nim-label">Address</label><input v-model="form.from_address" class="nim-input" placeholder="City, State"/></div>
              </div>
              <div class="cust-sec-label">Consignee (To)</div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field"><label class="nim-label">GSTIN</label><input v-model="form.to_gstin" class="nim-input" placeholder="29ABCDE1234F1Z5"/></div>
                <div class="nim-field"><label class="nim-label">Name</label><input v-model="form.to_name" class="nim-input" placeholder="Receiver name"/></div>
                <div class="nim-field"><label class="nim-label">Address</label><input v-model="form.to_address" class="nim-input" placeholder="City, State"/></div>
              </div>
              <div class="cust-sec-label">Goods</div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field"><label class="nim-label">HSN Code</label><input v-model="form.hsn_code" class="nim-input" placeholder="e.g. 8471"/></div>
                <div class="nim-field"><label class="nim-label">Description</label><input v-model="form.description" class="nim-input" placeholder="Product description"/></div>
                <div class="nim-field"><label class="nim-label">Quantity</label><input v-model.number="form.quantity" type="number" min="0" class="nim-input"/></div>
                <div class="nim-field"><label class="nim-label">Unit</label><select v-model="form.unit" class="nim-select"><option>NOS</option><option>KGS</option><option>MTR</option><option>LTR</option><option>BOX</option><option>PCS</option></select></div>
                <div class="nim-field"><label class="nim-label">Taxable Value (₹)</label><input v-model.number="form.taxable_value" type="number" min="0" class="nim-input"/></div>
              </div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field"><label class="nim-label">IGST (₹)</label><input v-model.number="form.igst" type="number" min="0" step="0.01" class="nim-input"/></div>
                <div class="nim-field"><label class="nim-label">CGST (₹)</label><input v-model.number="form.cgst" type="number" min="0" step="0.01" class="nim-input"/></div>
                <div class="nim-field"><label class="nim-label">SGST (₹)</label><input v-model.number="form.sgst" type="number" min="0" step="0.01" class="nim-input"/></div>
              </div>
              <div class="cust-sec-label">Transport</div>
              <div class="nim-grid-3 nim-mb">
                <div class="nim-field"><label class="nim-label">Transport Mode</label><select v-model="form.transport_mode" class="nim-select"><option>Road</option><option>Rail</option><option>Air</option><option>Ship</option></select></div>
                <div class="nim-field"><label class="nim-label">Distance (km)</label><input v-model.number="form.distance" type="number" min="1" class="nim-input" placeholder="e.g. 350" @input="updateExpiry"/></div>
                <div class="nim-field"><label class="nim-label">Transporter ID/GSTIN</label><input v-model="form.transporter_id" class="nim-input" placeholder="Transporter GSTIN"/></div>
                <div class="nim-field"><label class="nim-label">Transporter Name</label><input v-model="form.transporter_name" class="nim-input" placeholder="Transport company"/></div>
                <div class="nim-field"><label class="nim-label">Vehicle Number</label><input v-model="form.vehicle_no" class="nim-input" placeholder="MH01AB1234"/></div>
                <div class="nim-field"><label class="nim-label">Vehicle Type</label><select v-model="form.vehicle_type" class="nim-select" @change="updateExpiry"><option>Regular</option><option>Over Dimensional Cargo</option></select></div>
              </div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field"><label class="nim-label">Generated Date</label><input v-model="form.generated_date" type="date" class="nim-input" @input="updateExpiry"/></div>
                <div class="nim-field"><label class="nim-label">Expiry Date <span style="color:#9ca3af;font-weight:400">(auto-calculated)</span></label><input v-model="form.expiry_date" type="date" class="nim-input"/></div>
              </div>
            </div>
            <div class="nim-footer">
              <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">{{drawerMode==='view'?'Close':'Cancel'}}</button>
              <div v-if="drawerMode==='view'" style="display:flex;gap:8px">
                <button v-if="viewBill?.status!=='Cancelled'" class="nim-btn nim-btn-outline" style="color:#dc2626;border-color:#dc2626" @click="cancelBill(viewBill)">Cancel Bill</button>
                <button class="nim-btn nim-btn-outline" @click="openEdit(viewBill.name)"><span v-html="icon('edit',13)"></span> Edit</button>
              </div>
              <button v-else class="nim-btn nim-btn-primary" @click="saveEWB" :disabled="saving">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                {{drawerMode==='edit'?'Save Changes':'Generate E-Way Bill'}}
              </button>
            </div>
          </div>
        </transition>
      </div>
    </transition>
  </teleport>
  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left"><div class="nim-header-icon"><span v-html="icon('trash',16)"></span></div><div class="nim-header-title">Delete E-Way Bill?</div></div>
          <button class="nim-close" @click="showDelete=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px"><p style="font-size:14px;color:#374151;line-height:1.6">Delete <strong>{{deleteTarget?.ewb_no||deleteTarget?.name}}</strong>? This cannot be undone.</p></div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Keep It</button>
          <button @click="doDelete" :disabled="deleting" style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff">{{deleting?'Deleting…':'Yes, Delete'}}</button>
        </div>
      </div>
    </div>
  </teleport>
</div>
`});


  /* ═══════════════════════════════════════════════════════════════
     PURCHASE ORDERS COMPONENT
     localStorage-backed, mirrors purchase-orders.html exactly
  ═══════════════════════════════════════════════════════════════ */
  const PurchaseOrders = defineComponent({
    name: "PurchaseOrders",
    setup() {
      const router = useRouter();
      const LKEY = "books_purchase_orders";
      const STEPS = ["Draft", "Sent", "Confirmed", "Received", "Billed"];

      /* ── localStorage helpers ── */
      function storeList(d) { try { localStorage.setItem(LKEY, JSON.stringify(d)); } catch { } }
      function readList() { try { return JSON.parse(localStorage.getItem(LKEY) || "[]"); } catch { return []; } }
      function nextNum() {
        const nums = readList().map(o => parseInt((o.name || "PO-0").replace(/\D/g, "")) || 0);
        return "PO-" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
      }
      function todayStr() { return new Date().toISOString().slice(0, 10); }
      function addDays(d, n) { const dt = new Date(d); dt.setDate(dt.getDate() + n); return dt.toISOString().slice(0, 10); }

      /* ── State ── */
      const list = ref([]);
      const vendors = ref([]);
      const allItems = ref([]);
      const loading = ref(true);
      const search = ref("");
      const activeFilter = ref("all");

      /* ── Drawer state ── */
      const showDrawer = ref(false);
      const drawerMode = ref("add"); // "add" | "edit" | "view"
      const saving = ref(false);
      const viewOrder = ref(null);

      const selVendor = ref("");
      const vendSearch = ref("");
      const showVendDrop = ref(false);
      const itemSearch = ref([]);  // per-row item search state
      const showItemDrop = ref([]);  // per-row dropdown visibility

      const form = reactive({
        name: "", vendor: "", order_date: "", expected_date: "",
        status: "Draft", vendor_ref: "", delivery_address: "", terms: "",
        items: [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
        taxes: [],
        net_total: 0, total_tax: 0, grand_total: 0,
        received_value: 0, created_at: "",
      });

      /* ── Confirm modals ── */
      const showConvert = ref(false);
      const convertTarget = ref(null);
      const showDelete = ref(false);
      const deleteTarget = ref(null);
      const deleting = ref(false);

      /* ── Summary ── */
      const summary = computed(() => {
        const pending = list.value.filter(o => ["Sent", "Confirmed"].includes(o.status)).length;
        const received = list.value.filter(o => o.status === "Received").length;
        const value = list.value.reduce((s, o) => s + flt(o.grand_total), 0);
        return { total: list.value.length, pending, received, value };
      });

      const STATUS_CFG = {
        Draft: { cls: "b-badge-muted", lbl: "Draft" },
        Sent: { cls: "b-badge-blue", lbl: "Sent" },
        Confirmed: { cls: "b-badge-amber", lbl: "Confirmed" },
        Received: { cls: "b-badge-green", lbl: "Received" },
        Billed: { cls: "b-badge-purple", lbl: "Billed" },
        Cancelled: { cls: "b-badge-red", lbl: "Cancelled" },
      };

      const counts = computed(() => {
        const r = {};
        ["Draft", "Sent", "Confirmed", "Received", "Billed"].forEach(s => {
          r[s] = list.value.filter(o => o.status === s).length;
        });
        return r;
      });

      const pillCls = (k) => ({
        Draft: "zb-pc-muted", Sent: "b-badge-blue", Confirmed: "zb-pc-amber",
        Received: "zb-pc-green", Billed: "zb-pc-muted"
      })[k] || "zb-pc-muted";

      const filtered = computed(() => {
        let r = activeFilter.value === "all" ? list.value : list.value.filter(o => o.status === activeFilter.value);
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(o => (o.name + o.vendor + (o.vendor_ref || "")).toLowerCase().includes(q));
        return r;
      });

      function receivedPct(o) {
        const g = flt(o.grand_total);
        return g > 0 ? Math.min(100, Math.round(flt(o.received_value) / g * 100)) : 0;
      }

      /* ── Load ── */
      async function load() {
        loading.value = true;
        list.value = readList();
        loading.value = false;
        try { vendors.value = await apiList("Supplier", { fields: ["name", "supplier_name"], filters: [["disabled", "=", 0]], order: "supplier_name asc", limit: 300 }); } catch { }
        try { allItems.value = await apiGET("zoho_books_clone.api.books_data.get_items", {}) || []; } catch { }
      }

      /* ── Vendor dropdown helpers ── */
      const vendDropItems = computed(() => {
        const q = vendSearch.value.toLowerCase();
        return vendors.value.filter(v =>
          (v.supplier_name || "").toLowerCase().includes(q) || v.name.toLowerCase().includes(q)
        ).slice(0, 40);
      });
      function pickVendor(v) {
        selVendor.value = v.name;
        vendSearch.value = v.supplier_name || v.name;
        form.vendor = v.name;
        showVendDrop.value = false;
      }

      /* ── Item dropdown helpers ── */
      function itemDropItems(i) {
        const q = (itemSearch.value[i] || "").toLowerCase();
        return allItems.value.filter(it => (it.item_name || "").toLowerCase().includes(q)).slice(0, 25);
      }
      function pickItem(i, it) {
        form.items[i].item_name = it.item_name || it.name;
        form.items[i].rate = flt(it.standard_rate);
        form.items[i].description = it.description || "";
        recalc();
        showItemDrop.value = showItemDrop.value.map((v, idx) => idx === i ? false : v);
      }

      /* ── Recalc ── */
      function recalc() {
        form.items.forEach(r => { r.amount = Math.round(flt(r.qty) * flt(r.rate) * 100) / 100; });
        const net = form.items.reduce((s, r) => s + flt(r.amount), 0);
        form.taxes.forEach(t => { t.tax_amount = flt(t.rate) > 0 ? Math.round(net * flt(t.rate) / 100 * 100) / 100 : 0; });
        form.net_total = Math.round(net * 100) / 100;
        form.total_tax = Math.round(form.taxes.reduce((s, t) => s + flt(t.tax_amount), 0) * 100) / 100;
        form.grand_total = Math.round((net + form.total_tax) * 100) / 100;
      }

      function addRow() {
        form.items.push({ item_name: "", description: "", qty: 1, rate: 0, amount: 0 });
        itemSearch.value.push("");
        showItemDrop.value.push(false);
      }
      function removeRow(i) {
        if (form.items.length > 1) {
          form.items.splice(i, 1);
          itemSearch.value.splice(i, 1);
          showItemDrop.value.splice(i, 1);
          recalc();
        }
      }
      function addTax() { form.taxes.push({ tax_type: "CGST", description: "CGST", rate: 9, tax_amount: 0 }); recalc(); }
      function removeTax(i) { form.taxes.splice(i, 1); recalc(); }

      /* ── Reset form ── */
      function resetForm(from) {
        const s = from || {};
        Object.assign(form, {
          name: s.name || "",
          vendor: s.vendor || "",
          order_date: s.order_date || todayStr(),
          expected_date: s.expected_date || addDays(todayStr(), 14),
          status: s.status || "Draft",
          vendor_ref: s.vendor_ref || "",
          delivery_address: s.delivery_address || "",
          terms: s.terms || "",
          items: s.items?.length ? s.items.map(r => ({ ...r })) : [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
          taxes: (s.taxes || []).map(t => ({ ...t })),
          net_total: flt(s.net_total),
          total_tax: flt(s.total_tax),
          grand_total: flt(s.grand_total),
          received_value: flt(s.received_value),
          created_at: s.created_at || todayStr(),
        });
        selVendor.value = s.vendor || "";
        vendSearch.value = s.vendor || "";
        itemSearch.value = form.items.map(() => "");
        showItemDrop.value = form.items.map(() => false);
        showVendDrop.value = false;
      }

      /* ── Open modes ── */
      function openAdd() {
        drawerMode.value = "add";
        resetForm();
        showDrawer.value = true;
      }
      function openEdit(name) {
        const o = list.value.find(x => x.name === name); if (!o) return;
        drawerMode.value = "edit";
        resetForm(o);
        showDrawer.value = true;
      }
      function openView(name) {
        const o = list.value.find(x => x.name === name); if (!o) return;
        viewOrder.value = o;
        drawerMode.value = "view";
        showDrawer.value = true;
      }

      /* ── Save ── */
      function saveOrder(status) {
        const vendor = selVendor.value || vendSearch.value.trim();
        if (!vendor) { toast("Please select a Vendor", "error"); return; }
        recalc();
        const existing = list.value.find(o => o.name === form.name);
        const doc = {
          name: form.name || nextNum(),
          vendor,
          order_date: form.order_date || todayStr(),
          expected_date: form.expected_date,
          status,
          vendor_ref: form.vendor_ref.trim(),
          delivery_address: form.delivery_address.trim(),
          items: form.items.filter(r => r.item_name || r.rate).map(r => ({ ...r })),
          taxes: form.taxes.map(t => ({ ...t })),
          net_total: form.net_total,
          total_tax: form.total_tax,
          grand_total: form.grand_total,
          received_value: existing?.received_value || 0,
          terms: form.terms.trim(),
          created_at: existing?.created_at || todayStr(),
        };
        const arr = readList();
        const idx = arr.findIndex(o => o.name === doc.name);
        if (idx >= 0) arr[idx] = doc; else arr.unshift(doc);
        storeList(arr); list.value = arr;
        toast(status === "Sent" ? "Order sent to vendor!" : drawerMode.value === "edit" ? "Order updated" : "Order saved as Draft");
        showDrawer.value = false;
      }

      /* ── Advance status ── */
      function advanceStatus(name, newStatus) {
        const arr = readList();
        const o = arr.find(x => x.name === name); if (!o) return;
        o.status = newStatus;
        storeList(arr); list.value = arr;
        toast("Order " + name + " → " + newStatus);
        showDrawer.value = false;
        if (viewOrder.value?.name === name) viewOrder.value = { ...o };
      }

      /* ── Convert to Bill ── */
      function openConvert(name) { convertTarget.value = name; showConvert.value = true; }
      function doConvert() {
        const arr = readList();
        const o = arr.find(x => x.name === convertTarget.value); if (!o) { showConvert.value = false; return; }
        o.status = "Billed"; o.received_value = o.grand_total;
        storeList(arr); list.value = arr;
        toast("Order billed. Open Purchase Bills to see the new bill.", "info");
        showConvert.value = false; showDrawer.value = false;
        router.push("/purchases");
      }

      /* ── Delete ── */
      function confirmDelete(name) { deleteTarget.value = name; showDelete.value = true; }
      function doDelete() {
        deleting.value = true;
        const arr = readList().filter(o => o.name !== deleteTarget.value);
        storeList(arr); list.value = arr;
        toast("Order deleted"); showDelete.value = false; deleting.value = false; showDrawer.value = false;
      }

      const nextStatusMap = { Draft: "Sent", Sent: "Confirmed", Confirmed: "Received", Received: "Billed" };
      const nextLabelMap = { Draft: "Mark Sent", Sent: "Confirm Order", Confirmed: "Mark Received", Received: "Mark Billed" };
      const nextColorMap = { Draft: "#E67700", Sent: "#E67700", Confirmed: "#2F9E44", Received: "#7048E8" };

      onMounted(load);

      return {
        list, vendors, allItems, loading, search, activeFilter, filtered,
        summary, STATUS_CFG, counts, pillCls, receivedPct, STEPS,
        showDrawer, drawerMode, saving, viewOrder, form,
        selVendor, vendSearch, showVendDrop, vendDropItems,
        itemSearch, showItemDrop, itemDropItems,
        showConvert, convertTarget, showDelete, deleteTarget, deleting,
        nextStatusMap, nextLabelMap, nextColorMap,
        load, openAdd, openEdit, openView, saveOrder, advanceStatus,
        openConvert, doConvert, confirmDelete, doDelete,
        addRow, removeRow, addTax, removeTax, recalc, pickVendor, pickItem,
        fmt, fmtDate, flt, icon, todayStr, addDays, toast
      };
    },
    template: `
<div class="b-page cust-page">

  <!-- Summary strip -->
  <div class="qt-summary">
    <div class="qt-sum-card">
      <div class="qt-sum-label">Total Orders</div>
      <div class="qt-sum-value">{{summary.total}}</div>
    </div>
    <div class="qt-sum-card">
      <div class="qt-sum-label" style="color:#E67700">Pending Receipt</div>
      <div class="qt-sum-value" style="color:#E67700">{{summary.pending}}</div>
    </div>
    <div class="qt-sum-card">
      <div class="qt-sum-label" style="color:#2F9E44">Received</div>
      <div class="qt-sum-value" style="color:#2F9E44">{{summary.received}}</div>
    </div>
    <div class="qt-sum-card">
      <div class="qt-sum-label" style="color:#3B5BDB">Order Value</div>
      <div class="qt-sum-value" style="color:#3B5BDB;font-size:17px">{{fmt(summary.value)}}</div>
    </div>
  </div>

  <!-- Toolbar -->
  <div class="cust-toolbar">
    <div class="cust-toolbar-left">
      <div class="cust-filters">
        <button class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter==='all'}" @click="activeFilter='all'">All</button>
        <button v-for="f in ['Draft','Sent','Confirmed','Received','Billed']" :key="f"
          class="zb-inv-pill" :class="{'zb-inv-pill-active':activeFilter===f}"
          @click="activeFilter=f">
          {{f}}
          <span class="zb-pill-cnt" :class="activeFilter===f ? pillCls(f) : 'zb-pc-muted'">{{counts[f]}}</span>
        </button>
      </div>
    </div>
    <div class="cust-toolbar-right">
      <div class="cust-search">
        <span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span>
        <input v-model="search" placeholder="Search order, vendor..." class="cust-search-input" autocomplete="off"/>
      </div>
      <button class="zb-tb-btn" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="zb-tb-btn" style="background:#E67700;color:#fff;border-color:#E67700" @click="openAdd">
        <span v-html="icon('plus',13)"></span> New Order
      </button>
    </div>
  </div>

  <!-- Table -->
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead>
          <tr>
            <th>PO #</th>
            <th>Vendor</th>
            <th>Order Date</th>
            <th>Expected By</th>
            <th style="text-align:right">Amount</th>
            <th style="min-width:110px">Received</th>
            <th>Status</th>
            <th style="text-align:center;width:120px">Actions</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading">
            <tr v-for="n in 5" :key="n">
              <td colspan="8" style="padding:12px 14px">
                <div class="b-shimmer" style="height:13px;border-radius:4px;width:70%"></div>
              </td>
            </tr>
          </template>
          <tr v-else-if="!filtered.length">
            <td colspan="8" class="cust-empty">
              <div class="cust-empty-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5">
                  <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                </svg>
              </div>
              <div class="cust-empty-title">{{search ? 'No orders match' : 'No purchase orders yet'}}</div>
              <div class="cust-empty-sub">{{search ? 'Try a different search' : 'Create purchase orders to track procurement'}}</div>
              <button v-if="!search" class="nim-btn nim-btn-primary" style="margin-top:12px;background:#E67700;border-color:#E67700" @click="openAdd">
                <span v-html="icon('plus',13)"></span> New Order
              </button>
            </td>
          </tr>
          <tr v-else v-for="o in filtered" :key="o.name" class="cust-row" @click="openView(o.name)">
            <td>
              <div style="color:#E67700;font-family:monospace;font-size:12px;font-weight:700">{{o.name}}</div>
              <div v-if="o.vendor_ref" style="font-size:11px;color:#9ca3af">Ref: {{o.vendor_ref}}</div>
            </td>
            <td class="cust-name">{{o.vendor||'—'}}</td>
            <td class="cust-secondary">{{fmtDate(o.order_date)}}</td>
            <td class="cust-secondary">{{fmtDate(o.expected_date)||'—'}}</td>
            <td style="text-align:right;font-family:monospace;font-weight:600;color:#111827">{{fmt(o.grand_total)}}</td>
            <td>
              <div style="display:flex;align-items:center;gap:8px">
                <div style="flex:1;background:#e4e8f0;border-radius:20px;height:6px;overflow:hidden;min-width:60px">
                  <div :style="{width:receivedPct(o)+'%',height:'100%',borderRadius:'20px',background:receivedPct(o)>=100?'#059669':receivedPct(o)>0?'#E67700':'#e4e8f0',transition:'width .3s'}"></div>
                </div>
                <span style="font-size:11px;color:#9ca3af;white-space:nowrap">{{receivedPct(o)}}%</span>
              </div>
            </td>
            <td>
              <span class="b-badge" :class="(STATUS_CFG[o.status]||STATUS_CFG.Draft).cls">
                {{o.status}}
              </span>
            </td>
            <td @click.stop style="text-align:center">
              <div style="display:flex;gap:4px;justify-content:center">
                <button class="cust-act-btn cust-act-edit" @click="openView(o.name)" title="View">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
                <button v-if="!['Billed','Cancelled'].includes(o.status)"
                  class="cust-act-btn" style="color:#059669;border-color:rgba(5,150,105,.3);background:none;width:28px;height:28px;border-radius:6px;border-width:1.5px;cursor:pointer;display:grid;place-items:center"
                  @click="openConvert(o.name)" title="Create Bill">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </button>
                <button v-if="o.status==='Draft'" class="cust-act-btn cust-act-del" @click="confirmDelete(o.name)" title="Delete">
                  <span v-html="icon('trash',13)"></span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">
      Showing {{filtered.length}} of {{list.length}} orders
    </div>
  </div>

  <!-- ══ DRAWER ══ -->
  <teleport to="body">
    <transition name="cust-drawer-fade">
      <div v-if="showDrawer" class="cust-backdrop" @click.self="showDrawer=false">
        <transition name="cust-drawer-slide">
          <div v-if="showDrawer" class="cust-drawer" style="width:740px">

            <!-- Header -->
            <div class="cust-drawer-header" :style="{background: drawerMode==='view' ? 'linear-gradient(135deg,#E67700,#C96200)' : 'linear-gradient(135deg,#2563eb,#4f46e5)'}">
              <div class="cust-drawer-header-left">
                <div class="cust-drawer-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                </div>
                <div>
                  <div class="cust-drawer-title">
                    {{drawerMode==='add' ? 'New Purchase Order' : drawerMode==='edit' ? 'Edit Order' : viewOrder?.name}}
                  </div>
                  <div class="cust-drawer-sub">
                    {{drawerMode==='view' ? 'Vendor: '+viewOrder?.vendor : drawerMode==='edit' ? form.name : 'Fill in order details'}}
                  </div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <span v-if="drawerMode==='view'" class="b-badge" :class="(STATUS_CFG[viewOrder?.status]||STATUS_CFG.Draft).cls">
                  {{viewOrder?.status}}
                </span>
                <button class="nim-close" @click="showDrawer=false" v-html="icon('x',15)"></button>
              </div>
            </div>

            <!-- ── VIEW MODE ── -->
            <div v-if="drawerMode==='view' && viewOrder" class="cust-drawer-body">
              <!-- Status timeline -->
              <div class="so-timeline" style="margin-bottom:20px">
                <div v-for="(step,i) in STEPS" :key="step" class="so-tl-step">
                  <div class="so-tl-dot"
                    :class="STEPS.indexOf(viewOrder.status)>i ? 'so-done' : STEPS.indexOf(viewOrder.status)===i ? 'so-active' : 'so-pending'">
                    <svg v-if="STEPS.indexOf(viewOrder.status)>i" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    <span v-else>{{i+1}}</span>
                  </div>
                  <span class="so-tl-label" :class="STEPS.indexOf(viewOrder.status)>=i ? 'so-tl-active' : 'so-tl-pending'">{{step}}</span>
                  <div v-if="i<STEPS.length-1" class="so-tl-line" :class="STEPS.indexOf(viewOrder.status)>i ? 'so-line-done' : ''"></div>
                </div>
              </div>

              <!-- Detail grid -->
              <div class="cust-sec-label" style="margin-top:0">Order Details</div>
              <div class="nim-grid-2 nim-mb">
                <div class="nim-field"><label class="nim-label">Vendor</label><div style="font-size:13.5px;font-weight:600;color:#111827;padding:4px 0">{{viewOrder.vendor}}</div></div>
                <div class="nim-field"><label class="nim-label">Order Date</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmtDate(viewOrder.order_date)}}</div></div>
                <div class="nim-field"><label class="nim-label">Expected By</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{fmtDate(viewOrder.expected_date)||'—'}}</div></div>
                <div class="nim-field"><label class="nim-label">Vendor Reference</label><div style="font-size:13.5px;color:#374151;padding:4px 0">{{viewOrder.vendor_ref||'—'}}</div></div>
                <div v-if="viewOrder.delivery_address" class="nim-field" style="grid-column:span 2">
                  <label class="nim-label">Delivery Address</label>
                  <div style="font-size:13px;color:#374151;white-space:pre-line;padding:4px 0">{{viewOrder.delivery_address}}</div>
                </div>
              </div>

              <!-- Items table -->
              <div class="cust-sec-label">Line Items</div>
              <div class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th>Item</th><th>Description</th>
                    <th style="text-align:center">Qty</th>
                    <th style="text-align:right">Rate</th>
                    <th style="text-align:right">Amount</th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="r in (viewOrder.items||[])" :key="r.item_name" class="nim-tr">
                      <td style="font-weight:600">{{r.item_name||'—'}}</td>
                      <td class="cust-secondary">{{r.description||''}}</td>
                      <td style="text-align:center">{{r.qty||1}}</td>
                      <td class="nim-amount" style="text-align:right">{{fmt(r.rate)}}</td>
                      <td class="nim-amount" style="text-align:right">{{fmt(r.amount)}}</td>
                    </tr>
                    <tr v-if="!viewOrder.items?.length"><td colspan="5" style="text-align:center;padding:14px;color:#9ca3af">No items</td></tr>
                  </tbody>
                </table>
              </div>

              <!-- Totals -->
              <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
                <div class="nim-totals">
                  <div class="nim-total-row"><span class="nim-total-label">Subtotal</span><span class="nim-total-val">{{fmt(viewOrder.net_total)}}</span></div>
                  <div v-if="flt(viewOrder.total_tax)" class="nim-total-row nim-tax-row"><span class="nim-total-label">Tax</span><span class="nim-total-val">{{fmt(viewOrder.total_tax)}}</span></div>
                  <div class="nim-total-grand"><span>Grand Total</span><span>{{fmt(viewOrder.grand_total)}}</span></div>
                </div>
              </div>

              <div v-if="viewOrder.terms" class="nim-field">
                <label class="nim-label">Terms &amp; Conditions</label>
                <div style="font-size:13px;color:#6b7280;line-height:1.6;white-space:pre-line">{{viewOrder.terms}}</div>
              </div>
            </div>

            <!-- ── ADD / EDIT FORM ── -->
            <div v-else-if="drawerMode!=='view'" class="cust-drawer-body">
              <div class="cust-sec-label" style="margin-top:0">Order Details</div>
              <div class="nim-grid-3 nim-mb">
                <!-- Vendor typeahead -->
                <div class="nim-field" style="position:relative">
                  <label class="nim-label">Vendor <span class="nim-req">*</span></label>
                  <input v-model="vendSearch" class="nim-input" placeholder="Search vendor..."
                    autocomplete="off"
                    @focus="showVendDrop=true"
                    @blur="setTimeout(()=>showVendDrop=false,200)"
                    @input="showVendDrop=true"/>
                  <div v-if="showVendDrop && vendDropItems.length" class="qt-cust-drop">
                    <div v-for="v in vendDropItems" :key="v.name" class="qt-drop-item"
                      @mousedown.prevent="pickVendor(v)">
                      <div style="font-weight:600;font-size:13px">{{v.supplier_name||v.name}}</div>
                      <div v-if="v.name!==v.supplier_name" style="font-size:11px;color:#9ca3af">{{v.name}}</div>
                    </div>
                  </div>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Order Date <span class="nim-req">*</span></label>
                  <input v-model="form.order_date" type="date" class="nim-input"/>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Expected By</label>
                  <input v-model="form.expected_date" type="date" class="nim-input"/>
                </div>
              </div>

              <div class="nim-grid-3 nim-mb">
                <div class="nim-field">
                  <label class="nim-label">Status</label>
                  <select v-model="form.status" class="nim-select">
                    <option>Draft</option><option>Sent</option>
                    <option>Confirmed</option><option>Received</option>
                  </select>
                </div>
                <div class="nim-field">
                  <label class="nim-label">Vendor Reference No.</label>
                  <input v-model="form.vendor_ref" class="nim-input" placeholder="Vendor's quote / ref no."/>
                </div>
                <div></div>
              </div>

              <div class="nim-mb">
                <div class="nim-field">
                  <label class="nim-label">Delivery Address</label>
                  <textarea v-model="form.delivery_address" class="nim-input nim-textarea" rows="2"
                    placeholder="Delivery / ship-to address..."></textarea>
                </div>
              </div>

              <!-- Items -->
              <div class="nim-section-header" style="margin-bottom:8px">
                <div class="cust-sec-label" style="margin:0">Line Items</div>
              </div>
              <div class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th style="width:28%">Item / Service</th>
                    <th style="width:25%">Description</th>
                    <th style="width:10%;text-align:center">Qty</th>
                    <th style="width:16%;text-align:right">Rate (₹)</th>
                    <th style="width:16%;text-align:right">Amount (₹)</th>
                    <th style="width:5%"></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(item,i) in form.items" :key="i" class="nim-tr">
                      <!-- Item name with typeahead -->
                      <td style="position:relative">
                        <input v-model="item.item_name" class="nim-cell" placeholder="Item name"
                          @input="itemSearch[i]=item.item_name;showItemDrop[i]=true"
                          @focus="showItemDrop[i]=true"
                          @blur="setTimeout(()=>showItemDrop[i]=false,200)"
                          autocomplete="off"/>
                        <div v-if="showItemDrop[i] && itemDropItems(i).length"
                          style="position:absolute;top:100%;left:0;right:0;z-index:9999;background:#fff;border:1px solid #CDD5E0;border-radius:8px;max-height:160px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.1)">
                          <div v-for="it in itemDropItems(i)" :key="it.name"
                            style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #F1F3F5"
                            @mousedown.prevent="pickItem(i,it)"
                            @mouseover="$event.target.style.background='#F8F9FC'"
                            @mouseout="$event.target.style.background=''">
                            <div style="font-weight:500">{{it.item_name||it.name}}</div>
                            <div style="font-size:11px;color:#9ca3af">₹{{it.standard_rate||0}}</div>
                          </div>
                        </div>
                      </td>
                      <td><input v-model="item.description" class="nim-cell" placeholder="Description"/></td>
                      <td style="text-align:center">
                        <input v-model.number="item.qty" type="number" min="0.01" step="0.01"
                          class="nim-cell nim-num" style="text-align:center" @input="recalc"/>
                      </td>
                      <td style="text-align:right">
                        <input v-model.number="item.rate" type="number" min="0" step="0.01"
                          class="nim-cell nim-num" @input="recalc"/>
                      </td>
                      <td class="nim-amount" style="text-align:right;font-variant-numeric:tabular-nums">
                        {{flt(item.amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}
                      </td>
                      <td style="text-align:center">
                        <button v-if="form.items.length>1" @click="removeRow(i)" class="nim-del-btn" v-html="icon('trash',13)"></button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div class="nim-table-footer">
                  <button @click="addRow" class="nim-add-btn">
                    <span v-html="icon('plus',12)"></span> Add Row
                  </button>
                </div>
              </div>

              <!-- Taxes -->
              <div class="nim-section-header nim-mb-sm">
                <div class="cust-sec-label" style="margin:0">Taxes</div>
                <button @click="addTax" class="nim-add-btn">
                  <span v-html="icon('plus',12)"></span> Add Tax
                </button>
              </div>
              <div v-if="form.taxes.length" class="nim-table-wrap nim-mb">
                <table class="nim-table">
                  <thead><tr>
                    <th style="width:20%">Type</th><th style="width:30%">Description</th>
                    <th style="width:14%;text-align:center">Rate %</th>
                    <th style="width:32%;text-align:right">Amount (₹)</th>
                    <th style="width:4%"></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(tax,i) in form.taxes" :key="i" class="nim-tr">
                      <td>
                        <select v-model="tax.tax_type" class="nim-cell"
                          @change="tax.description=tax.tax_type;recalc()">
                          <option>CGST</option><option>SGST</option><option>IGST</option>
                          <option>Cess</option><option>Other</option>
                        </select>
                      </td>
                      <td><input v-model="tax.description" class="nim-cell"/></td>
                      <td style="text-align:center">
                        <input v-model.number="tax.rate" type="number" min="0" max="100" step="0.01"
                          class="nim-cell nim-num" @input="recalc"/>
                      </td>
                      <td class="nim-amount" style="text-align:right;font-variant-numeric:tabular-nums">
                        {{flt(tax.tax_amount).toLocaleString('en-IN',{minimumFractionDigits:2})}}
                      </td>
                      <td style="text-align:center">
                        <button @click="removeTax(i)" class="nim-del-btn" v-html="icon('trash',13)"></button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Totals + Terms -->
              <div class="nim-bottom-row">
                <div class="nim-field" style="flex:1">
                  <label class="nim-label">Terms &amp; Conditions</label>
                  <textarea v-model="form.terms" class="nim-input nim-textarea" rows="4"
                    placeholder="Delivery terms, payment terms..."></textarea>
                </div>
                <div class="nim-totals">
                  <div class="nim-total-row"><span class="nim-total-label">Subtotal</span><span class="nim-total-val">{{fmt(form.net_total)}}</span></div>
                  <div v-for="tax in form.taxes" :key="tax.tax_type" class="nim-total-row nim-tax-row">
                    <span class="nim-total-label">{{tax.description||tax.tax_type}} ({{tax.rate}}%)</span>
                    <span class="nim-total-val">{{fmt(tax.tax_amount)}}</span>
                  </div>
                  <div class="nim-total-grand"><span>Grand Total</span><span>{{fmt(form.grand_total)}}</span></div>
                </div>
              </div>
            </div>

            <!-- Footer -->
            <div class="nim-footer">
              <!-- View footer -->
              <template v-if="drawerMode==='view' && viewOrder">
                <div style="font-size:12px;color:#9ca3af">Created {{fmtDate(viewOrder.created_at)}}</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="nim-btn nim-btn-ghost" @click="openEdit(viewOrder.name)">
                    <span v-html="icon('edit',13)"></span> Edit
                  </button>
                  <button v-if="nextStatusMap[viewOrder.status]"
                    class="nim-btn"
                    :style="{background:nextColorMap[viewOrder.status],color:'#fff',borderColor:nextColorMap[viewOrder.status],height:'37px',padding:'0 14px',borderRadius:'8px',fontSize:'13.5px',fontWeight:'600',border:'none',cursor:'pointer'}"
                    @click="advanceStatus(viewOrder.name, nextStatusMap[viewOrder.status])">
                    {{nextLabelMap[viewOrder.status]}}
                  </button>
                  <button v-if="!['Billed','Cancelled'].includes(viewOrder.status)"
                    class="nim-btn nim-btn-primary" style="background:#E67700;border-color:#E67700"
                    @click="openConvert(viewOrder.name)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    Create Bill
                  </button>
                </div>
              </template>
              <!-- Add/Edit footer -->
              <template v-else-if="drawerMode!=='view'">
                <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">Cancel</button>
                <div style="display:flex;gap:8px">
                  <button class="nim-btn nim-btn-outline" style="border-color:#E67700;color:#E67700"
                    @click="saveOrder('Draft')" :disabled="saving">
                    Save as Draft
                  </button>
                  <button class="nim-btn nim-btn-primary" style="background:#E67700;border-color:#E67700"
                    @click="saveOrder(drawerMode==='edit' ? form.status : 'Sent')" :disabled="saving">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {{drawerMode==='edit' ? 'Save Changes' : 'Send to Vendor'}}
                  </button>
                </div>
              </template>
            </div>

          </div>
        </transition>
      </div>
    </transition>
  </teleport>

  <!-- Convert to Bill modal -->
  <teleport to="body">
    <div v-if="showConvert" class="nim-overlay" @click.self="showConvert=false">
      <div class="nim-dialog" style="max-width:440px">
        <div class="nim-header" style="background:linear-gradient(135deg,#E67700,#C96200)">
          <div class="nim-header-left">
            <div class="nim-header-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <div class="nim-header-title">Create Purchase Bill?</div>
          </div>
          <button class="nim-close" @click="showConvert=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Create a Purchase Bill from <strong>{{convertTarget}}</strong>
            for <strong>{{list.find(o=>o.name===convertTarget)?.vendor}}</strong>
            — <strong>{{fmt(list.find(o=>o.name===convertTarget)?.grand_total)}}</strong>.<br><br>
            This will mark the order as <strong>Billed</strong>.
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showConvert=false">Cancel</button>
          <button class="nim-btn nim-btn-primary" style="background:#E67700;border-color:#E67700" @click="doConvert">
            Create Bill
          </button>
        </div>
      </div>
    </div>
  </teleport>

  <!-- Delete confirm modal -->
  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left">
            <div class="nim-header-icon"><span v-html="icon('trash',16)"></span></div>
            <div class="nim-header-title">Delete Purchase Order?</div>
          </div>
          <button class="nim-close" @click="showDelete=false" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Delete order <strong>{{deleteTarget}}</strong>? This cannot be undone.
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Keep It</button>
          <button @click="doDelete" :disabled="deleting"
            style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff;display:inline-flex;align-items:center;gap:7px">
            <span v-if="deleting" v-html="icon('refresh',13)" style="animation:spin 1s linear infinite"></span>
            {{deleting ? 'Deleting…' : 'Yes, Delete'}}
          </button>
        </div>
      </div>
    </div>
  </teleport>

</div>`
  });


  const Purchases = defineComponent({
    name: "Purchases",
    components: { PurchaseModal },
    setup() {
      const router = useRouter();
      const list = ref([]), loading = ref(true);
      const activeFilter = ref("all");
      const search = ref("");
      const showNew = ref(false);

      const filters = [
        { k: "all", lbl: "All Bills" },
        { k: "Draft", lbl: "Draft" },
        { k: "Unpaid", lbl: "Unpaid" },
        { k: "Overdue", lbl: "Overdue" },
        { k: "Paid", lbl: "Paid" },
      ];

      function isOverdue(b) {
        return flt(b.outstanding_amount) > 0 && b.due_date && new Date(b.due_date) < new Date();
      }

      const summary = computed(() => {
        const out = list.value.reduce((s, b) => s + flt(b.outstanding_amount), 0);
        const ovr = list.value.filter(isOverdue).reduce((s, b) => s + flt(b.outstanding_amount), 0);
        const now = new Date();
        const mo = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
        const paid = list.value.filter(b => b.status === "Paid" && (b.posting_date || "").startsWith(mo))
          .reduce((s, b) => s + flt(b.grand_total), 0);
        return { total: list.value.length, outstanding: out, overdue: ovr, paid };
      });

      const counts = computed(() => ({
        Draft: list.value.filter(b => b.status === "Draft").length,
        Unpaid: list.value.filter(b => ["Submitted", "Unpaid", "Partly Paid"].includes(b.status)).length,
        Overdue: list.value.filter(isOverdue).length,
        Paid: list.value.filter(b => b.status === "Paid").length,
      }));

      const pillCountCls = (k) => ({
        Draft: "zb-pc-muted", Unpaid: "zb-pc-amber",
        Overdue: "zb-pc-red", Paid: "zb-pc-green"
      })[k] || "zb-pc-muted";

      const filtered = computed(() => {
        let r = list.value;
        if (activeFilter.value === "Draft") r = r.filter(b => b.status === "Draft");
        if (activeFilter.value === "Unpaid") r = r.filter(b => ["Submitted", "Unpaid", "Partly Paid"].includes(b.status) && !isOverdue(b));
        if (activeFilter.value === "Overdue") r = r.filter(isOverdue);
        if (activeFilter.value === "Paid") r = r.filter(b => b.status === "Paid");
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(b => (b.name + (b.supplier || "") + (b.bill_no || "")).toLowerCase().includes(q));
        return r;
      });

      function statusClass(b) {
        if (isOverdue(b)) return "b-badge-red";
        return {
          Paid: "b-badge-green", "Partly Paid": "b-badge-amber",
          Submitted: "b-badge-amber", Unpaid: "b-badge-amber",
          Draft: "b-badge-muted", Cancelled: "b-badge-muted"
        }[b.status] || "b-badge-muted";
      }
      function statusLabel(b) {
        if (isOverdue(b)) return "Overdue";
        return b.status || "Draft";
      }

      async function load() {
        loading.value = true;
        try {
          list.value = await apiList("Purchase Invoice", {
            fields: ["name", "supplier", "bill_no", "posting_date", "due_date", "grand_total", "outstanding_amount", "status", "docstatus"],
            order: "posting_date desc", limit: 300
          });
        } catch (e) { toast("Failed to load bills: " + e.message, "error"); }
        finally { loading.value = false; }
      }

      // Delete/cancel confirm
      const showCancel = ref(false);
      const cancelTarget = ref(null);
      const cancelling = ref(false);

      function confirmCancel(name) { cancelTarget.value = name; showCancel.value = true; }
      function closeCancelModal() { cancelTarget.value = null; showCancel.value = false; }
      async function doCancel() {
        cancelling.value = true;
        try {
          await apiDelete("Purchase Invoice", cancelTarget.value);
          toast("Bill cancelled");
          closeCancelModal();
          await load();
        } catch (e) { toast(e.message || "Could not cancel", "error"); }
        finally { cancelling.value = false; }
      }

      onMounted(load);
      return {
        list, loading, activeFilter, search, filters, counts, summary, filtered,
        pillCountCls, statusClass, statusLabel, isOverdue,
        showNew, showCancel, cancelTarget, cancelling,
        load, confirmCancel, closeCancelModal, doCancel,
        fmt, fmtDate, flt, icon, openDoc
      };
    },
    template: `
<div class="b-page cust-page">
  <PurchaseModal :show="showNew" @close="showNew=false" @saved="load"/>

  <!-- Summary strip -->
  <div class="qt-summary">
    <div class="qt-sum-card">
      <div class="qt-sum-label">Total Bills</div>
      <div class="qt-sum-value">{{summary.total}}</div>
    </div>
    <div class="qt-sum-card">
      <div class="qt-sum-label" style="color:#E67700">Outstanding</div>
      <div class="qt-sum-value" style="color:#E67700;font-size:17px">{{fmt(summary.outstanding)}}</div>
    </div>
    <div class="qt-sum-card">
      <div class="qt-sum-label" style="color:#C92A2A">Overdue</div>
      <div class="qt-sum-value" style="color:#C92A2A;font-size:17px">{{fmt(summary.overdue)}}</div>
    </div>
    <div class="qt-sum-card">
      <div class="qt-sum-label" style="color:#2F9E44">Paid This Month</div>
      <div class="qt-sum-value" style="color:#2F9E44;font-size:17px">{{fmt(summary.paid)}}</div>
    </div>
  </div>

  <!-- Toolbar -->
  <div class="cust-toolbar">
    <div class="cust-toolbar-left">
      <div class="cust-filters">
        <button v-for="f in filters" :key="f.k"
          class="zb-inv-pill" :class="{'zb-inv-pill-active': activeFilter===f.k}"
          @click="activeFilter=f.k">
          {{f.lbl}}
          <span v-if="f.k!=='all'" class="zb-pill-cnt" :class="activeFilter===f.k ? pillCountCls(f.k) : 'zb-pc-muted'">
            {{counts[f.k]}}
          </span>
        </button>
      </div>
    </div>
    <div class="cust-toolbar-right">
      <div class="cust-search">
        <span v-html="icon('search',13)" style="color:#9ca3af;flex-shrink:0"></span>
        <input v-model="search" placeholder="Search bill, vendor..." class="cust-search-input" autocomplete="off"/>
      </div>
      <button class="zb-tb-btn" @click="load" title="Refresh">
        <span v-html="icon('refresh',13)"></span> Refresh
      </button>
      <button class="zb-tb-btn" style="background:#E67700;color:#fff;border-color:#E67700" @click="showNew=true">
        <span v-html="icon('plus',13)"></span> New Bill
      </button>
    </div>
  </div>

  <!-- Table -->
  <div class="b-card cust-table-card">
    <div class="cust-table-wrap">
      <table class="cust-table">
        <thead>
          <tr>
            <th>Bill #</th>
            <th>Vendor Bill No.</th>
            <th>Vendor</th>
            <th>Bill Date</th>
            <th>Due Date</th>
            <th style="text-align:right">Amount</th>
            <th style="text-align:right">Outstanding</th>
            <th>Status</th>
            <th style="text-align:center;width:80px">Actions</th>
          </tr>
        </thead>
        <tbody>
          <!-- Loading shimmer -->
          <template v-if="loading">
            <tr v-for="n in 6" :key="n">
              <td colspan="9" style="padding:12px 14px">
                <div class="b-shimmer" style="height:13px;border-radius:4px;width:70%"></div>
              </td>
            </tr>
          </template>
          <!-- Empty state -->
          <tr v-else-if="!filtered.length">
            <td colspan="9" class="cust-empty">
              <div class="cust-empty-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
              </div>
              <div class="cust-empty-title">{{search ? 'No bills match' : 'No purchase bills yet'}}</div>
              <div class="cust-empty-sub">{{search ? 'Try a different search' : 'Record vendor bills to track payables'}}</div>
              <button v-if="!search" class="nim-btn nim-btn-primary" style="margin-top:12px;background:#E67700;border-color:#E67700" @click="showNew=true">
                <span v-html="icon('plus',13)"></span> New Bill
              </button>
            </td>
          </tr>
          <!-- Data rows -->
          <tr v-else v-for="b in filtered" :key="b.name"
            class="cust-row"
            @click="openDoc('Purchase Invoice', b.name)">
            <td>
              <span style="color:#E67700;font-family:monospace;font-size:12px;font-weight:700">{{b.name}}</span>
            </td>
            <td style="font-family:monospace;font-size:12px;color:#868E96">{{b.bill_no||'—'}}</td>
            <td class="cust-name">{{b.supplier||'—'}}</td>
            <td class="cust-secondary">{{fmtDate(b.posting_date)}}</td>
            <td class="cust-secondary" :style="{color: isOverdue(b) ? '#C92A2A' : '', fontWeight: isOverdue(b) ? '600' : ''}">
              {{fmtDate(b.due_date)}}
            </td>
            <td style="text-align:right;font-family:monospace;font-weight:600">{{fmt(b.grand_total)}}</td>
            <td style="text-align:right;font-family:monospace;font-weight:600"
              :style="{color: flt(b.outstanding_amount)>0 ? '#E67700' : '#2F9E44'}">
              {{fmt(b.outstanding_amount)}}
            </td>
            <td>
              <span class="b-badge" :class="statusClass(b)">{{statusLabel(b)}}</span>
            </td>
            <td @click.stop style="text-align:center">
              <div style="display:flex;gap:4px;justify-content:center">
                <button class="cust-act-btn" style="color:#6b7280;border-color:#e5e7eb"
                  @click="openDoc('Purchase Invoice', b.name)" title="Open in Frappe">
                  <span v-html="icon('ext',13)"></span>
                </button>
                <button v-if="b.status==='Draft'" class="cust-act-btn cust-act-del"
                  @click="confirmCancel(b.name)" title="Cancel">
                  <span v-html="icon('x',13)"></span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!loading && filtered.length" class="cust-row-count">
      Showing {{filtered.length}} of {{list.length}} bills
    </div>
  </div>

  <!-- Cancel confirm modal -->
  <teleport to="body">
    <div v-if="showCancel" class="nim-overlay" @click.self="closeCancelModal">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <div class="nim-header-left">
            <div class="nim-header-icon"><span v-html="icon('x',16)"></span></div>
            <div class="nim-header-title">Cancel Bill?</div>
          </div>
          <button class="nim-close" @click="closeCancelModal" v-html="icon('x',15)"></button>
        </div>
        <div class="nim-body" style="padding:20px 24px">
          <p style="font-size:14px;color:#374151;line-height:1.6">
            Cancel bill <strong>{{cancelTarget}}</strong>? This will delete the draft.
          </p>
        </div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="closeCancelModal">Keep It</button>
          <button @click="doCancel" :disabled="cancelling"
            style="height:37px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#dc2626;color:#fff;display:inline-flex;align-items:center;gap:7px">
            <span v-if="cancelling" v-html="icon('refresh',13)" style="animation:spin 1s linear infinite"></span>
            {{cancelling ? 'Cancelling…' : 'Yes, Cancel'}}
          </button>
        </div>
      </div>
    </div>
  </teleport>
</div>`});

  /* ═══════════════════════════════════════════════════════════════
     DEBIT NOTES (PURCHASE RETURNS)
     localStorage-backed, ported from debit-notes.html
  ═══════════════════════════════════════════════════════════════ */
  const DebitNotes = defineComponent({
    name: "DebitNotes",
    setup() {
      const LKEY = "books_debit_notes";
      const REASONS = [
        { val: "Goods Returned", lbl: "Goods Returned to Vendor" },
        { val: "Overcharged", lbl: "Overcharged by Vendor" },
        { val: "Damaged Goods", lbl: "Damaged / Defective Goods" },
        { val: "Quantity Shortage", lbl: "Quantity Shortage" },
        { val: "Quality Issues", lbl: "Quality Issues" },
        { val: "Duplicate Bill", lbl: "Duplicate Bill" },
        { val: "Post-purchase Discount", lbl: "Post-purchase Discount" },
        { val: "Other", lbl: "Other" }
      ];

      const list = ref([]), vendors = ref([]), allBills = ref([]), allItems = ref([]), loading = ref(true);
      const search = ref(""), activeFilter = ref("all");
      const showDrawer = ref(false), drawerMode = ref("add"), saving = ref(false);
      const viewNote = ref(null), editingName = ref(null);

      // Drawer Form
      const form = reactive({
        name: "", vendor: "", against_bill: "", date: "", reason: "",
        debit_type: "Partial", notes: "", items: [], debit_amount: 0
      });

      const showDelete = ref(false), deleteTarget = ref(null);

      // Helpers
      const store = (d) => { try { localStorage.setItem(LKEY, JSON.stringify(d)); } catch { } };
      const loadLocal = () => { try { return JSON.parse(localStorage.getItem(LKEY) || "[]"); } catch { return []; } };
      const nextNum = () => {
        const n = loadLocal().map(x => parseInt((x.name || "DN-0").replace(/\D/g, "")) || 0);
        return "DN-" + String((n.length ? Math.max(...n) : 0) + 1).padStart(4, "0");
      };

      const summary = computed(() => {
        const issued = list.value.reduce((s, n) => s + flt(n.debit_amount), 0);
        const pending = list.value.filter(n => n.status === "Submitted").reduce((s, n) => s + flt(n.debit_amount), 0);
        const applied = list.value.filter(n => n.status === "Applied").reduce((s, n) => s + flt(n.debit_amount), 0);
        return { total: list.value.length, issued, pending, applied };
      });

      const counts = computed(() => ({
        Draft: list.value.filter(n => n.status === "Draft").length,
        Submitted: list.value.filter(n => n.status === "Submitted").length,
        Applied: list.value.filter(n => n.status === "Applied").length
      }));

      const filtered = computed(() => {
        let r = activeFilter.value === "all" ? list.value : list.value.filter(n => n.status === activeFilter.value);
        const q = search.value.toLowerCase().trim();
        if (q) r = r.filter(n => (n.name + (n.vendor || "") + (n.against_bill || "") + (n.reason || "")).toLowerCase().includes(q));
        return r;
      });

      const selectedBillDetails = computed(() => {
        if (!form.against_bill) return null;
        return allBills.value.find(b => b.name === form.against_bill) || null;
      });

      async function load() {
        loading.value = true;
        list.value = loadLocal();
        try {
          vendors.value = await apiList("Supplier", { fields: ["name", "supplier_name"], filters: [["disabled", "=", 0]], order: "supplier_name asc", limit: 300 });
          allBills.value = await apiList("Purchase Invoice", { fields: ["name", "supplier", "posting_date", "grand_total", "outstanding_amount"], filters: [["docstatus", "=", 1]], order: "posting_date desc", limit: 300 });
          try { allItems.value = await apiList("Item", { fields: ["name", "item_name", "item_code", "standard_rate", "description"], order: "item_name asc", limit: 300 }); } catch { }
        } catch (e) { console.error("Load failed", e); }
        finally { loading.value = false; }
      }

      function openAdd() {
        editingName.value = null;
        Object.assign(form, {
          name: "", vendor: "", against_bill: "", date: new Date().toISOString().slice(0, 10),
          reason: "", debit_type: "Partial", notes: "",
          items: [{ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }],
          debit_amount: 0
        });
        drawerMode.value = "add"; showDrawer.value = true;
      }

      function openView(n) { viewNote.value = n; drawerMode.value = "view"; showDrawer.value = true; }

      function openEdit(n) {
        editingName.value = n.name;
        Object.assign(form, JSON.parse(JSON.stringify(n)));
        drawerMode.value = "edit"; showDrawer.value = true;
      }

      function addRow() { form.items.push({ item_name: "", description: "", qty: 1, rate: 0, amount: 0 }); }
      function removeRow(i) { if (form.items.length > 1) form.items.splice(i, 1); recalc(); }
      function recalc() {
        form.items.forEach(r => { r.amount = flt(flt(r.qty) * flt(r.rate)); });
        form.debit_amount = form.items.reduce((s, r) => s + r.amount, 0);
      }
      function onDnItemPick(row) {
        const match = allItems.value.find(it => it.item_name === row.item_name);
        if (match) {
          if (!row.description) row.description = match.description || match.item_name || "";
          row.rate = flt(match.standard_rate) || row.rate;
          recalc();
        }
      }

      async function saveNote(status) {
        if (!form.vendor) { toast("Select a vendor", "error"); return; }
        if (!form.reason) { toast("Select a reason", "error"); return; }
        const emptyItem = form.items.find(r => !r.item_name || !r.item_name.trim());
        if (emptyItem) { toast("Please select an item for every row in the Items table", "error"); return; }
        if (form.debit_amount <= 0) { toast("Amount must be > 0", "error"); return; }

        saving.value = true;
        const doc = { ...form, name: editingName.value || nextNum(), status, created_at: form.created_at || new Date().toISOString() };
        const idx = list.value.findIndex(n => n.name === doc.name);
        if (idx >= 0) list.value[idx] = doc; else list.value.unshift(doc);
        store(list.value);
        toast(status === "Draft" ? "Saved as draft" : "Debit note issued");
        showDrawer.value = false;
        saving.value = false;
        await load();
      }

      function confirmDelete(n) { deleteTarget.value = n; showDelete.value = true; }
      function doDelete() {
        list.value = list.value.filter(n => n.name !== deleteTarget.value.name);
        store(list.value);
        toast("Deleted");
        showDelete.value = false;
        load();
      }

      function applyDebit() {
        const n = list.value.find(x => x.name === viewNote.value.name);
        if (n) { n.status = "Applied"; store(list.value); toast("Applied"); showDrawer.value = false; load(); }
      }

      onMounted(load);
      return {
        list, vendors, allBills, allItems, loading, search, activeFilter, summary, counts, filtered, selectedBillDetails,
        showDrawer, drawerMode, form, saving, viewNote, REASONS,
        openAdd, openView, openEdit, addRow, removeRow, recalc, onDnItemPick, saveNote,
        showDelete, deleteTarget, confirmDelete, doDelete, applyDebit,
        fmt, fmtDate, flt, icon
      };
    },
    template: `
<div class="b-page">
  <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:10px;font-size:13.3px;color:#1e40af">
    <span style="font-size:18px">ℹ️</span>
    <span>A <b>Debit Note</b> reduces an outstanding purchase bill — use it when you return goods to a vendor or were overcharged. It debits your Accounts Payable.</span>
  </div>

  <div class="dn-sum-strip">
    <div class="dn-sum-card"><div class="dn-sum-lbl">Total Notes</div><div class="dn-sum-val">{{summary.total}}</div></div>
    <div class="dn-sum-card"><div class="dn-sum-lbl" style="color:#2563eb">Total Debit Raised</div><div class="dn-sum-val" style="color:#2563eb">{{fmt(summary.issued)}}</div></div>
    <div class="dn-sum-card"><div class="dn-sum-lbl" style="color:#d97706">Pending Application</div><div class="dn-sum-val" style="color:#d97706">{{fmt(summary.pending)}}</div></div>
    <div class="dn-sum-card"><div class="dn-sum-lbl" style="color:#16a34a">Applied to Bills</div><div class="dn-sum-val" style="color:#16a34a">{{fmt(summary.applied)}}</div></div>
  </div>

  <div class="cust-toolbar">
    <div class="cust-toolbar-left">
      <div class="cust-filters">
        <button class="dn-pill" :class="{active:activeFilter==='all'}" @click="activeFilter='all'">All</button>
        <button class="dn-pill" :class="{active:activeFilter==='Draft'}" @click="activeFilter='Draft'">Draft <span class="dn-pc" style="background:#f1f3f5;color:#868e96">{{counts.Draft}}</span></button>
        <button class="dn-pill" :class="{active:activeFilter==='Submitted'}" @click="activeFilter='Submitted'">Submitted <span class="dn-pc" style="background:#eef2ff;color:#3b5bdb">{{counts.Submitted}}</span></button>
        <button class="dn-pill" :class="{active:activeFilter==='Applied'}" @click="activeFilter='Applied'">Applied <span class="dn-pc" style="background:#ebfbee;color:#2f9e44">{{counts.Applied}}</span></button>
      </div>
    </div>
    <div class="cust-toolbar-right">
      <div class="cust-search"><span v-html="icon('search',13)"></span><input v-model="search" placeholder="Search note, vendor, bill..."/></div>
      <button class="b-btn b-btn-primary" style="background:#e67700" @click="openAdd"><span v-html="icon('plus',13)"></span> New Debit Note</button>
    </div>
  </div>

  <div class="b-card" style="overflow:hidden">
    <table class="dn-tbl">
      <thead><tr>
        <th>Debit Note #</th><th>Vendor</th><th>Date</th><th>Against Bill</th>
        <th>Reason</th><th class="ta-r">Debit Amount</th><th>Status</th>
        <th class="ta-c" style="width:100px">Actions</th>
      </tr></thead>
      <tbody>
        <tr v-if="loading"><td colspan="8" class="ta-c"><div class="b-shimmer" style="height:15px"></div></td></tr>
        <tr v-else v-for="n in filtered" :key="n.name" class="cust-row" @click="openView(n)">
          <td class="fw-700" style="color:#e67700">{{n.name}}</td>
          <td class="fw-600">{{n.vendor}}</td>
          <td class="c-muted">{{fmtDate(n.date)}}</td>
          <td><span v-if="n.against_bill" class="b-badge b-badge-amber">{{n.against_bill}}</span></td>
          <td class="c-muted">{{n.reason}}</td>
          <td class="ta-r fw-700" style="color:#e67700">{{fmt(n.debit_amount)}}</td>
          <td><span class="b-badge" :class="n.status==='Applied'?'b-badge-green':n.status==='Submitted'?'b-badge-blue':'b-badge-muted'">{{n.status}}</span></td>
          <td class="ta-c" @click.stop>
            <button v-if="n.status==='Draft'" class="cust-act-btn cust-act-edit" @click="openEdit(n)" v-html="icon('edit',13)"></button>
            <button v-if="n.status==='Draft'" class="cust-act-btn cust-act-del" @click="confirmDelete(n)" v-html="icon('trash',13)"></button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <teleport to="body">
    <transition name="nim-fade">
      <div v-if="showDrawer" class="nim-overlay" @click.self="showDrawer=false">
        <transition name="nim-slide">
          <div class="nim-drawer" style="width:680px">
            <div class="dn-dh">
              <div><div class="dn-dh-title">{{drawerMode==='add'?'New Debit Note':drawerMode==='edit'?'Edit Debit Note':'Debit Note Details'}}</div><div class="dn-dh-sub" v-if="form.name">{{form.name}}</div></div>
              <button class="nim-close" @click="showDrawer=false" style="color:#fff" v-html="icon('x',16)"></button>
            </div>
            <div class="nim-body" style="background-color: #f5f5f5;">
              <template v-if="drawerMode==='view'">
                <div class="dn-sec-lbl" >Debit Note Information</div>
                <div class="dn-fg dn-fg2">
                   <div><div class="c-muted" style="font-size:11px">Vendor</div><div class="fw-700">{{viewNote.vendor}}</div></div>
                   <div><div class="c-muted" style="font-size:11px">Date</div><div class="fw-700">{{fmtDate(viewNote.date)}}</div></div>
                   <div><div class="c-muted" style="font-size:11px">Against Bill</div><div class="fw-700 c-amber">{{viewNote.against_bill || '—'}}</div></div>
                   <div><div class="c-muted" style="font-size:11px">Reason</div><div class="fw-700">{{viewNote.reason}}</div></div>
                </div>
                <div class="dn-sec-lbl">Returned Items</div>
                <table class="dn-itbl">
                  <thead><tr><th>Item</th><th class="ta-c">Qty</th><th class="ta-r">Rate</th><th class="ta-r">Amount</th></tr></thead>
                  <tbody><tr v-for="it in viewNote.items"><td>{{it.item_name}}</td><td class="ta-c">{{it.qty}}</td><td class="ta-r">{{fmt(it.rate)}}</td><td class="ta-r fw-700">{{fmt(it.amount)}}</td></tr></tbody>
                </table>
                <div style="display:flex;justify-content:flex-end;margin-top:16px">
                  <div class="dn-totals" style="min-width:240px">
                    <div class="dn-t-row"><span>Total Amount</span><span class="fw-700">{{fmt(viewNote.debit_amount)}}</span></div>
                  </div>
                </div>
              </template>
              <template v-else>
                <span class="dn-sec-lbl">Debit Note Details</span>
                <div class="dn-fg dn-fg3">
                  <div><label class="fl">Vendor <span class="req">*</span></label>
                    <searchable-select v-model="form.vendor" :options="vendors" value-key="name" label-key="supplier_name" placeholder="— Vendor —"/>
                  </div>
                  <div><label class="fl">Against Bill</label>
                    <select v-model="form.against_bill" class="dn-fi">
                      <option value="">— Select Bill —</option>
                      <option v-for="b in allBills.filter(x=>x.supplier===form.vendor)" :key="b.name" :value="b.name">{{b.name}} ({{fmt(b.grand_total)}})</option>
                    </select>
                  </div>
                  <div><label class="fl">Debit Note Date <span class="req">*</span></label><input type="date" v-model="form.date" class="dn-fi"/></div>
                </div>

                <div v-if="selectedBillDetails" class="dn-bill-info">
                  <div style="font-size:11.5px;font-weight:700;color:#2563eb;text-transform:uppercase;margin-bottom:8px">Original Bill Details</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                    <div><div style="font-size:11px;color:#868e96">Date</div><div style="font-size:13px;font-weight:600">{{fmtDate(selectedBillDetails.posting_date)}}</div></div>
                    <div><div style="font-size:11px;color:#868e96">Grand Total</div><div style="font-size:13px;font-weight:600">{{fmt(selectedBillDetails.grand_total)}}</div></div>
                    <div><div style="font-size:11px;color:#868e96">Outstanding</div><div style="font-size:13px;font-weight:600">{{fmt(selectedBillDetails.outstanding_amount)}}</div></div>
                  </div>
                </div>

                <div class="dn-fg dn-fg2">
                  <div><label class="fl">Reason <span class="req">*</span></label>
                    <select v-model="form.reason" class="dn-fi"><option value="">— Select reason —</option><option v-for="r in REASONS" :value="r.val">{{r.lbl}}</option></select>
                  </div>
                  <div><label class="fl">Debit Type</label>
                    <select v-model="form.debit_type" class="dn-fi"><option value="Full">Full Reversal</option><option value="Partial">Partial Debit</option></select>
                  </div>
                </div>
                <div class="dn-fg" style="grid-template-columns:1fr"><label class="fl">Notes</label><textarea v-model="form.notes" class="dn-fi" rows="2" placeholder="Details about return..."></textarea></div>

                <span class="dn-sec-lbl">Items Being Returned / Debited</span>
                <div style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:16px">
                  <table class="dn-itbl">
                    <thead><tr><th style="width:30%">Item</th><th>Description</th><th style="width:80px;text-align:center">Qty</th><th style="width:120px;text-align:right">Rate</th><th style="width:120px;text-align:right">Amount</th><th style="width:40px"></th></tr></thead>
                    <tbody>
                      <tr v-for="(it,i) in form.items" :key="i">
                        <td>
                          <select v-model="it.item_name" class="dn-ci dn-sel" @change="onDnItemPick(it)">
                            <option value="" disabled selected>— Select Item —</option>
                            <option v-for="dnit in allItems" :key="dnit.name" :value="dnit.item_name">{{dnit.item_name}}</option>
                          </select>
                        </td>
                        <td><input v-model="it.description" class="dn-ci" placeholder="Desc..."/></td>
                        <td><input v-model.number="it.qty" type="number" class="dn-ci ta-c" @input="recalc"/></td>
                        <td><input v-model.number="it.rate" type="number" class="dn-ci ta-r" @input="recalc"/></td>
                        <td class="ta-r fw-600" style="padding:0 10px">{{fmt(it.amount)}}</td>
                        <td class="ta-c"><button v-if="form.items.length>1" @click="removeRow(i)" style="color:#f87171;border:none;background:none;cursor:pointer" v-html="icon('trash',13)"></button></td>
                      </tr>
                    </tbody>
                  </table>
                  <div style="padding:8px 12px;background:#f8f9fc;border-top:1px solid #e8ecf0">
                    <button @click="addRow" style="background:none;border:none;cursor:pointer;color:#2563eb;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:5px">+ Add Row</button>
                  </div>
                </div>

                <div style="display:flex;justify-content:flex-end">
                  <div class="dn-totals" style="min-width:280px">
                    <div class="dn-t-row"><span style="color:#868e96">Subtotal</span><span class="mono">{{fmt(form.debit_amount)}}</span></div>
                    <div class="dn-t-row"><span>Debit Amount</span><span class="mono">{{fmt(form.debit_amount)}}</span></div>
                  </div>
                </div>
              </template>
            </div>
            <div class="nim-footer">
              <button class="nim-btn nim-btn-ghost" @click="showDrawer=false">{{drawerMode==='view'?'Close':'Cancel'}}</button>
              <div v-if="drawerMode==='view'" style="display:flex;gap:8px">
                <button v-if="viewNote.status==='Submitted'" class="b-btn" style="background:#16a34a;color:#fff" @click="applyDebit">Mark as Applied</button>
                <button class="b-btn b-btn-ghost" @click="openEdit(viewNote)">Edit</button>
              </div>
              <div v-else style="display:flex;gap:8px">
                <button class="b-btn b-btn-ghost" @click="saveNote('Draft')" :disabled="saving" style="color:#2563eb;border-color:#2563eb">Save as Draft</button>
                <button class="b-btn b-btn-primary" style="background:#2563eb" @click="saveNote('Submitted')" :disabled="saving">Issue Debit Note</button>
              </div>
            </div>
          </div>
        </transition>
      </div>
    </transition>
  </teleport>

  <teleport to="body">
    <div v-if="showDelete" class="nim-overlay" @click.self="showDelete=false">
      <div class="nim-dialog" style="max-width:420px">
        <div class="nim-header" style="background:#dc2626"><div class="nim-header-title">Delete Debit Note?</div></div>
        <div class="nim-body" style="padding:24px">Are you sure you want to delete <b>{{deleteTarget.name}}</b>?</div>
        <div class="nim-footer">
          <button class="nim-btn nim-btn-ghost" @click="showDelete=false">Cancel</button>
          <button class="b-btn" style="background:#dc2626;color:#fff" @click="doDelete">Yes, Delete</button>
        </div>
      </div>
    </div>
  </teleport>
</div>`
  });


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

  /* ══════════════════════════════════════════════════
     BANKING MODULE — shared constants
  ══════════════════════════════════════════════════ */
  const BANK_TYPE_META = {
    Current:  { icon: "🏢", color: "#3B5BDB", bg: "#EEF2FF", label: "Current Account" },
    Savings:  { icon: "💰", color: "#2F9E44", bg: "#EBFBEE", label: "Savings Account" },
    Cash:     { icon: "💵", color: "#E67700", bg: "#FFF3BF", label: "Cash / Petty Cash" },
    Overdraft:{ icon: "📋", color: "#C92A2A", bg: "#FFE3E3", label: "Overdraft" },
    CC:       { icon: "💳", color: "#7048E8", bg: "#F3F0FF", label: "Credit Card" },
    Fixed:    { icon: "🔒", color: "#0C8599", bg: "#E0F7FA", label: "Fixed Deposit" },
    Wallet:   { icon: "📱", color: "#D4537E", bg: "#FBEAF0", label: "Digital Wallet" },
  };
  const BANK_COLORS = {
    "HDFC Bank":"#004C8F","ICICI Bank":"#F36523","State Bank of India":"#2E8B57",
    "Axis Bank":"#800020","Kotak Mahindra Bank":"#E31E24","Punjab National Bank":"#003366",
    "Bank of Baroda":"#F77F00","Canara Bank":"#0047AB","IndusInd Bank":"#7B3F00",
    "Yes Bank":"#003087","IDFC First Bank":"#00457C","Federal Bank":"#E31837","Other":"#868E96"
  };
  const TXN_CATEGORIES = [
    { id:"salary",     label:"Salary",           icon:"💴", color:"#3B5BDB", bg:"#EEF2FF" },
    { id:"rent",       label:"Rent",              icon:"🏠", color:"#0C8599", bg:"#E0F7FA" },
    { id:"utilities",  label:"Utilities",         icon:"⚡", color:"#E67700", bg:"#FFF3BF" },
    { id:"vendor",     label:"Vendor Payment",    icon:"📦", color:"#C92A2A", bg:"#FFE3E3" },
    { id:"customer",   label:"Customer Receipt",  icon:"💳", color:"#2F9E44", bg:"#EBFBEE" },
    { id:"tax",        label:"Tax / GST",         icon:"📋", color:"#7048E8", bg:"#F3F0FF" },
    { id:"bank-charge",label:"Bank Charges",      icon:"🏛", color:"#495057", bg:"#F1F3F5" },
    { id:"software",   label:"Software",          icon:"💻", color:"#3B5BDB", bg:"#EEF2FF" },
    { id:"travel",     label:"Travel",            icon:"✈", color:"#D4537E", bg:"#FBEAF0" },
    { id:"transfer",   label:"Internal Transfer", icon:"⇄", color:"#1098AD", bg:"#E3FAFC" },
    { id:"interest",   label:"Interest",          icon:"📈", color:"#2F9E44", bg:"#EBFBEE" },
    { id:"other",      label:"Other",             icon:"💵", color:"#868E96", bg:"#F1F3F5" },
  ];
  const CAT_MAP_BANK = Object.fromEntries(TXN_CATEGORIES.map(c => [c.id, c]));
  const DEFAULT_BANK_ACCOUNTS = [
    { name:"HDFC Current Account", type:"Current", bank:"HDFC Bank", acct_no:"50100XXXXXXXX", ifsc:"HDFC0000001", branch:"Koramangala", holder:"My Company", currency:"INR", opening:500000, balance:1234567.50, od_limit:0, gl_account:"", is_default:1, status:"Active", rm:"Rajesh Kumar", rm_phone:"+91 98765 43210", reconcile_pct:95, source:"local" },
    { name:"ICICI Savings Account", type:"Savings", bank:"ICICI Bank", acct_no:"002XXXXXXXXX", ifsc:"ICIC0000002", branch:"MG Road", holder:"My Company", currency:"INR", opening:200000, balance:456789.00, od_limit:0, gl_account:"", is_default:0, status:"Active", rm:"Priya Sharma", rm_phone:"+91 87654 32109", reconcile_pct:88, source:"local" },
    { name:"Petty Cash", type:"Cash", bank:"", acct_no:"", ifsc:"", branch:"", holder:"", currency:"INR", opening:50000, balance:23450.00, od_limit:0, gl_account:"", is_default:0, status:"Active", rm:"", rm_phone:"", reconcile_pct:100, source:"local" },
  ];
  const DEFAULT_BANK_TXNS = [
    { id:"TXN-0001", date: new Date().toISOString().slice(0,10), account:"HDFC Current Account", description:"NEFT CR - INVOICE INV-2026-0142", type:"Credit", amount:125000, balance:1234567.50, category:"customer", reconciled:true, notes:"" },
    { id:"TXN-0002", date: new Date(Date.now()-86400000).toISOString().slice(0,10), account:"HDFC Current Account", description:"SALARY PAYROLL MARCH 2026", type:"Debit", amount:320000, balance:1109567.50, category:"salary", reconciled:true, notes:"" },
    { id:"TXN-0003", date: new Date(Date.now()-2*86400000).toISOString().slice(0,10), account:"ICICI Savings Account", description:"AWS INVOICE MAR 2026", type:"Debit", amount:18670, balance:456789.00, category:"software", reconciled:false, notes:"" },
    { id:"TXN-0004", date: new Date(Date.now()-3*86400000).toISOString().slice(0,10), account:"HDFC Current Account", description:"RENT - BRIGADE PROPERTIES", type:"Debit", amount:50000, balance:1059567.50, category:"rent", reconciled:true, notes:"" },
    { id:"TXN-0005", date: new Date(Date.now()-4*86400000).toISOString().slice(0,10), account:"HDFC Current Account", description:"GST PAYMENT MARCH", type:"Debit", amount:45000, balance:1014567.50, category:"tax", reconciled:false, notes:"" },
    { id:"TXN-0006", date: new Date(Date.now()-5*86400000).toISOString().slice(0,10), account:"Petty Cash", description:"OFFICE SUPPLIES", type:"Debit", amount:2340, balance:23450.00, category:"other", reconciled:true, notes:"" },
  ];
  function fmtINR(v) { const n = Math.abs(Number(v || 0)); return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2 }); }
  function fmtINRc(v) { const n = Number(v || 0); if (Math.abs(n) >= 10000000) return "₹" + (n / 10000000).toFixed(2) + "Cr"; if (Math.abs(n) >= 100000) return "₹" + (n / 100000).toFixed(1) + "L"; if (Math.abs(n) >= 1000) return "₹" + (n / 1000).toFixed(1) + "K"; return "₹" + Math.abs(n).toFixed(0); }
  function maskAcct(n) { if (!n || n.length < 4) return n || "—"; return "••••" + n.slice(-4); }

  /* ══════════════════════════════════════════════════
     BANK ACCOUNTS
  ══════════════════════════════════════════════════ */
  const BankAccounts = defineComponent({
    name: "BankAccounts",
    setup() {
      const allAccounts = ref([]);
      const loading = ref(true);
      const drawerOpen = ref(false);
      const drawerMode = ref("add");
      const editingName = ref(null);
      const showDel = ref(false);
      const deleteTarget = ref(null);
      const glAccounts = ref([]);
      const form = reactive({ name:"", type:"Current", bank:"", acct_no:"", ifsc:"", branch:"", holder:"", micr:"", currency:"INR", opening:0, balance:0, od_limit:0, gl_account:"", cost_center:"", rm:"", rm_phone:"", website:"", cif:"", status:"Active", is_default:0 });

      const heroStats = computed(() => {
        const active = allAccounts.value.filter(a => a.status === "Active");
        const total = active.reduce((s, a) => s + flt(a.balance), 0);
        const pos = active.filter(a => flt(a.balance) > 0).reduce((s, a) => s + flt(a.balance), 0);
        const neg = active.filter(a => flt(a.balance) < 0).reduce((s, a) => s + flt(a.balance), 0);
        return { total, pos, neg, count: allAccounts.value.length, active: active.length };
      });

      const showBankFields = computed(() => !["Cash","Wallet"].includes(form.type));
      const showOD = computed(() => form.type === "Overdraft");

      async function load() {
        loading.value = true;
        let ok = false;
        try {
          const r = await apiGET("frappe.client.get_list", { doctype:"Bank Account", fields:JSON.stringify(["name","account_name","bank","bank_account_no","branch_code","account","currency","is_default","disabled"]), order_by:"creation desc", limit_page_length:50 });
          if (r && r.length) {
            allAccounts.value = r.map(a => ({ name:a.name, type:"Current", bank:a.bank||"", acct_no:a.bank_account_no||"", ifsc:a.branch_code||"", branch:"", holder:"", currency:a.currency||"INR", opening:0, balance:0, od_limit:0, gl_account:a.account||"", is_default:a.is_default?1:0, status:a.disabled?"Inactive":"Active", rm:"", rm_phone:"", reconcile_pct:0, source:"frappe" }));
            ok = true;
          }
        } catch {}
        if (!ok) {
          const saved = JSON.parse(localStorage.getItem("books_bank_accounts") || "[]");
          allAccounts.value = saved.length ? saved : DEFAULT_BANK_ACCOUNTS;
          if (!saved.length) localStorage.setItem("books_bank_accounts", JSON.stringify(allAccounts.value));
        }
        try {
          const gl = await apiGET("frappe.client.get_list", { doctype:"Account", fields:JSON.stringify(["name"]), filters:JSON.stringify([["account_type","in",["Bank","Cash"]],["is_group","=",0]]), limit_page_length:100 });
          glAccounts.value = (gl || []).map(a => a.name);
        } catch {
          const coa = JSON.parse(localStorage.getItem("books_coa") || "[]");
          glAccounts.value = coa.filter(a => !a.is_group && ["Bank","Cash"].includes(a.account_type)).map(a => a.account_name || a.name);
        }
        loading.value = false;
      }

      function openAdd() {
        drawerMode.value = "add"; editingName.value = null;
        Object.assign(form, { name:"", type:"Current", bank:"", acct_no:"", ifsc:"", branch:"", holder:"", micr:"", currency:"INR", opening:0, balance:0, od_limit:0, gl_account:"", cost_center:"", rm:"", rm_phone:"", website:"", cif:"", status:"Active", is_default:0 });
        drawerOpen.value = true;
      }
      function openEdit(a) {
        drawerMode.value = "edit"; editingName.value = a.name;
        Object.assign(form, { name:a.name, type:a.type||"Current", bank:a.bank||"", acct_no:a.acct_no||"", ifsc:a.ifsc||"", branch:a.branch||"", holder:a.holder||"", micr:a.micr||"", currency:a.currency||"INR", opening:flt(a.opening), balance:flt(a.balance), od_limit:flt(a.od_limit), gl_account:a.gl_account||"", cost_center:a.cost_center||"", rm:a.rm||"", rm_phone:a.rm_phone||"", website:a.website||"", cif:a.cif||"", status:a.status||"Active", is_default:a.is_default||0 });
        drawerOpen.value = true;
      }
      async function saveAccount() {
        if (!form.name.trim()) { toast("Account name is required", "error"); return; }
        if (form.is_default) allAccounts.value.forEach(a => { a.is_default = 0; });
        const doc = { ...form, source: "local" };
        try {
          const fdoc = { doctype:"Bank Account", account_name:form.name, bank:form.bank, bank_account_no:form.acct_no, branch_code:form.ifsc, account:form.gl_account, currency:form.currency, is_default:form.is_default };
          if (drawerMode.value === "edit") { fdoc.name = editingName.value; await apiPOST("frappe.client.save", { doc: JSON.stringify(fdoc) }); }
          else await apiPOST("frappe.client.insert", { doc: JSON.stringify(fdoc) });
          doc.source = "frappe"; toast(drawerMode.value === "edit" ? "Updated in Frappe" : "Created in Frappe");
        } catch { toast(drawerMode.value === "edit" ? "Saved locally" : "Added locally", "info"); }
        const idx = allAccounts.value.findIndex(a => a.name === (editingName.value || form.name));
        if (idx >= 0) allAccounts.value[idx] = doc; else allAccounts.value.unshift(doc);
        localStorage.setItem("books_bank_accounts", JSON.stringify(allAccounts.value.filter(a => a.source !== "frappe")));
        drawerOpen.value = false;
      }
      function confirmDel(a) { deleteTarget.value = a; showDel.value = true; }
      async function doDelete() {
        const name = deleteTarget.value?.name;
        try { await apiPOST("frappe.client.delete", { doctype:"Bank Account", name }); } catch {}
        allAccounts.value = allAccounts.value.filter(a => a.name !== name);
        localStorage.setItem("books_bank_accounts", JSON.stringify(allAccounts.value.filter(a => a.source !== "frappe")));
        toast("Account removed"); showDel.value = false; deleteTarget.value = null;
      }
      const recentTxns = computed(() => (JSON.parse(localStorage.getItem("books_bank_txns") || "[]")).slice(0, 6));

      onMounted(load);
      return { allAccounts, loading, drawerOpen, drawerMode, form, showBankFields, showOD, glAccounts, heroStats, recentTxns, openAdd, openEdit, saveAccount, showDel, deleteTarget, confirmDel, doDelete, fmtINR, fmtINRc, fmtDate, maskAcct, icon, flt, BANK_TYPE_META, BANK_COLORS, CAT_MAP_BANK };
    },
    template: `
<div class="b-page">
  <!-- Hero -->
  <div class="bk-hero">
    <div>
      <div class="bk-hero-lbl">Total Bank Balance</div>
      <div class="bk-hero-val">{{fmtINR(heroStats.total)}}</div>
      <div class="bk-hero-sub">Across {{heroStats.active}} active account{{heroStats.active!==1?'s':''}}</div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div class="bk-hero-chip"><div class="bk-hc-lbl">Cash &amp; Bank</div><div class="bk-hc-val">{{fmtINRc(heroStats.pos)}}</div></div>
      <div class="bk-hero-chip"><div class="bk-hc-lbl">Credit / OD</div><div class="bk-hc-val" style="color:#FF8FAB">{{fmtINRc(Math.abs(heroStats.neg))}}</div></div>
      <div class="bk-hero-chip"><div class="bk-hc-lbl">Accounts</div><div class="bk-hc-val">{{heroStats.count}}</div></div>
    </div>
  </div>
  <!-- Account grid -->
  <div class="bk-acct-grid">
    <template v-if="loading"><div v-for="n in 3" :key="n" class="b-shimmer" style="height:180px;border-radius:10px"></div></template>
    <template v-else>
      <div v-for="a in [...allAccounts].sort((x,y)=>y.is_default-x.is_default)" :key="a.name"
        class="bk-acct-card" :class="{inactive:a.status!=='Active'}" @click="openEdit(a)">
        <div class="bk-acct-hdr">
          <div style="display:flex;align-items:center;gap:10px;flex:1">
            <div class="bk-acct-icon" :style="{background:(BANK_TYPE_META[a.type]||BANK_TYPE_META.Current).bg,color:(BANK_TYPE_META[a.type]||BANK_TYPE_META.Current).color}">
              {{(BANK_TYPE_META[a.type]||BANK_TYPE_META.Current).icon}}
            </div>
            <div>
              <div class="bk-acct-name">{{a.name}}</div>
              <div class="bk-acct-bank">{{a.bank||'—'}}</div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span v-if="a.is_default" class="b-badge b-badge-green" style="font-size:10px">Default</span>
            <span v-if="a.status!=='Active'" class="b-badge b-badge-muted" style="font-size:10px">{{a.status}}</span>
            <div style="display:flex;gap:4px;margin-top:2px">
              <button class="b-btn b-btn-ghost" style="padding:4px 7px;font-size:11px" @click.stop="openEdit(a)"><span v-html="icon('edit',12)"></span></button>
              <button v-if="a.source!=='frappe'" class="b-btn b-btn-ghost" style="padding:4px 7px;font-size:11px;border-color:rgba(201,42,42,.3);color:#C92A2A" @click.stop="confirmDel(a)"><span v-html="icon('trash',12)"></span></button>
            </div>
          </div>
        </div>
        <div style="padding:0 18px 14px">
          <div class="bk-acct-bal" :style="{color:flt(a.balance)<0?'#C92A2A':'#1A1D23'}">
            {{flt(a.balance)<0?'−':'+'}}{{fmtINR(a.balance)}}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <span v-if="a.acct_no" style="font-size:11.5px;color:#868E96">🔢 {{maskAcct(a.acct_no)}}</span>
            <span v-if="a.ifsc" style="font-size:11.5px;color:#868E96">📍 {{a.ifsc}}</span>
            <span class="b-badge" :style="{background:(BANK_TYPE_META[a.type]||BANK_TYPE_META.Current).bg,color:(BANK_TYPE_META[a.type]||BANK_TYPE_META.Current).color,fontSize:'10.5px'}">
              {{(BANK_TYPE_META[a.type]||BANK_TYPE_META.Current).label}}
            </span>
          </div>
          <div v-if="a.reconcile_pct>0">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#868E96;margin-bottom:3px">
              <span>Reconciliation</span>
              <span style="font-weight:600" :style="{color:a.reconcile_pct>=90?'#2F9E44':a.reconcile_pct>=70?'#E67700':'#C92A2A'}">{{a.reconcile_pct}}%</span>
            </div>
            <div style="height:4px;border-radius:2px;background:#E8ECF0;overflow:hidden">
              <div style="height:100%;border-radius:2px;transition:width .3s" :style="{width:a.reconcile_pct+'%',background:a.reconcile_pct>=90?'#2F9E44':a.reconcile_pct>=70?'#E67700':'#C92A2A'}"></div>
            </div>
          </div>
        </div>
        <div class="bk-acct-footer">
          <div><div style="font-size:11px;color:#868E96">Opening</div><div style="font-size:12.5px;font-weight:600;font-family:var(--mono)">{{fmtINR(a.opening)}}</div></div>
          <div style="text-align:right"><div style="font-size:11px;color:#868E96">{{a.od_limit?'OD Limit':'Currency'}}</div><div style="font-size:12.5px;font-weight:600;font-family:var(--mono)">{{a.od_limit?fmtINR(a.od_limit):a.currency||'INR'}}</div></div>
        </div>
      </div>
      <!-- Add card -->
      <div class="bk-add-card" @click="openAdd">
        <div style="font-size:32px;margin-bottom:8px;color:#CDD5E0"><span v-html="icon('plus',28)"></span></div>
        <div style="font-size:13px;font-weight:600;color:#868E96">Add Bank Account</div>
        <div style="font-size:12px;color:#ADB5BD;margin-top:2px">Current, Savings, Cash, CC</div>
      </div>
    </template>
  </div>
  <!-- Recent transactions -->
  <div class="b-card" style="padding:0;overflow:hidden">
    <div class="b-card-head">
      <span class="b-card-title">Recent Transactions — All Accounts</span>
      <router-link to="/banking/transactions" style="font-size:12px;color:#3B5BDB;text-decoration:none;font-weight:600">View All →</router-link>
    </div>
    <table class="b-table">
      <thead><tr><th>Date</th><th>Account</th><th>Description</th><th>Type</th><th class="ta-r">Amount</th><th>Status</th></tr></thead>
      <tbody>
        <tr v-if="!recentTxns.length"><td colspan="6" class="b-empty">No transactions yet — import a bank statement</td></tr>
        <tr v-for="t in recentTxns" :key="t.id">
          <td class="c-muted" style="font-size:12.5px">{{fmtDate(t.date)}}</td>
          <td style="font-size:12.5px">{{t.account}}</td>
          <td style="font-size:13px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{t.description}}</td>
          <td><span class="b-badge" :class="t.type==='Credit'?'b-badge-green':'b-badge-red'">{{t.type}}</span></td>
          <td class="ta-r mono fw-600" :class="t.type==='Credit'?'c-green':'c-red'" style="font-size:12.5px">{{t.type==='Credit'?'+':'-'}}{{fmtINR(t.amount)}}</td>
          <td><span class="b-badge" :class="t.reconciled?'b-badge-green':'b-badge-amber'">{{t.reconciled?'Reconciled':'Pending'}}</span></td>
        </tr>
      </tbody>
    </table>
  </div>
  <!-- Add/Edit Drawer -->
  <teleport to="body">
    <div v-if="drawerOpen" class="bk-drawer-bg" @click.self="drawerOpen=false">
      <div class="bk-drawer-panel">
        <div class="bk-dh">
          <div class="bk-dh-left">
            <div class="bk-dh-icon"><span v-html="icon('bank',18)"></span></div>
            <div>
              <h3>{{drawerMode==='add'?'Add Bank Account':'Edit Account'}}</h3>
              <div class="bk-dh-sub">{{drawerMode==='edit'?editingName:'Fill in account details'}}</div>
            </div>
          </div>
          <button class="bk-d-close" @click="drawerOpen=false"><span v-html="icon('x',16)"></span></button>
        </div>
        <div class="bk-d-body">
          <div class="bk-sec-lbl">Account Identity</div>
          <div class="bk-fg">
            <div><label class="bk-fl">Account Nickname <span style="color:#C92A2A">*</span></label><input class="bk-fi" v-model="form.name" placeholder="e.g. HDFC Current, Petty Cash"/></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div><label class="bk-fl">Account Type</label>
                <select class="bk-fi" v-model="form.type">
                  <option v-for="[k,v] in Object.entries(BANK_TYPE_META)" :key="k" :value="k">{{v.label}}</option>
                </select>
              </div>
              <div><label class="bk-fl">Currency</label>
                <select class="bk-fi" v-model="form.currency">
                  <option value="INR">₹ INR</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option><option value="GBP">£ GBP</option>
                </select>
              </div>
            </div>
          </div>
          <template v-if="showBankFields">
            <div class="bk-sec-lbl">Bank Details</div>
            <div class="bk-fg">
              <div><label class="bk-fl">Bank Name</label>
                <select class="bk-fi" v-model="form.bank">
                  <option value="">— Select bank —</option>
                  <option v-for="[k] in Object.entries(BANK_COLORS)" :key="k" :value="k">{{k}}</option>
                </select>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
                <div><label class="bk-fl">Account Number</label><input class="bk-fi" v-model="form.acct_no" placeholder="XXXXXXXXXXXX" style="font-family:var(--mono)"/></div>
                <div><label class="bk-fl">IFSC Code</label><input class="bk-fi" v-model="form.ifsc" placeholder="HDFC0000001" style="font-family:var(--mono)" @input="form.ifsc=form.ifsc.toUpperCase()"/></div>
                <div><label class="bk-fl">Branch</label><input class="bk-fi" v-model="form.branch" placeholder="Koramangala"/></div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div><label class="bk-fl">Account Holder</label><input class="bk-fi" v-model="form.holder" placeholder="Company name"/></div>
                <div><label class="bk-fl">MICR Code</label><input class="bk-fi" v-model="form.micr" placeholder="9 digit MICR" style="font-family:var(--mono)"/></div>
              </div>
            </div>
          </template>
          <div class="bk-sec-lbl">Accounting Link</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label class="bk-fl">GL Account</label>
              <select class="bk-fi" v-model="form.gl_account">
                <option value="">— Select GL account —</option>
                <option v-for="g in glAccounts" :key="g" :value="g">{{g}}</option>
              </select>
            </div>
            <div><label class="bk-fl">Status</label>
              <select class="bk-fi" v-model="form.status">
                <option>Active</option><option>Inactive</option><option>Dormant</option><option>Closed</option>
              </select>
            </div>
          </div>
          <div class="bk-sec-lbl">Balance</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label class="bk-fl">Opening Balance (₹)</label><input class="bk-fi" type="number" v-model="form.opening" placeholder="0.00" style="font-family:var(--mono)"/></div>
            <div><label class="bk-fl">Current Balance (₹)</label><input class="bk-fi" type="number" v-model="form.balance" placeholder="0.00" style="font-family:var(--mono)"/></div>
            <div v-if="showOD"><label class="bk-fl">Overdraft Limit (₹)</label><input class="bk-fi" type="number" v-model="form.od_limit" placeholder="0" style="font-family:var(--mono)"/></div>
          </div>
          <div class="bk-sec-lbl">Contact</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label class="bk-fl">Relationship Manager</label><input class="bk-fi" v-model="form.rm" placeholder="Name"/></div>
            <div><label class="bk-fl">RM Phone</label><input class="bk-fi" v-model="form.rm_phone" type="tel" placeholder="+91 98765 43210"/></div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:16px">
            <input type="checkbox" :checked="form.is_default==1" @change="form.is_default=$event.target.checked?1:0" style="accent-color:#0C8599"/>
            Set as default account
          </label>
        </div>
        <div class="bk-d-footer">
          <button class="b-btn b-btn-ghost" @click="drawerOpen=false">Cancel</button>
          <button class="b-btn b-btn-primary" @click="saveAccount" style="background:#0C8599;border-color:#0C8599;min-width:130px">Save Account</button>
        </div>
      </div>
    </div>
    <!-- Delete confirm -->
    <div v-if="showDel" class="bk-modal-bg">
      <div class="bk-modal-box">
        <div style="font-size:17px;font-weight:700;margin-bottom:8px">Remove Bank Account?</div>
        <div style="font-size:13px;color:#868E96;margin-bottom:20px;line-height:1.5">Remove <strong>{{deleteTarget?.name}}</strong>? This does not delete the GL account — only removes it from the banking module.</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="b-btn b-btn-ghost" @click="showDel=false">Keep It</button>
          <button class="b-btn b-btn-primary" style="background:#C92A2A;border-color:#C92A2A" @click="doDelete">Yes, Remove</button>
        </div>
      </div>
    </div>
  </teleport>
</div>`});

  /* ══════════════════════════════════════════════════
     BANK TRANSACTIONS
  ══════════════════════════════════════════════════ */
  const BankTransactions = defineComponent({
    name: "BankTransactions",
    setup() {
      const allTxns = ref([]);
      const loading = ref(true);
      const bankAccounts = ref([]);
      const filterType = ref("all");
      const filterAcct = ref("");
      const dateFrom = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10));
      const dateTo = ref(new Date().toISOString().slice(0, 10));
      const searchQ = ref("");
      const drawerOpen = ref(false);
      const activeTxn = ref(null);
      const selectedCat = ref("other");

      async function load() {
        loading.value = true;
        let ok = false;
        try {
          const r = await apiGET("frappe.client.get_list", { doctype:"Bank Transaction", fields:JSON.stringify(["name","date","bank_account","description","withdrawal","deposit","closing_balance","status"]), order_by:"date desc", limit_page_length:500 });
          if (r && r.length) {
            allTxns.value = r.map(t => ({ id:t.name, date:t.date, account:t.bank_account||"", description:t.description||"", type:flt(t.deposit)>0?"Credit":"Debit", amount:flt(t.deposit)||flt(t.withdrawal), balance:flt(t.closing_balance), category:autoCat(t.description||""), reconciled:t.status==="Reconciled", notes:"" }));
            ok = true;
          }
        } catch {}
        if (!ok) {
          const saved = JSON.parse(localStorage.getItem("books_bank_txns") || "[]");
          allTxns.value = saved.length ? saved : DEFAULT_BANK_TXNS;
          if (!saved.length) localStorage.setItem("books_bank_txns", JSON.stringify(allTxns.value));
        }
        const ba = JSON.parse(localStorage.getItem("books_bank_accounts") || "[]");
        bankAccounts.value = ba.length ? ba.map(a => a.name) : DEFAULT_BANK_ACCOUNTS.map(a => a.name);
        loading.value = false;
      }

      function autoCat(desc) {
        const d = desc.toLowerCase();
        if (/(salary|payroll|wages)/.test(d)) return "salary";
        if (/(rent|lease|property)/.test(d)) return "rent";
        if (/(electricity|bescom|water|utility)/.test(d)) return "utilities";
        if (/(gst|tds|tax)/.test(d)) return "tax";
        if (/(neft|rtgs|imps|transfer)/.test(d)) return "transfer";
        if (/(interest|int cr)/.test(d)) return "interest";
        if (/(bank charge|service charge|annual fee)/.test(d)) return "bank-charge";
        if (/(aws|azure|zoho|slack|subscription)/.test(d)) return "software";
        if (/(flight|hotel|travel|uber|ola)/.test(d)) return "travel";
        return "other";
      }

      const filtered = computed(() => {
        let r = allTxns.value;
        if (filterType.value === "Credit") r = r.filter(t => t.type === "Credit");
        else if (filterType.value === "Debit") r = r.filter(t => t.type === "Debit");
        else if (filterType.value === "Uncategorised") r = r.filter(t => !t.category || t.category === "other");
        else if (filterType.value === "Reconciled") r = r.filter(t => t.reconciled);
        if (filterAcct.value) r = r.filter(t => t.account === filterAcct.value);
        if (dateFrom.value) r = r.filter(t => t.date >= dateFrom.value);
        if (dateTo.value) r = r.filter(t => t.date <= dateTo.value);
        if (searchQ.value) { const q = searchQ.value.toLowerCase(); r = r.filter(t => (t.description + t.account).toLowerCase().includes(q)); }
        return r.sort((a, b) => b.date.localeCompare(a.date));
      });

      const stats = computed(() => ({
        cr: allTxns.value.filter(t => t.type === "Credit").reduce((s, t) => s + flt(t.amount), 0),
        dr: allTxns.value.filter(t => t.type === "Debit").reduce((s, t) => s + flt(t.amount), 0),
        rec: allTxns.value.filter(t => t.reconciled).length,
        uncat: allTxns.value.filter(t => !t.category || t.category === "other").length,
        total: allTxns.value.length,
      }));

      function openTxn(t) { activeTxn.value = t; selectedCat.value = t.category || "other"; drawerOpen.value = true; }

      function saveTxn() {
        if (!activeTxn.value) return;
        const t = allTxns.value.find(x => x.id === activeTxn.value.id);
        if (t) { t.category = selectedCat.value; t.notes = activeTxn.value.notes || ""; }
        localStorage.setItem("books_bank_txns", JSON.stringify(allTxns.value));
        drawerOpen.value = false;
        toast("Transaction categorised as " + (CAT_MAP_BANK[selectedCat.value]?.label || selectedCat.value));
      }

      function markReconciled(t) {
        const tx = allTxns.value.find(x => x.id === t.id);
        if (tx) { tx.reconciled = true; localStorage.setItem("books_bank_txns", JSON.stringify(allTxns.value)); }
        drawerOpen.value = false;
        toast("Marked as reconciled");
      }

      onMounted(load);
      return { allTxns, loading, filtered, stats, bankAccounts, filterType, filterAcct, dateFrom, dateTo, searchQ, drawerOpen, activeTxn, selectedCat, openTxn, saveTxn, markReconciled, load, fmtINR, fmtINRc, fmtDate, icon, flt, TXN_CATEGORIES, CAT_MAP_BANK };
    },
    template: `
<div class="b-page">
  <!-- Stats strip -->
  <div class="bk-sum-strip">
    <div class="bk-sum-card"><div class="bk-sum-lbl">Total Credits</div><div class="bk-sum-val c-green">{{fmtINRc(stats.cr)}}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl">Total Debits</div><div class="bk-sum-val c-red">{{fmtINRc(stats.dr)}}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl" style="color:#0C8599">Reconciled</div><div class="bk-sum-val" style="color:#0C8599">{{stats.rec}}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl" style="color:#E67700">Uncategorised</div><div class="bk-sum-val" style="color:#E67700">{{stats.uncat}}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl">Transactions</div><div class="bk-sum-val">{{stats.total}}</div></div>
  </div>
  <!-- Filters -->
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button v-for="f in ['all','Credit','Debit','Uncategorised','Reconciled']" :key="f"
        class="bk-pill" :class="{active:filterType===f}" @click="filterType=f">
        {{f==='all'?'All':f}}
        <span v-if="f==='Credit'" class="bk-pc" style="background:#EBFBEE;color:#2F9E44">{{allTxns.filter(t=>t.type==='Credit').length}}</span>
        <span v-if="f==='Debit'" class="bk-pc" style="background:#FFE3E3;color:#C92A2A">{{allTxns.filter(t=>t.type==='Debit').length}}</span>
        <span v-if="f==='Uncategorised'" class="bk-pc" style="background:#FFF3BF;color:#E67700">{{allTxns.filter(t=>!t.category||t.category==='other').length}}</span>
        <span v-if="f==='Reconciled'" class="bk-pc" style="background:#E0F7FA;color:#0C8599">{{allTxns.filter(t=>t.reconciled).length}}</span>
      </button>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-left:auto;flex-wrap:wrap">
      <select class="b-input" style="font-size:13px" v-model="filterAcct">
        <option value="">All Accounts</option>
        <option v-for="a in bankAccounts" :key="a" :value="a">{{a}}</option>
      </select>
      <input type="date" class="b-input" v-model="dateFrom" style="font-size:12px"/>
      <input type="date" class="b-input" v-model="dateTo" style="font-size:12px"/>
      <div style="display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #E2E8F0;border-radius:20px;padding:5px 12px">
        <span v-html="icon('search',12)" style="color:#868E96"></span>
        <input v-model="searchQ" placeholder="Search..." style="border:none;outline:none;font-size:13px;width:170px;background:transparent;font-family:inherit"/>
      </div>
      <button class="b-btn b-btn-ghost" @click="load"><span v-html="icon('refresh',13)"></span></button>
    </div>
  </div>
  <!-- Table -->
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Date</th><th>Account</th><th>Description</th><th>Category</th><th class="ta-r">Debit</th><th class="ta-r">Credit</th><th class="ta-r">Balance</th><th>Status</th><th style="text-align:center">Action</th></tr></thead>
      <tbody>
        <template v-if="loading"><tr v-for="n in 6" :key="n"><td colspan="9" style="padding:12px"><div class="b-shimmer" style="height:13px"></div></td></tr></template>
        <tr v-else-if="!filtered.length"><td colspan="9" class="b-empty">No transactions found — adjust filters or import a bank statement</td></tr>
        <tr v-else v-for="t in filtered" :key="t.id" @click="openTxn(t)" style="cursor:pointer;transition:background .1s" class="bk-txn-row">
          <td class="c-muted" style="font-size:12.5px;white-space:nowrap">{{fmtDate(t.date)}}</td>
          <td style="font-size:12px;color:#868E96;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{t.account}}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">{{t.description}}</td>
          <td>
            <span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:11.5px;font-weight:600"
              :style="{background:(CAT_MAP_BANK[t.category]||CAT_MAP_BANK.other).bg,color:(CAT_MAP_BANK[t.category]||CAT_MAP_BANK.other).color}">
              {{(CAT_MAP_BANK[t.category]||CAT_MAP_BANK.other).icon}} {{(CAT_MAP_BANK[t.category]||CAT_MAP_BANK.other).label}}
            </span>
          </td>
          <td class="ta-r mono fw-600 c-red" style="font-size:12.5px">{{t.type==='Debit'?fmtINR(t.amount):'—'}}</td>
          <td class="ta-r mono fw-600 c-green" style="font-size:12.5px">{{t.type==='Credit'?fmtINR(t.amount):'—'}}</td>
          <td class="ta-r mono c-muted" style="font-size:12px">{{t.balance?fmtINR(t.balance):'—'}}</td>
          <td><span class="b-badge" :class="t.reconciled?'b-badge-green':'b-badge-amber'">{{t.reconciled?'✓ Reconciled':'Pending'}}</span></td>
          <td style="text-align:center">
            <button class="b-btn b-btn-ghost" style="padding:4px 8px" @click.stop="openTxn(t)"><span v-html="icon('eye',12)"></span></button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="filtered.length" style="padding:8px 16px;font-size:12px;color:#868E96;border-top:1px solid #F1F3F5;display:flex;justify-content:space-between">
      <span>{{filtered.length}} transactions</span>
      <span>
        <span class="c-green fw-600">+{{fmtINR(filtered.filter(t=>t.type==='Credit').reduce((s,t)=>s+flt(t.amount),0))}}</span> in &nbsp;·&nbsp;
        <span class="c-red fw-600">-{{fmtINR(filtered.filter(t=>t.type==='Debit').reduce((s,t)=>s+flt(t.amount),0))}}</span> out
      </span>
    </div>
  </div>
  <!-- Categorise Drawer -->
  <teleport to="body">
    <div v-if="drawerOpen&&activeTxn" class="bk-drawer-bg" @click.self="drawerOpen=false">
      <div class="bk-drawer-panel">
        <div class="bk-dh">
          <div class="bk-dh-left">
            <div class="bk-dh-icon"><span v-html="icon('pay',18)"></span></div>
            <div>
              <h3>Transaction Detail</h3>
              <div class="bk-dh-sub">{{fmtDate(activeTxn.date)}} · {{activeTxn.account}}</div>
            </div>
          </div>
          <button class="bk-d-close" @click="drawerOpen=false"><span v-html="icon('x',16)"></span></button>
        </div>
        <div class="bk-d-body">
          <!-- Amount card -->
          <div style="background:#F8F9FC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin-bottom:16px">
            <div style="font-size:24px;font-weight:700;font-family:var(--mono)" :class="activeTxn.type==='Credit'?'c-green':'c-red'">
              {{activeTxn.type==='Credit'?'+':'-'}}{{fmtINR(activeTxn.amount)}}
            </div>
            <div style="font-size:13px;color:#868E96;margin-top:4px">{{activeTxn.description}}</div>
            <div style="display:flex;gap:14px;margin-top:8px;font-size:12.5px;color:#868E96">
              <span>📅 {{fmtDate(activeTxn.date)}}</span>
              <span>🏛 {{activeTxn.account}}</span>
              <span v-if="activeTxn.balance">Balance: {{fmtINR(activeTxn.balance)}}</span>
            </div>
          </div>
          <div class="bk-sec-lbl">Category</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
            <div v-for="c in TXN_CATEGORIES" :key="c.id"
              style="border:1.5px solid #E2E8F0;border-radius:8px;padding:10px 8px;text-align:center;cursor:pointer;transition:all .12s;font-size:12px;font-weight:500"
              :style="selectedCat===c.id?{borderColor:c.color,background:c.bg,color:c.color}:{}"
              @click="selectedCat=c.id">
              <div style="font-size:18px;margin-bottom:3px">{{c.icon}}</div>
              <div>{{c.label}}</div>
            </div>
          </div>
          <div class="bk-sec-lbl">Notes</div>
          <textarea class="bk-fi" rows="2" style="resize:vertical;margin-bottom:4px" placeholder="Optional notes..." v-model="activeTxn.notes"></textarea>
        </div>
        <div class="bk-d-footer">
          <div style="font-size:12px;color:#868E96">ID: {{activeTxn.id}}</div>
          <div style="display:flex;gap:8px">
            <button class="b-btn b-btn-ghost" @click="drawerOpen=false">Cancel</button>
            <button v-if="!activeTxn.reconciled" class="b-btn b-btn-ghost" style="border-color:#0C8599;color:#0C8599" @click="markReconciled(activeTxn)">✓ Reconcile</button>
            <button class="b-btn b-btn-primary" style="background:#0C8599;border-color:#0C8599" @click="saveTxn">Save</button>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</div>`});

  /* ══════════════════════════════════════════════════
     BANK RECONCILIATION
  ══════════════════════════════════════════════════ */
  const BankReconciliation = defineComponent({
    name: "BankReconciliation",
    setup() {
      const bankAccounts = ref([]);
      const selAccount = ref("");
      const stmtDate = ref(new Date().toISOString().slice(0, 10));
      const stmtBalance = ref(0);
      const loading = ref(false);
      const bookTxns = ref([]);     // GL / journal entries for this account
      const bankTxns = ref([]);     // Bank statement transactions
      const selectedBook = ref([]); // names of selected book items
      const selectedBank = ref([]); // ids of selected bank items

      async function load() {
        if (!selAccount.value) return;
        loading.value = true;
        try {
          // Load unreconciled bank transactions from Frappe
          const r = await apiGET("frappe.client.get_list", {
            doctype: "Bank Transaction",
            fields: JSON.stringify(["name","date","description","withdrawal","deposit","closing_balance","status"]),
            filters: JSON.stringify([["bank_account","=",selAccount.value],["status","!=","Reconciled"]]),
            order_by: "date desc", limit_page_length: 200
          });
          bankTxns.value = (r || []).map(t => ({ id:t.name, date:t.date, desc:t.description||"", type:flt(t.deposit)>0?"Credit":"Debit", amount:flt(t.deposit)||flt(t.withdrawal) }));
        } catch {
          // Use localStorage bank txns for selected account
          const saved = JSON.parse(localStorage.getItem("books_bank_txns") || "[]");
          bankTxns.value = saved.filter(t => t.account === selAccount.value && !t.reconciled).map(t => ({ id:t.id, date:t.date, desc:t.description, type:t.type, amount:flt(t.amount) }));
          if (!bankTxns.value.length) bankTxns.value = DEFAULT_BANK_TXNS.filter(t => t.account === selAccount.value && !t.reconciled).map(t => ({ id:t.id, date:t.date, desc:t.description, type:t.type, amount:flt(t.amount) }));
        }
        try {
          const gl = await apiGET("frappe.client.get_list", {
            doctype: "General Ledger Entry",
            fields: JSON.stringify(["name","posting_date","voucher_no","debit","credit","remarks"]),
            filters: JSON.stringify([["account","=",selAccount.value],["docstatus","=",1]]),
            order_by: "posting_date desc", limit_page_length: 200
          });
          bookTxns.value = (gl || []).map(g => ({ id:g.name, date:g.posting_date, desc:g.remarks||g.voucher_no||"", type:flt(g.credit)>0?"Credit":"Debit", amount:flt(g.debit)||flt(g.credit) }));
        } catch {
          bookTxns.value = [];
        }
        loading.value = false;
      }

      const bookBal = computed(() => {
        const acct = JSON.parse(localStorage.getItem("books_bank_accounts") || "[]").find(a => a.name === selAccount.value);
        return flt(acct?.balance || 0);
      });
      const selectedBankTotal = computed(() => bankTxns.value.filter(t => selectedBank.value.includes(t.id)).reduce((s, t) => s + (t.type === "Credit" ? flt(t.amount) : -flt(t.amount)), 0));
      const selectedBookTotal = computed(() => bookTxns.value.filter(t => selectedBook.value.includes(t.id)).reduce((s, t) => s + (t.type === "Credit" ? flt(t.amount) : -flt(t.amount)), 0));
      const diff = computed(() => flt(stmtBalance.value) - bookBal.value);
      const isBalanced = computed(() => Math.abs(diff.value) < 0.01);

      function toggleBank(id) { const i = selectedBank.value.indexOf(id); if (i >= 0) selectedBank.value.splice(i, 1); else selectedBank.value.push(id); }
      function toggleBook(id) { const i = selectedBook.value.indexOf(id); if (i >= 0) selectedBook.value.splice(i, 1); else selectedBook.value.push(id); }

      function matchSelected() {
        if (!selectedBank.value.length || !selectedBook.value.length) { toast("Select at least one item from each side to match", "error"); return; }
        bankTxns.value = bankTxns.value.filter(t => !selectedBank.value.includes(t.id));
        bookTxns.value = bookTxns.value.filter(t => !selectedBook.value.includes(t.id));
        selectedBank.value = []; selectedBook.value = [];
        toast("Items matched and reconciled");
      }

      async function finaliseReconciliation() {
        try {
          await apiPOST("zoho_books_clone.db.queries.reconcile_bank_account", { bank_account: selAccount.value, statement_date: stmtDate.value, statement_balance: stmtBalance.value });
          toast("Reconciliation saved");
        } catch {
          toast("Reconciliation saved locally", "info");
        }
      }

      async function loadAccounts() {
        const saved = JSON.parse(localStorage.getItem("books_bank_accounts") || "[]");
        bankAccounts.value = saved.length ? saved.map(a => a.name) : DEFAULT_BANK_ACCOUNTS.map(a => a.name);
        if (bankAccounts.value.length) { selAccount.value = bankAccounts.value[0]; await load(); }
      }

      onMounted(loadAccounts);
      return { bankAccounts, selAccount, stmtDate, stmtBalance, loading, bookTxns, bankTxns, selectedBook, selectedBank, bookBal, diff, isBalanced, selectedBankTotal, selectedBookTotal, load, toggleBank, toggleBook, matchSelected, finaliseReconciliation, fmtINR, fmtDate, icon, flt };
    },
    template: `
<div class="b-page">
  <!-- Setup bar -->
  <div class="b-card" style="padding:16px 20px">
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:4px">Bank Account</div>
        <select class="b-input" v-model="selAccount" @change="load" style="min-width:200px">
          <option v-for="a in bankAccounts" :key="a" :value="a">{{a}}</option>
        </select>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:4px">Statement Date</div>
        <input type="date" class="b-input" v-model="stmtDate"/>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:4px">Closing Balance (₹)</div>
        <input type="number" class="b-input" v-model="stmtBalance" placeholder="0.00" style="font-family:var(--mono);width:150px"/>
      </div>
      <button class="b-btn b-btn-primary" style="background:#0C8599;border-color:#0C8599;margin-top:18px" @click="load">Load</button>
    </div>
  </div>
  <!-- Balance panel -->
  <div class="b-card" style="padding:0;overflow:hidden">
    <div class="b-card-head"><span class="b-card-title">Reconciliation Balance</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr">
      <div style="padding:20px;border-right:1px solid #E2E8F0">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:14px">📚 Book Balance</div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #F8F9FC;font-size:13px"><span>Balance as per Books</span><span class="mono fw-600">{{fmtINR(bookBal)}}</span></div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #F8F9FC;font-size:13px"><span>Selected items</span><span class="mono fw-600" :class="selectedBookTotal>=0?'c-green':'c-red'">{{fmtINR(Math.abs(selectedBookTotal))}}</span></div>
        <div style="display:flex;justify-content:space-between;padding:10px 0;font-size:14px;font-weight:700"><span>Adjusted Balance</span><span class="mono">{{fmtINR(bookBal+selectedBookTotal)}}</span></div>
      </div>
      <div style="padding:20px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:14px">🏦 Bank Statement</div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #F8F9FC;font-size:13px"><span>Statement Closing Balance</span><span class="mono fw-600">{{fmtINR(stmtBalance)}}</span></div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #F8F9FC;font-size:13px"><span>Selected items</span><span class="mono fw-600" :class="selectedBankTotal>=0?'c-green':'c-red'">{{fmtINR(Math.abs(selectedBankTotal))}}</span></div>
        <div style="display:flex;justify-content:space-between;padding:10px 0;font-size:14px;font-weight:700"><span>Statement Balance</span><span class="mono">{{fmtINR(flt(stmtBalance)+selectedBankTotal)}}</span></div>
      </div>
    </div>
    <div style="padding:14px 20px;border-top:1px solid #E2E8F0;display:flex;align-items:center;justify-content:space-between;background:#F8F9FC">
      <div style="display:inline-flex;align-items:center;gap:7px;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:700"
        :style="isBalanced?{background:'#EBFBEE',color:'#2F9E44',border:'1px solid rgba(47,158,68,.2)'}:Math.abs(diff)<0.01?{background:'#F8F9FC',color:'#868E96',border:'1px solid #E2E8F0'}:{background:'#FFF5F5',color:'#C92A2A',border:'1px solid rgba(201,42,42,.2)'}">
        <span>{{isBalanced?'✓ Balanced':'Difference:'}}</span>
        <span v-if="!isBalanced" class="mono">{{fmtINR(Math.abs(diff))}}</span>
      </div>
      <div style="display:flex;gap:10px">
        <button v-if="selectedBank.length&&selectedBook.length" class="b-btn b-btn-primary" style="background:#0C8599;border-color:#0C8599" @click="matchSelected">Match Selected ({{selectedBank.length}}↔{{selectedBook.length}})</button>
        <button class="b-btn b-btn-primary" :disabled="!isBalanced" @click="finaliseReconciliation">Finalise Reconciliation</button>
      </div>
    </div>
  </div>
  <!-- Two-column match area -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <!-- Bank transactions -->
    <div class="b-card" style="padding:0;overflow:hidden">
      <div class="b-card-head">
        <span class="b-card-title">Unreconciled Bank Transactions</span>
        <span class="b-badge b-badge-amber">{{bankTxns.length}}</span>
      </div>
      <div v-if="loading" style="padding:20px"><div class="b-shimmer" style="height:60px"></div></div>
      <div v-else-if="!bankTxns.length" class="b-empty">All bank transactions reconciled ✓</div>
      <div v-else style="max-height:380px;overflow-y:auto">
        <div v-for="t in bankTxns" :key="t.id"
          style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #F1F3F5;cursor:pointer;transition:background .12s"
          :style="selectedBank.includes(t.id)?{background:'#E0F7FA'}:{}"
          @click="toggleBank(t.id)">
          <div style="width:16px;height:16px;border-radius:4px;border:2px solid" :style="selectedBank.includes(t.id)?{background:'#0C8599',borderColor:'#0C8599'}:{borderColor:'#CDD5E0'}">
            <span v-if="selectedBank.includes(t.id)" style="color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;height:100%">✓</span>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{t.desc}}</div>
            <div style="font-size:11.5px;color:#868E96">{{fmtDate(t.date)}}</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div class="mono fw-600" :class="t.type==='Credit'?'c-green':'c-red'" style="font-size:13px">{{t.type==='Credit'?'+':'-'}}{{fmtINR(t.amount)}}</div>
            <div class="b-badge" :class="t.type==='Credit'?'b-badge-green':'b-badge-red'" style="font-size:10px">{{t.type}}</div>
          </div>
        </div>
      </div>
    </div>
    <!-- Book entries -->
    <div class="b-card" style="padding:0;overflow:hidden">
      <div class="b-card-head">
        <span class="b-card-title">Unreconciled GL Entries</span>
        <span class="b-badge b-badge-amber">{{bookTxns.length}}</span>
      </div>
      <div v-if="loading" style="padding:20px"><div class="b-shimmer" style="height:60px"></div></div>
      <div v-else-if="!bookTxns.length" class="b-empty">No unreconciled GL entries</div>
      <div v-else style="max-height:380px;overflow-y:auto">
        <div v-for="t in bookTxns" :key="t.id"
          style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #F1F3F5;cursor:pointer;transition:background .12s"
          :style="selectedBook.includes(t.id)?{background:'#EEF2FF'}:{}"
          @click="toggleBook(t.id)">
          <div style="width:16px;height:16px;border-radius:4px;border:2px solid" :style="selectedBook.includes(t.id)?{background:'#3B5BDB',borderColor:'#3B5BDB'}:{borderColor:'#CDD5E0'}">
            <span v-if="selectedBook.includes(t.id)" style="color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;height:100%">✓</span>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{t.desc}}</div>
            <div style="font-size:11.5px;color:#868E96">{{fmtDate(t.date)}}</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div class="mono fw-600" :class="t.type==='Credit'?'c-green':'c-red'" style="font-size:13px">{{t.type==='Credit'?'+':'-'}}{{fmtINR(t.amount)}}</div>
            <div class="b-badge" :class="t.type==='Credit'?'b-badge-green':'b-badge-red'" style="font-size:10px">{{t.type}}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`});

  /* ══════════════════════════════════════════════════
     CHEQUE MANAGEMENT
  ══════════════════════════════════════════════════ */
  const ChequeManagement = defineComponent({
    name: "ChequeManagement",
    setup() {
      const cheques = ref([]);
      const activeTab = ref("issued");
      const filterStatus = ref("all");
      const searchQ = ref("");
      const drawerOpen = ref(false);
      const drawerMode = ref("add");
      const editingName = ref(null);
      const form = reactive({ no:"", date: new Date().toISOString().slice(0,10), payee:"", bank_account:"", amount:0, due_date:"", status:"Issued", remarks:"" });
      const bankAccounts = ref([]);

      const CHEQUE_STATUS_META = {
        Issued:   { color:"#3B5BDB", bg:"#EEF2FF" },
        Cleared:  { color:"#2F9E44", bg:"#EBFBEE" },
        Bounced:  { color:"#C92A2A", bg:"#FFE3E3" },
        Void:     { color:"#868E96", bg:"#F1F3F5" },
        Presented:{ color:"#E67700", bg:"#FFF3BF" },
        Received: { color:"#0C8599", bg:"#E0F7FA" },
        Deposited:{ color:"#2F9E44", bg:"#EBFBEE" },
      };

      const DEFAULTS = [
        { name:"CHQ-0001", no:"000101", date:"2026-04-05", payee:"Sharma Traders", bank_account:"HDFC Current Account", amount:75000, due_date:"2026-04-20", status:"Issued", type:"issued", remarks:"For March supplies" },
        { name:"CHQ-0002", no:"000102", date:"2026-03-28", payee:"Brigade Properties", bank_account:"HDFC Current Account", amount:50000, due_date:"2026-04-05", status:"Cleared", type:"issued", remarks:"March rent" },
        { name:"CHQ-0003", no:"REC-001", date:"2026-04-08", payee:"TechSoft Solutions", bank_account:"ICICI Savings Account", amount:125000, due_date:"2026-04-15", status:"Received", type:"received", remarks:"Invoice INV-0142" },
        { name:"CHQ-0004", no:"000099", date:"2026-02-14", payee:"Vendor Co", bank_account:"HDFC Current Account", amount:15000, due_date:"2026-03-01", status:"Bounced", type:"issued", remarks:"Re-presenting" },
      ];

      async function load() {
        // Try Payment Entry with cheque reference (mode_of_payment = Cheque)
        try {
          const r = await apiGET("frappe.client.get_list", {
            doctype: "Payment Entry",
            fields: JSON.stringify(["name","posting_date","payment_type","party","bank_account","paid_amount","received_amount","reference_no","reference_date","remarks","docstatus"]),
            filters: JSON.stringify([["mode_of_payment","=","Cheque"],["docstatus","!=",2]]),
            order_by: "posting_date desc",
            limit_page_length: 200,
          });
          if (r && r.length) {
            cheques.value = r.map(c => ({
              name: c.name, no: c.reference_no || "", date: c.posting_date || "",
              payee: c.party || "", bank_account: c.bank_account || "",
              amount: flt(c.paid_amount || c.received_amount),
              due_date: c.reference_date || "", status: c.docstatus === 1 ? "Cleared" : "Issued",
              type: c.payment_type === "Pay" ? "issued" : "received", remarks: c.remarks || "",
            }));
            const ba = JSON.parse(localStorage.getItem("books_bank_accounts") || "[]");
            bankAccounts.value = ba.length ? ba.map(a => a.name) : DEFAULT_BANK_ACCOUNTS.map(a => a.name);
            return;
          }
        } catch {}
        const saved = JSON.parse(localStorage.getItem("books_cheques") || "[]");
        cheques.value = saved.length ? saved : DEFAULTS;
        if (!saved.length) localStorage.setItem("books_cheques", JSON.stringify(cheques.value));
        const ba = JSON.parse(localStorage.getItem("books_bank_accounts") || "[]");
        bankAccounts.value = ba.length ? ba.map(a => a.name) : DEFAULT_BANK_ACCOUNTS.map(a => a.name);
      }

      const filtered = computed(() => {
        let r = cheques.value.filter(c => c.type === activeTab.value || (activeTab.value === "void" && c.status === "Void"));
        if (activeTab.value !== "void") r = r.filter(c => c.status !== "Void");
        if (filterStatus.value !== "all") r = r.filter(c => c.status === filterStatus.value);
        if (searchQ.value) { const q = searchQ.value.toLowerCase(); r = r.filter(c => (c.payee + c.no + c.bank_account).toLowerCase().includes(q)); }
        return r.sort((a, b) => b.date.localeCompare(a.date));
      });

      const stats = computed(() => ({
        total: cheques.value.length,
        issued: cheques.value.filter(c => c.status === "Issued").length,
        cleared: cheques.value.filter(c => c.status === "Cleared").length,
        bounced: cheques.value.filter(c => c.status === "Bounced").length,
        totalAmt: cheques.value.reduce((s, c) => s + flt(c.amount), 0),
      }));

      function openAdd() {
        drawerMode.value = "add"; editingName.value = null;
        Object.assign(form, { no:"", date: new Date().toISOString().slice(0,10), payee:"", bank_account: bankAccounts.value[0]||"", amount:0, due_date:"", status: activeTab.value==="received"?"Received":"Issued", remarks:"" });
        drawerOpen.value = true;
      }
      function openEdit(c) {
        drawerMode.value = "edit"; editingName.value = c.name;
        Object.assign(form, { no:c.no, date:c.date, payee:c.payee, bank_account:c.bank_account, amount:c.amount, due_date:c.due_date, status:c.status, remarks:c.remarks });
        drawerOpen.value = true;
      }
      function save() {
        if (!form.no || !form.payee) { toast("Cheque number and payee are required", "error"); return; }
        const doc = { ...form, type: activeTab.value === "received" ? "received" : "issued", name: editingName.value || ("CHQ-" + String(Date.now()).slice(-4)) };
        const idx = cheques.value.findIndex(c => c.name === editingName.value);
        if (idx >= 0) cheques.value[idx] = doc; else cheques.value.unshift(doc);
        localStorage.setItem("books_cheques", JSON.stringify(cheques.value));
        drawerOpen.value = false;
        toast(drawerMode.value === "edit" ? "Cheque updated" : "Cheque added");
      }
      function changeStatus(c, status) {
        const idx = cheques.value.findIndex(x => x.name === c.name);
        if (idx >= 0) { cheques.value[idx].status = status; localStorage.setItem("books_cheques", JSON.stringify(cheques.value)); toast("Status updated to " + status); }
      }

      onMounted(load);
      return { cheques, filtered, stats, activeTab, filterStatus, searchQ, drawerOpen, drawerMode, form, bankAccounts, CHEQUE_STATUS_META, openAdd, openEdit, save, changeStatus, fmtINR, fmtDate, icon, flt };
    },
    template: `
<div class="b-page">
  <!-- Stats -->
  <div class="bk-sum-strip">
    <div class="bk-sum-card"><div class="bk-sum-lbl">Total Cheques</div><div class="bk-sum-val">{{stats.total}}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl" style="color:#3B5BDB">Issued</div><div class="bk-sum-val" style="color:#3B5BDB">{{stats.issued}}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl" style="color:#2F9E44">Cleared</div><div class="bk-sum-val" style="color:#2F9E44">{{stats.cleared}}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl" style="color:#C92A2A">Bounced</div><div class="bk-sum-val" style="color:#C92A2A">{{stats.bounced}}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl">Total Amount</div><div class="bk-sum-val">{{fmtINR(stats.totalAmt)}}</div></div>
  </div>
  <!-- Tabs -->
  <div style="display:flex;gap:2px;background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:4px;margin-bottom:14px;width:fit-content">
    <button v-for="t in [{k:'issued',l:'Issued Cheques'},{k:'received',l:'Received Cheques'},{k:'void',l:'Void / Cancelled'}]" :key="t.k"
      style="padding:7px 18px;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;border:none;font-family:inherit;transition:all .15s"
      :style="activeTab===t.k?{background:'#0C8599',color:'#fff'}:{background:'none',color:'#868E96'}"
      @click="activeTab=t.k">{{t.l}}</button>
  </div>
  <!-- Action bar -->
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
    <button v-for="s in ['all','Issued','Cleared','Bounced','Presented']" :key="s"
      class="bk-pill" :class="{active:filterStatus===s}" @click="filterStatus=s">{{s==='all'?'All Statuses':s}}</button>
    <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
      <div style="display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #E2E8F0;border-radius:20px;padding:5px 12px">
        <span v-html="icon('search',12)" style="color:#868E96"></span>
        <input v-model="searchQ" placeholder="Search cheques..." style="border:none;outline:none;font-size:13px;width:160px;background:transparent;font-family:inherit"/>
      </div>
      <button class="b-btn b-btn-primary" style="background:#0C8599;border-color:#0C8599" @click="openAdd">+ Add Cheque</button>
    </div>
  </div>
  <!-- Table -->
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Cheque No.</th><th>Date</th><th>{{activeTab==='received'?'From (Drawer)':'To (Payee)'}}</th><th>Bank Account</th><th class="ta-r">Amount</th><th>Due Date</th><th>Status</th><th style="text-align:center">Actions</th></tr></thead>
      <tbody>
        <tr v-if="!filtered.length"><td colspan="8" class="b-empty">No cheques found</td></tr>
        <tr v-for="c in filtered" :key="c.name" @click="openEdit(c)" style="cursor:pointer" class="bk-txn-row">
          <td class="mono fw-600 c-accent" style="font-size:13px">{{c.no||'—'}}</td>
          <td class="c-muted" style="font-size:12.5px">{{fmtDate(c.date)}}</td>
          <td style="font-weight:500">{{c.payee}}</td>
          <td class="c-muted" style="font-size:12.5px">{{c.bank_account}}</td>
          <td class="ta-r mono fw-700">{{fmtINR(c.amount)}}</td>
          <td class="c-muted" style="font-size:12.5px">{{c.due_date?fmtDate(c.due_date):'—'}}</td>
          <td>
            <span class="b-badge" :style="{background:(CHEQUE_STATUS_META[c.status]||CHEQUE_STATUS_META.Issued).bg,color:(CHEQUE_STATUS_META[c.status]||CHEQUE_STATUS_META.Issued).color,fontSize:'11px'}">{{c.status}}</span>
          </td>
          <td style="text-align:center">
            <div style="display:flex;gap:4px;justify-content:center" @click.stop>
              <button v-if="c.status==='Issued'||c.status==='Presented'" class="b-btn b-btn-ghost" style="padding:3px 8px;font-size:11px;border-color:#2F9E44;color:#2F9E44" @click="changeStatus(c,'Cleared')">Clear</button>
              <button v-if="c.status==='Issued'" class="b-btn b-btn-ghost" style="padding:3px 8px;font-size:11px;border-color:#C92A2A;color:#C92A2A" @click="changeStatus(c,'Bounced')">Bounce</button>
              <button v-if="c.status!=='Void'" class="b-btn b-btn-ghost" style="padding:3px 8px;font-size:11px" @click="changeStatus(c,'Void')">Void</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <!-- Drawer -->
  <teleport to="body">
    <div v-if="drawerOpen" class="bk-drawer-bg" @click.self="drawerOpen=false">
      <div class="bk-drawer-panel">
        <div class="bk-dh">
          <div class="bk-dh-left">
            <div class="bk-dh-icon"><span v-html="icon('creditnote',18)"></span></div>
            <div>
              <h3>{{drawerMode==='add'?'Add Cheque':'Edit Cheque'}}</h3>
              <div class="bk-dh-sub">{{activeTab==='received'?'Received / Inward':'Issued / Outward'}} Cheque</div>
            </div>
          </div>
          <button class="bk-d-close" @click="drawerOpen=false"><span v-html="icon('x',16)"></span></button>
        </div>
        <div class="bk-d-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label class="bk-fl">Cheque No. <span style="color:#C92A2A">*</span></label><input class="bk-fi" v-model="form.no" placeholder="000101" style="font-family:var(--mono)"/></div>
            <div><label class="bk-fl">Date</label><input type="date" class="bk-fi" v-model="form.date"/></div>
            <div><label class="bk-fl">{{activeTab==='received'?'Drawer (From)':'Payee (To)'}} <span style="color:#C92A2A">*</span></label><input class="bk-fi" v-model="form.payee" placeholder="Party name"/></div>
            <div><label class="bk-fl">Bank Account</label>
              <select class="bk-fi" v-model="form.bank_account">
                <option v-for="a in bankAccounts" :key="a" :value="a">{{a}}</option>
              </select>
            </div>
            <div><label class="bk-fl">Amount (₹)</label><input type="number" class="bk-fi" v-model="form.amount" placeholder="0.00" style="font-family:var(--mono)"/></div>
            <div><label class="bk-fl">Due / Presentation Date</label><input type="date" class="bk-fi" v-model="form.due_date"/></div>
          </div>
          <div style="margin-bottom:12px">
            <label class="bk-fl">Status</label>
            <select class="bk-fi" v-model="form.status">
              <option v-for="s in ['Issued','Presented','Cleared','Bounced','Received','Deposited','Void']" :key="s" :value="s">{{s}}</option>
            </select>
          </div>
          <div><label class="bk-fl">Remarks</label><textarea class="bk-fi" rows="2" v-model="form.remarks" placeholder="Optional remarks..."></textarea></div>
        </div>
        <div class="bk-d-footer">
          <button class="b-btn b-btn-ghost" @click="drawerOpen=false">Cancel</button>
          <button class="b-btn b-btn-primary" style="background:#0C8599;border-color:#0C8599" @click="save">Save Cheque</button>
        </div>
      </div>
    </div>
  </teleport>
</div>`});

  /* ══════════════════════════════════════════════════
     CASH MANAGEMENT
  ══════════════════════════════════════════════════ */
  const CashManagement = defineComponent({
    name: "CashManagement",
    setup() {
      const cashTxns = ref([]);
      const activeTab = ref("txns");
      const filterType = ref("all");
      const searchQ = ref("");
      const drawerOpen = ref(false);
      const drawerMode = ref("add");
      const entryForm = reactive({ date: new Date().toISOString().slice(0,10), type:"Receipt", desc:"", amount:0, category:"other", person:"", narration:"" });

      const DENOM = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
      const denomCount = reactive(Object.fromEntries(DENOM.map(d => [d, 0])));
      const denomTotal = computed(() => DENOM.reduce((s, d) => s + d * (denomCount[d] || 0), 0));

      const CASH_DEFAULTS = [
        { id:"CASH-001", date: new Date().toISOString().slice(0,10), type:"Receipt", desc:"Cash received from customer", amount:25000, category:"customer", person:"Ravi Kumar", narration:"Invoice INV-0142" },
        { id:"CASH-002", date: new Date(Date.now()-86400000).toISOString().slice(0,10), type:"Payment", desc:"Office stationery", amount:1250, category:"other", person:"", narration:"Petty cash" },
        { id:"CASH-003", date: new Date(Date.now()-2*86400000).toISOString().slice(0,10), type:"Receipt", desc:"Cash sales", amount:8500, category:"customer", person:"Walk-in", narration:"Daily sales" },
        { id:"CASH-004", date: new Date(Date.now()-3*86400000).toISOString().slice(0,10), type:"Payment", desc:"Travelling allowance", amount:2000, category:"travel", person:"Sales Rep", narration:"Field visit" },
      ];

      async function load() {
        // Try pulling cash-related Payment Entries from Frappe (Cash account mode)
        try {
          const r = await apiGET("frappe.client.get_list", {
            doctype: "Payment Entry",
            fields: JSON.stringify(["name","posting_date","payment_type","remarks","paid_amount","received_amount","mode_of_payment"]),
            filters: JSON.stringify([["mode_of_payment","=","Cash"],["docstatus","=",1]]),
            order_by: "posting_date desc",
            limit_page_length: 200,
          });
          if (r && r.length) {
            cashTxns.value = r.map(t => ({
              id: t.name, date: t.posting_date,
              type: t.payment_type === "Pay" ? "Payment" : "Receipt",
              desc: t.remarks || t.name, amount: flt(t.paid_amount || t.received_amount),
              category: "other", person: "", narration: t.remarks || "",
            }));
            return;
          }
        } catch {}
        const saved = JSON.parse(localStorage.getItem("books_cash_txns") || "[]");
        cashTxns.value = saved.length ? saved : CASH_DEFAULTS;
        if (!saved.length) localStorage.setItem("books_cash_txns", JSON.stringify(cashTxns.value));
      }

      const filtered = computed(() => {
        let r = cashTxns.value;
        if (filterType.value === "Receipt") r = r.filter(t => t.type === "Receipt");
        else if (filterType.value === "Payment") r = r.filter(t => t.type === "Payment");
        if (searchQ.value) { const q = searchQ.value.toLowerCase(); r = r.filter(t => (t.desc + t.person + t.narration).toLowerCase().includes(q)); }
        return r.sort((a, b) => b.date.localeCompare(a.date));
      });

      const hero = computed(() => {
        const today = new Date().toISOString().slice(0, 10);
        const todayTxns = cashTxns.value.filter(t => t.date === today);
        return {
          balance: cashTxns.value.reduce((s, t) => s + (t.type === "Receipt" ? flt(t.amount) : -flt(t.amount)), 0),
          todayIn: todayTxns.filter(t => t.type === "Receipt").reduce((s, t) => s + flt(t.amount), 0),
          todayOut: todayTxns.filter(t => t.type === "Payment").reduce((s, t) => s + flt(t.amount), 0),
        };
      });

      function openAdd(type = "Receipt") {
        drawerMode.value = "add";
        Object.assign(entryForm, { date: new Date().toISOString().slice(0,10), type, desc:"", amount:0, category:"other", person:"", narration:"" });
        drawerOpen.value = true;
      }

      function saveEntry() {
        if (!entryForm.amount || !entryForm.desc) { toast("Description and amount are required", "error"); return; }
        const doc = { ...entryForm, id: "CASH-" + Date.now().toString(36).toUpperCase() };
        cashTxns.value.unshift(doc);
        localStorage.setItem("books_cash_txns", JSON.stringify(cashTxns.value));
        drawerOpen.value = false;
        toast("Cash entry saved");
      }

      onMounted(load);
      return { cashTxns, filtered, hero, activeTab, filterType, searchQ, drawerOpen, drawerMode, entryForm, denomCount, denomTotal, DENOM, openAdd, saveEntry, fmtINR, fmtINRc, fmtDate, icon, flt, TXN_CATEGORIES, CAT_MAP_BANK };
    },
    template: `
<div class="b-page">
  <!-- Hero -->
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px">
    <div style="background:linear-gradient(135deg,#0a4f5c 0%,#0C8599 100%);border-radius:10px;padding:20px;position:relative;overflow:hidden">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:rgba(255,255,255,.75);margin-bottom:6px">Cash in Hand</div>
      <div style="font-size:28px;font-weight:700;font-family:var(--mono);color:#fff;margin-bottom:4px">{{fmtINR(hero.balance)}}</div>
      <div style="font-size:12px;color:rgba(255,255,255,.6)">Current petty cash balance</div>
      <div style="position:absolute;right:16px;top:16px;font-size:28px;opacity:.15">💵</div>
    </div>
    <div class="b-card b-card-body" style="position:relative;overflow:hidden">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#868E96;margin-bottom:6px">Today's Receipts</div>
      <div style="font-size:28px;font-weight:700;font-family:var(--mono);color:#2F9E44;margin-bottom:4px">+{{fmtINR(hero.todayIn)}}</div>
      <div style="font-size:12px;color:#868E96">Cash received today</div>
    </div>
    <div class="b-card b-card-body" style="position:relative;overflow:hidden">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#868E96;margin-bottom:6px">Today's Payments</div>
      <div style="font-size:28px;font-weight:700;font-family:var(--mono);color:#C92A2A;margin-bottom:4px">-{{fmtINR(hero.todayOut)}}</div>
      <div style="font-size:12px;color:#868E96">Cash paid out today</div>
    </div>
  </div>
  <!-- Tabs -->
  <div style="display:flex;gap:0;background:#fff;border:1px solid #E2E8F0;border-radius:10px;overflow:hidden;margin-bottom:14px">
    <button v-for="t in [{k:'txns',l:'Cash Transactions'},{k:'denom',l:'Denomination Counter'}]" :key="t.k"
      style="flex:1;padding:11px 16px;font-size:13px;font-weight:600;cursor:pointer;border:none;border-bottom:2px solid transparent;transition:all .15s;font-family:inherit;text-align:center"
      :style="activeTab===t.k?{color:'#0C8599',borderBottomColor:'#0C8599',background:'#E0F7FA'}:{color:'#868E96',background:'none'}"
      @click="activeTab=t.k">{{t.l}}</button>
  </div>
  <!-- Transactions tab -->
  <template v-if="activeTab==='txns'">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button v-for="f in ['all','Receipt','Payment']" :key="f"
        class="bk-pill" :class="{active:filterType===f}" @click="filterType=f">{{f==='all'?'All':f+'s'}}</button>
      <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
        <div style="display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #E2E8F0;border-radius:20px;padding:5px 12px">
          <span v-html="icon('search',12)" style="color:#868E96"></span>
          <input v-model="searchQ" placeholder="Search..." style="border:none;outline:none;font-size:13px;width:160px;background:transparent;font-family:inherit"/>
        </div>
        <button class="b-btn b-btn-ghost" style="border-color:#2F9E44;color:#2F9E44" @click="openAdd('Receipt')">+ Cash In</button>
        <button class="b-btn b-btn-ghost" style="border-color:#C92A2A;color:#C92A2A" @click="openAdd('Payment')">− Cash Out</button>
      </div>
    </div>
    <div class="b-card" style="padding:0;overflow:hidden">
      <table class="b-table">
        <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Person</th><th>Type</th><th class="ta-r">Amount</th></tr></thead>
        <tbody>
          <tr v-if="!filtered.length"><td colspan="6" class="b-empty">No cash entries yet</td></tr>
          <tr v-for="t in filtered" :key="t.id">
            <td class="c-muted" style="font-size:12.5px;white-space:nowrap">{{fmtDate(t.date)}}</td>
            <td style="font-size:13px">{{t.desc}}</td>
            <td>
              <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600"
                :style="{background:(CAT_MAP_BANK[t.category]||CAT_MAP_BANK.other).bg,color:(CAT_MAP_BANK[t.category]||CAT_MAP_BANK.other).color}">
                {{(CAT_MAP_BANK[t.category]||CAT_MAP_BANK.other).label}}
              </span>
            </td>
            <td class="c-muted" style="font-size:12.5px">{{t.person||'—'}}</td>
            <td><span class="b-badge" :class="t.type==='Receipt'?'b-badge-green':'b-badge-red'">{{t.type}}</span></td>
            <td class="ta-r mono fw-700" :class="t.type==='Receipt'?'c-green':'c-red'">{{t.type==='Receipt'?'+':'-'}}{{fmtINR(t.amount)}}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
  <!-- Denomination counter tab -->
  <template v-if="activeTab==='denom'">
    <div class="b-card b-card-body">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px">Denomination Counter</div>
      <div style="font-size:13px;color:#868E96;margin-bottom:20px">Count physical cash by denomination to verify petty cash balance</div>
      <div style="max-width:480px">
        <div v-for="d in DENOM" :key="d" style="display:grid;grid-template-columns:80px 1fr 1fr;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #F1F3F5">
          <div style="font-size:15px;font-weight:700;font-family:var(--mono)">₹{{d}}</div>
          <div style="display:flex;align-items:center;gap:8px">
            <button @click="denomCount[d]=Math.max(0,(denomCount[d]||0)-1)" style="width:28px;height:28px;border-radius:6px;border:1px solid #CDD5E0;background:#fff;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center">−</button>
            <input type="number" :value="denomCount[d]||0" @input="denomCount[d]=Math.max(0,parseInt($event.target.value)||0)" style="width:70px;text-align:center;border:1px solid #CDD5E0;border-radius:6px;padding:5px;font-family:var(--mono);font-size:14px;outline:none" min="0"/>
            <button @click="denomCount[d]=(denomCount[d]||0)+1" style="width:28px;height:28px;border-radius:6px;border:1px solid #CDD5E0;background:#fff;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center">+</button>
          </div>
          <div class="mono fw-600" style="text-align:right;font-size:14px">₹{{((denomCount[d]||0)*d).toLocaleString("en-IN")}}</div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 0;font-size:16px;font-weight:700;border-top:2px solid #E2E8F0;margin-top:4px">
          <span>Total Physical Cash</span>
          <span class="mono c-green">{{fmtINR(denomTotal)}}</span>
        </div>
        <div v-if="denomTotal>0" style="padding:10px 14px;border-radius:8px;font-size:13px;font-weight:600;margin-top:8px"
          :style="Math.abs(denomTotal-hero.balance)<0.01?{background:'#EBFBEE',color:'#2F9E44',border:'1px solid rgba(47,158,68,.2)'}:{background:'#FFF5F5',color:'#C92A2A',border:'1px solid rgba(201,42,42,.2)'}">
          {{Math.abs(denomTotal-hero.balance)<0.01?'✓ Matches book balance':'Difference: '+fmtINR(Math.abs(denomTotal-hero.balance))+' from book balance of '+fmtINR(hero.balance)}}
        </div>
      </div>
    </div>
  </template>
  <!-- Cash Entry Drawer -->
  <teleport to="body">
    <div v-if="drawerOpen" class="bk-drawer-bg" @click.self="drawerOpen=false">
      <div class="bk-drawer-panel">
        <div class="bk-dh" :style="{background:entryForm.type==='Receipt'?'linear-gradient(135deg,#1a7f4b,#2F9E44)':'linear-gradient(135deg,#a51010,#C92A2A)'}">
          <div class="bk-dh-left">
            <div class="bk-dh-icon" :style="{background:entryForm.type==='Receipt'?'rgba(255,255,255,.2)':'rgba(255,255,255,.2)'}">
              <span style="font-size:18px">{{entryForm.type==='Receipt'?'↓':'↑'}}</span>
            </div>
            <div>
              <h3>{{entryForm.type==='Receipt'?'Cash Receipt':'Cash Payment'}}</h3>
              <div class="bk-dh-sub">Record a cash {{entryForm.type==='Receipt'?'inflow':'outflow'}}</div>
            </div>
          </div>
          <button class="bk-d-close" @click="drawerOpen=false"><span v-html="icon('x',16)"></span></button>
        </div>
        <div class="bk-d-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label class="bk-fl">Date</label><input type="date" class="bk-fi" v-model="entryForm.date"/></div>
            <div><label class="bk-fl">Type</label>
              <select class="bk-fi" v-model="entryForm.type">
                <option>Receipt</option><option>Payment</option>
              </select>
            </div>
          </div>
          <div style="margin-bottom:12px"><label class="bk-fl">Description <span style="color:#C92A2A">*</span></label><input class="bk-fi" v-model="entryForm.desc" placeholder="What is this cash for?"/></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div><label class="bk-fl">Amount (₹) <span style="color:#C92A2A">*</span></label><input type="number" class="bk-fi" v-model="entryForm.amount" placeholder="0.00" style="font-family:var(--mono)"/></div>
            <div><label class="bk-fl">Person / Party</label><input class="bk-fi" v-model="entryForm.person" placeholder="Who paid / received?"/></div>
          </div>
          <div style="margin-bottom:12px"><label class="bk-fl">Category</label>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
              <div v-for="c in TXN_CATEGORIES.slice(0,9)" :key="c.id"
                style="border:1.5px solid #E2E8F0;border-radius:6px;padding:7px;text-align:center;cursor:pointer;font-size:11.5px"
                :style="entryForm.category===c.id?{borderColor:c.color,background:c.bg,color:c.color}:{}"
                @click="entryForm.category=c.id">{{c.icon}} {{c.label}}</div>
            </div>
          </div>
        </div>
        <div class="bk-d-footer">
          <button class="b-btn b-btn-ghost" @click="drawerOpen=false">Cancel</button>
          <button class="b-btn b-btn-primary" :style="{background:entryForm.type==='Receipt'?'#2F9E44':'#C92A2A',borderColor:entryForm.type==='Receipt'?'#2F9E44':'#C92A2A'}" @click="saveEntry">Save Entry</button>
        </div>
      </div>
    </div>
  </teleport>
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

  /* ══════════════════════════════════════════════════
     CHART OF ACCOUNTS
  ══════════════════════════════════════════════════ */
  const TYPE_META_COA = {
    Asset:     { color: "#0C8599", bg: "#E0F7FA", dr: true },
    Liability: { color: "#C92A2A", bg: "#FFE3E3", dr: false },
    Equity:    { color: "#7048E8", bg: "#F3F0FF", dr: false },
    Income:    { color: "#2F9E44", bg: "#EBFBEE", dr: false },
    Expense:   { color: "#E67700", bg: "#FFF3BF", dr: true },
  };
  // Account type options — must match exactly what this Frappe installation accepts
  // (plain Frappe Account doctype: Asset, Liability, Income, Expense, Bank, Cash, Receivable, Payable, Tax)
  const ACCOUNT_TYPES_COA = {
    Asset:     ["Asset","Bank","Cash","Receivable","Tax"],
    Liability: ["Liability","Payable","Tax"],
    Equity:    ["Equity"],
    Income:    ["Income"],
    Expense:   ["Expense"],
  };
  const STANDARD_COA_DATA = [
    {name:"Current Assets",code:"1000",root_type:"Asset",account_type:"",is_group:1,parent:"",opening:0,bal_type:"Debit"},
    {name:"Cash in Hand",code:"1001",root_type:"Asset",account_type:"Cash",is_group:0,parent:"Current Assets",opening:50000,bal_type:"Debit"},
    {name:"Bank Accounts",code:"1010",root_type:"Asset",account_type:"Bank",is_group:1,parent:"Current Assets",opening:0,bal_type:"Debit"},
    {name:"HDFC Current Account",code:"1011",root_type:"Asset",account_type:"Bank",is_group:0,parent:"Bank Accounts",opening:500000,bal_type:"Debit"},
    {name:"ICICI Savings Account",code:"1012",root_type:"Asset",account_type:"Bank",is_group:0,parent:"Bank Accounts",opening:200000,bal_type:"Debit"},
    {name:"Accounts Receivable",code:"1100",root_type:"Asset",account_type:"Receivable",is_group:0,parent:"Current Assets",opening:0,bal_type:"Debit"},
    {name:"Advance Tax Paid",code:"1200",root_type:"Asset",account_type:"Tax",is_group:0,parent:"Current Assets",opening:0,bal_type:"Debit"},
    {name:"Input GST (ITC)",code:"1300",root_type:"Asset",account_type:"Tax",is_group:1,parent:"Current Assets",opening:0,bal_type:"Debit"},
    {name:"CGST Input",code:"1301",root_type:"Asset",account_type:"Tax",is_group:0,parent:"Input GST (ITC)",opening:0,bal_type:"Debit"},
    {name:"SGST Input",code:"1302",root_type:"Asset",account_type:"Tax",is_group:0,parent:"Input GST (ITC)",opening:0,bal_type:"Debit"},
    {name:"IGST Input",code:"1303",root_type:"Asset",account_type:"Tax",is_group:0,parent:"Input GST (ITC)",opening:0,bal_type:"Debit"},
    {name:"Stock in Hand",code:"1400",root_type:"Asset",account_type:"Stock",is_group:0,parent:"Current Assets",opening:0,bal_type:"Debit"},
    {name:"Fixed Assets",code:"1500",root_type:"Asset",account_type:"",is_group:1,parent:"",opening:0,bal_type:"Debit"},
    {name:"Furniture & Fixtures",code:"1501",root_type:"Asset",account_type:"Fixed Asset",is_group:0,parent:"Fixed Assets",opening:150000,bal_type:"Debit"},
    {name:"Computer & Equipment",code:"1502",root_type:"Asset",account_type:"Fixed Asset",is_group:0,parent:"Fixed Assets",opening:300000,bal_type:"Debit"},
    {name:"Accumulated Depreciation",code:"1510",root_type:"Asset",account_type:"Fixed Asset",is_group:0,parent:"Fixed Assets",opening:0,bal_type:"Credit"},
    {name:"Current Liabilities",code:"2000",root_type:"Liability",account_type:"",is_group:1,parent:"",opening:0,bal_type:"Credit"},
    {name:"Accounts Payable",code:"2100",root_type:"Liability",account_type:"Payable",is_group:0,parent:"Current Liabilities",opening:0,bal_type:"Credit"},
    {name:"GST Payable",code:"2200",root_type:"Liability",account_type:"Tax",is_group:1,parent:"Current Liabilities",opening:0,bal_type:"Credit"},
    {name:"CGST Payable",code:"2201",root_type:"Liability",account_type:"Tax",is_group:0,parent:"GST Payable",opening:0,bal_type:"Credit"},
    {name:"SGST Payable",code:"2202",root_type:"Liability",account_type:"Tax",is_group:0,parent:"GST Payable",opening:0,bal_type:"Credit"},
    {name:"IGST Payable",code:"2203",root_type:"Liability",account_type:"Tax",is_group:0,parent:"GST Payable",opening:0,bal_type:"Credit"},
    {name:"TDS Payable",code:"2300",root_type:"Liability",account_type:"Tax",is_group:0,parent:"Current Liabilities",opening:0,bal_type:"Credit"},
    {name:"Salary Payable",code:"2400",root_type:"Liability",account_type:"Current Liability",is_group:0,parent:"Current Liabilities",opening:0,bal_type:"Credit"},
    {name:"Long-term Liabilities",code:"2500",root_type:"Liability",account_type:"",is_group:1,parent:"",opening:0,bal_type:"Credit"},
    {name:"Bank Loan",code:"2501",root_type:"Liability",account_type:"Other Liability",is_group:0,parent:"Long-term Liabilities",opening:500000,bal_type:"Credit"},
    {name:"Share Capital",code:"3000",root_type:"Equity",account_type:"Equity",is_group:0,parent:"",opening:1000000,bal_type:"Credit"},
    {name:"Retained Earnings",code:"3100",root_type:"Equity",account_type:"Retained Earnings",is_group:0,parent:"",opening:0,bal_type:"Credit"},
    {name:"Revenue",code:"4000",root_type:"Income",account_type:"",is_group:1,parent:"",opening:0,bal_type:"Credit"},
    {name:"Sales Revenue",code:"4001",root_type:"Income",account_type:"Income Account",is_group:0,parent:"Revenue",opening:0,bal_type:"Credit"},
    {name:"Service Revenue",code:"4002",root_type:"Income",account_type:"Income Account",is_group:0,parent:"Revenue",opening:0,bal_type:"Credit"},
    {name:"Other Income",code:"4100",root_type:"Income",account_type:"",is_group:1,parent:"",opening:0,bal_type:"Credit"},
    {name:"Interest Income",code:"4101",root_type:"Income",account_type:"Other Income",is_group:0,parent:"Other Income",opening:0,bal_type:"Credit"},
    {name:"Cost of Goods Sold",code:"5000",root_type:"Expense",account_type:"Cost of Goods Sold",is_group:0,parent:"",opening:0,bal_type:"Debit"},
    {name:"Operating Expenses",code:"5100",root_type:"Expense",account_type:"",is_group:1,parent:"",opening:0,bal_type:"Debit"},
    {name:"Salaries & Wages",code:"5101",root_type:"Expense",account_type:"Expense Account",is_group:0,parent:"Operating Expenses",opening:0,bal_type:"Debit"},
    {name:"Rent Expense",code:"5102",root_type:"Expense",account_type:"Expense Account",is_group:0,parent:"Operating Expenses",opening:0,bal_type:"Debit"},
    {name:"Utilities",code:"5103",root_type:"Expense",account_type:"Expense Account",is_group:0,parent:"Operating Expenses",opening:0,bal_type:"Debit"},
    {name:"Software & Subscriptions",code:"5104",root_type:"Expense",account_type:"Expense Account",is_group:0,parent:"Operating Expenses",opening:0,bal_type:"Debit"},
    {name:"Marketing & Advertising",code:"5105",root_type:"Expense",account_type:"Expense Account",is_group:0,parent:"Operating Expenses",opening:0,bal_type:"Debit"},
    {name:"Professional Fees",code:"5106",root_type:"Expense",account_type:"Expense Account",is_group:0,parent:"Operating Expenses",opening:0,bal_type:"Debit"},
    {name:"Travel & Transport",code:"5107",root_type:"Expense",account_type:"Expense Account",is_group:0,parent:"Operating Expenses",opening:0,bal_type:"Debit"},
    {name:"Depreciation",code:"5200",root_type:"Expense",account_type:"Depreciation",is_group:0,parent:"",opening:0,bal_type:"Debit"},
    {name:"Finance Charges",code:"5300",root_type:"Expense",account_type:"",is_group:1,parent:"",opening:0,bal_type:"Debit"},
    {name:"Bank Charges",code:"5301",root_type:"Expense",account_type:"Expense Account",is_group:0,parent:"Finance Charges",opening:0,bal_type:"Debit"},
    {name:"Interest Expense",code:"5302",root_type:"Expense",account_type:"Expense Account",is_group:0,parent:"Finance Charges",opening:0,bal_type:"Debit"},
  ];

  const ChartOfAccounts = defineComponent({
    name: "ChartOfAccounts",
    setup() {
      const allAccounts = ref([]);
      const loading = ref(true);
      const expandedGroups = ref(new Set());
      const typeFilter = ref("");
      const searchQ = ref("");
      const expandTick = ref(0); // force reactivity on Set mutations

      // Drawer state
      const drawerOpen = ref(false);
      const editingName = ref(null);
      const drawerSaving = ref(false);
      const form = reactive({ name:"", code:"", root_type:"", account_type:"", parent:"", is_group:0, bs_item:1, opening:"", bal_type:"Debit", notes:"" });

      // Delete confirm
      const showDel = ref(false);
      const deleteTarget = ref(null);

      const typeStats = computed(() => {
        return ["Asset","Liability","Equity","Income","Expense"].map(t => {
          const accts = allAccounts.value.filter(a => a.root_type === t && !a.is_group);
          const tot = accts.reduce((s,a) => s + Number(a.opening||0), 0);
          return { type: t, count: accts.length, total: tot, meta: TYPE_META_COA[t] };
        });
      });

      const accountTypeOptions = computed(() => {
        return ACCOUNT_TYPES_COA[form.root_type] || [];
      });

      const parentOptions = computed(() => {
        return allAccounts.value.filter(a => a.is_group);
      });

      // Flat tree for rendering - returns visible rows in order with depth
      const flatTree = computed(() => {
        // eslint-disable-next-line no-unused-expressions
        expandTick.value; // reactivity trigger
        const q = searchQ.value.toLowerCase().trim();
        const tf = typeFilter.value;
        if (q) {
          // Search mode: flat list filtered by name/code/type
          return allAccounts.value
            .filter(a => {
              const nm = (a.account_name || a.name).toLowerCase();
              const cd = (a.code || "").toLowerCase();
              return (!tf || a.root_type === tf) && (nm.includes(q) || cd.includes(q));
            })
            .map(a => ({ ...a, depth: 0 }));
        }
        // Tree mode
        function walk(parent, depth) {
          const children = allAccounts.value.filter(a => {
            const par = a.parent || "";
            return par === parent && (!tf || a.root_type === tf);
          });
          const rows = [];
          children.forEach(a => {
            rows.push({ ...a, depth });
            const hasChildren = allAccounts.value.some(c => (c.parent||"") === a.name);
            if (a.is_group && hasChildren && expandedGroups.value.has(a.name)) {
              rows.push(...walk(a.name, depth + 1));
            }
          });
          return rows;
        }
        return walk("", 0);
      });

      function toggleGroup(name) {
        if (expandedGroups.value.has(name)) {
          expandedGroups.value.delete(name);
        } else {
          expandedGroups.value.add(name);
        }
        expandTick.value++;
      }

      function expandAll() {
        allAccounts.value.filter(a => a.is_group).forEach(a => expandedGroups.value.add(a.name));
        expandTick.value++;
      }

      function collapseAll() {
        expandedGroups.value.clear();
        expandTick.value++;
      }

      function hasChildren(name) {
        return allAccounts.value.some(c => (c.parent||"") === name);
      }

      function fmtINR(v) {
        if (!v && v !== 0) return "—";
        const n = Number(v);
        if (n === 0) return "—";
        return "₹" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2 });
      }

      async function load() {
        loading.value = true;
        try {
          let frappeAccts = [];
          try {
            const res = await apiGET("zoho_books_clone.api.books_data.get_chart_of_accounts", {});
            frappeAccts = Array.isArray(res) ? res : [];
          } catch {}

          if (frappeAccts && frappeAccts.length) {
            // Helper: derive root_type from account_type when Frappe doesn't have the column
            const guessRootType = (a) => {
              if (a.root_type) return a.root_type;
              const t = (a.account_type || "").toLowerCase().trim();
              // Simple values used by plain Frappe (not ERPNext)
              if (t === "income" || t === "other income" || t.includes("income account")) return "Income";
              if (t === "expense" || t === "other expense" || t.includes("expense account") || t === "cost of goods sold" || t === "depreciation") return "Expense";
              if (t === "payable" || t === "liability" || t === "other liability" || t === "credit card" || t === "current liability") return "Liability";
              if (t === "equity" || t === "retained earnings") return "Equity";
              // Asset types: asset, bank, cash, receivable, tax, fixed asset, stock, etc.
              return "Asset";
            };
            allAccounts.value = frappeAccts.map(a => ({
              name: a.name,
              account_name: a.account_name || a.name,
              code: a.account_number || "",
              root_type: guessRootType(a),
              account_type: a.account_type || "",
              is_group: a.is_group ? 1 : 0,
              parent: a.parent_account || "",
              opening: Number(a.opening_balance || 0),
              bal_type: a.balance_must_be || "Debit",
              source: "frappe"
            }));
            // Clear stale local cache now that we have real data
            try { localStorage.removeItem("books_coa"); } catch {}
          } else {
            const saved = (() => { try { const s = localStorage.getItem("books_coa"); return s ? JSON.parse(s) : null; } catch { return null; } })();
            if (saved && saved.length) {
              allAccounts.value = saved;
            } else {
              allAccounts.value = STANDARD_COA_DATA.map(a => ({ ...a, account_name: a.name, source: "local" }));
              try { localStorage.setItem("books_coa", JSON.stringify(allAccounts.value)); } catch {}
            }
          }
          // Expand top-level groups by default
          allAccounts.value.filter(a => a.is_group && !a.parent).forEach(a => expandedGroups.value.add(a.name));
          expandTick.value++;
        } finally {
          loading.value = false;
        }
      }

      function openAdd(parentName) {
        editingName.value = null;
        Object.assign(form, { name:"", code:"", root_type:"", account_type:"", parent: parentName||"", is_group:0, bs_item:1, opening:"", bal_type:"Debit", notes:"" });
        drawerOpen.value = true;
      }

      function openEdit(acctName) {
        const a = allAccounts.value.find(x => x.name === acctName);
        if (!a) return;
        editingName.value = acctName;
        Object.assign(form, {
          name: a.account_name || a.name,
          code: a.code || "",
          root_type: a.root_type || "",
          account_type: a.account_type || "",
          parent: a.parent || "",
          is_group: a.is_group ? 1 : 0,
          bs_item: ["Asset","Liability","Equity"].includes(a.root_type) ? 1 : 0,
          opening: a.opening || "",
          bal_type: a.bal_type || "Debit",
          notes: a.notes || ""
        });
        drawerOpen.value = true;
      }

      async function saveAccount() {
        if (!form.name.trim()) { toast("Account name is required", "error"); return; }
        if (!form.root_type) { toast("Root Type is required", "error"); return; }
        drawerSaving.value = true;
        try {
          const payload = {
            account_name: form.name.trim(),
            account_number: form.code.trim(),
            root_type: form.root_type,
            account_type: form.account_type,
            parent_account: form.parent || "",
            is_group: form.is_group ? 1 : 0,
            opening_balance: flt(form.opening),
            balance_must_be: form.bal_type,
          };
          if (editingName.value) {
            // Edit via custom API
            try {
              await apiPOST("zoho_books_clone.api.books_data.save_account", { op: "update", name: editingName.value, ...payload });
            } catch(e) {
              toast(e.message || "Frappe update failed", "error");
            }
            const idx = allAccounts.value.findIndex(x => x.name === editingName.value);
            if (idx >= 0) {
              allAccounts.value[idx] = { ...allAccounts.value[idx], account_name: form.name.trim(), code: form.code.trim(), root_type: form.root_type, account_type: form.account_type, parent: form.parent, is_group: form.is_group ? 1 : 0, opening: flt(form.opening), bal_type: form.bal_type, notes: form.notes };
            }
            toast("Account updated", "success");
          } else {
            // Create via custom API
            let newName = form.name.trim();
            try {
              const res = await apiPOST("zoho_books_clone.api.books_data.save_account", { op: "create", ...payload });
              if (res && res.name) newName = res.name;
            } catch(e) {
              toast(e.message || "Frappe create failed", "error");
            }
            allAccounts.value.push({ name: newName, account_name: form.name.trim(), code: form.code.trim(), root_type: form.root_type, account_type: form.account_type, parent: form.parent, is_group: form.is_group ? 1 : 0, opening: flt(form.opening), bal_type: form.bal_type, notes: form.notes, source: "frappe" });
            if (form.is_group) { expandedGroups.value.add(newName); expandTick.value++; }
            toast("Account created", "success");
          }
          drawerOpen.value = false;
          // Reload from Frappe to get the canonical tree order
          await load();
        } catch(e) {
          toast(e.message || "Save failed", "error");
        } finally {
          drawerSaving.value = false;
        }
      }

      function confirmDelete(name) {
        deleteTarget.value = name;
        showDel.value = true;
      }

      async function doDelete() {
        const name = deleteTarget.value;
        try {
          await apiPOST("zoho_books_clone.api.books_data.save_account", { op: "delete", name });
        } catch(e) {
          toast(e.message || "Delete failed in Frappe", "error");
        }
        allAccounts.value = allAccounts.value.filter(a => a.name !== name && a.parent !== name);
        expandTick.value++;
        showDel.value = false;
        deleteTarget.value = null;
        toast("Account deleted", "success");
        await load();
      }

      onMounted(load);

      return { allAccounts, loading, typeFilter, searchQ, expandedGroups, expandTick, typeStats, flatTree, accountTypeOptions, parentOptions, form, drawerOpen, editingName, drawerSaving, showDel, deleteTarget, toggleGroup, expandAll, collapseAll, hasChildren, fmtINR, load, openAdd, openEdit, saveAccount, confirmDelete, doDelete, icon, fmt, TYPE_META_COA };
    },
    template: `
<div class="b-page coa-page">

  <!-- Type Summary Strip -->
  <div class="coa-type-strip">
    <div v-for="s in typeStats" :key="s.type"
      class="coa-type-card"
      :class="{active: typeFilter===s.type}"
      :style="'border-left-color:'+s.meta.color+(typeFilter===s.type?';background:'+s.meta.bg:'')"
      @click="typeFilter = typeFilter===s.type?'':s.type">
      <div class="coa-type-lbl" :style="'color:'+s.meta.color">{{s.type}}</div>
      <div class="coa-type-val" :style="'color:'+s.meta.color">{{s.count}}</div>
      <div class="coa-type-sub">{{s.meta.dr?'Normally Dr':'Normally Cr'}} · {{s.total?fmtINR(s.total):'No opening'}}</div>
    </div>
  </div>

  <!-- Action bar -->
  <div class="b-action-bar" style="margin-bottom:14px">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <div class="b-search" style="border-radius:20px;padding:6px 12px">
        <span v-html="icon('search',13)"></span>
        <input v-model="searchQ" placeholder="Search account name or code..." style="border:none;outline:none;font-size:13px;background:transparent;width:220px"/>
      </div>
      <button class="b-btn b-btn-ghost" @click="expandAll"><span v-html="icon('chevD',13)"></span> Expand All</button>
      <button class="b-btn b-btn-ghost" @click="collapseAll"><span v-html="icon('chevR',13)"></span> Collapse All</button>
      <button class="b-btn b-btn-ghost" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
    </div>
    <button class="b-btn b-btn-primary" @click="openAdd()"><span v-html="icon('plus',13)"></span> Add Account</button>
  </div>

  <!-- Tree Table -->
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table coa-tbl">
      <thead>
        <tr>
          <th style="width:44%">Account Name</th>
          <th>Type</th>
          <th>Account No.</th>
          <th class="ta-r">Opening Balance</th>
          <th class="ta-r">Balance Type</th>
          <th style="text-align:center;width:90px">Actions</th>
        </tr>
      </thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n">
            <td colspan="6" style="padding:12px 14px"><div class="b-shimmer" style="height:12px"></div></td>
          </tr>
        </template>
        <template v-else-if="flatTree.length===0">
          <tr><td colspan="6" class="b-empty">No accounts found</td></tr>
        </template>
        <template v-else>
          <tr v-for="row in flatTree" :key="row.name"
            class="coa-row"
            :class="row.is_group?'coa-group-row':'coa-leaf-row'"
            @click="openEdit(row.name)">
            <td>
              <div class="coa-tree-cell" :style="'padding-left:'+(14+row.depth*22)+'px'">
                <button v-if="row.is_group && hasChildren(row.name)"
                  class="coa-toggle" :class="{open: expandedGroups.has(row.name)}"
                  @click.stop="toggleGroup(row.name)">
                  <span v-html="icon('chevR',12)"></span>
                </button>
                <span v-else style="width:18px;flex-shrink:0;display:inline-block"></span>
                <span class="coa-dot" :style="'background:'+(TYPE_META_COA[row.root_type]||TYPE_META_COA.Asset).color+';margin-left:6px'"></span>
                <span class="coa-acct-name" :class="{'fw-700':row.is_group}">{{row.account_name||row.name}}</span>
                <span v-if="row.is_group" class="coa-group-chip" :style="'background:'+(TYPE_META_COA[row.root_type]||TYPE_META_COA.Asset).bg+';color:'+(TYPE_META_COA[row.root_type]||TYPE_META_COA.Asset).color">Group</span>
                <span v-if="row.account_type" class="coa-acct-type">{{row.account_type}}</span>
              </div>
            </td>
            <td style="padding:9px 14px">
              <span class="b-badge" :style="'background:'+(TYPE_META_COA[row.root_type]||TYPE_META_COA.Asset).bg+';color:'+(TYPE_META_COA[row.root_type]||TYPE_META_COA.Asset).color">{{row.root_type}}</span>
            </td>
            <td style="padding:9px 14px;font-family:monospace;font-size:12px;color:#868e96">{{row.code||'—'}}</td>
            <td class="ta-r" style="padding:9px 14px;font-family:monospace;font-weight:600" :class="row.opening>0?(row.bal_type==='Debit'?'coa-dr':'coa-cr'):'c-muted'">{{fmtINR(row.opening)}}</td>
            <td class="ta-r" style="padding:9px 14px;font-size:12px;color:#868e96">{{row.opening?row.bal_type:'—'}}</td>
            <td style="text-align:center;padding:8px 14px">
              <div style="display:flex;gap:4px;justify-content:center">
                <button class="b-icon-btn" @click.stop="openEdit(row.name)" title="Edit"><span v-html="icon('edit',14)"></span></button>
                <button v-if="row.source!=='frappe'" class="b-icon-btn danger" @click.stop="confirmDelete(row.name)" title="Delete"><span v-html="icon('trash',14)"></span></button>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
  <div style="text-align:right;font-size:12px;color:#868e96;padding:6px 4px">{{flatTree.length}} account(s)</div>

  <!-- Add/Edit Drawer -->
  <transition name="nim-overlay">
    <div v-if="drawerOpen" class="coa-drawer-bg" @click.self="drawerOpen=false">
      <div class="coa-drawer-panel">
        <div class="coa-dh">
          <div><div class="coa-dh-title">{{editingName?'Edit Account':'Add Account'}}</div>
          <div class="coa-dh-sub">{{editingName?'Update account details':'Create a new account in the chart'}}</div></div>
          <button class="coa-dclose" @click="drawerOpen=false"><span v-html="icon('x',16)"></span></button>
        </div>
        <div class="coa-dbody">
          <div class="coa-info-box">
            <span v-html="icon('info',14)"></span>
            <span>Group accounts can have child accounts. Ledger accounts record actual transactions.</span>
          </div>

          <span class="coa-sec-lbl">Account Details</span>
          <div class="coa-fg coa-fg2">
            <div style="grid-column:1/3">
              <label class="coa-lbl">Account Name <span style="color:#c92a2a">*</span></label>
              <input v-model="form.name" class="coa-fi" placeholder="e.g. Cash in Hand, Sales Revenue"/>
            </div>
            <div>
              <label class="coa-lbl">Account Number</label>
              <input v-model="form.code" class="coa-fi" placeholder="e.g. 1001, 4001"/>
            </div>
            <div>
              <label class="coa-lbl">Root Type <span style="color:#c92a2a">*</span></label>
              <select v-model="form.root_type" class="coa-fi" @change="form.account_type=''">
                <option value="">— Select —</option>
                <option value="Asset">Asset</option>
                <option value="Liability">Liability</option>
                <option value="Equity">Equity</option>
                <option value="Income">Income</option>
                <option value="Expense">Expense</option>
              </select>
            </div>
            <div>
              <label class="coa-lbl">Account Type</label>
              <select v-model="form.account_type" class="coa-fi">
                <option value="">— General —</option>
                <option v-for="t in accountTypeOptions" :key="t" :value="t">{{t}}</option>
              </select>
            </div>
            <div>
              <label class="coa-lbl">Parent Account</label>
              <searchable-select v-model="form.parent" :options="parentOptions" value-key="name" label-key="account_name" placeholder="— Root level —"/>
            </div>
          </div>

          <div class="coa-fg coa-fg2" style="margin-top:0">
            <div>
              <label class="coa-lbl">Is Group Account?</label>
              <div style="display:flex;align-items:center;gap:14px;margin-top:8px">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
                  <input type="radio" v-model="form.is_group" :value="1" style="accent-color:#3b5bdb"/> Yes
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
                  <input type="radio" v-model="form.is_group" :value="0" style="accent-color:#3b5bdb"/> No
                </label>
              </div>
            </div>
            <div>
              <label class="coa-lbl">Balance Sheet Item?</label>
              <select v-model="form.bs_item" class="coa-fi">
                <option :value="1">Yes (Balance Sheet)</option>
                <option :value="0">No (P&amp;L)</option>
              </select>
            </div>
          </div>

          <span class="coa-sec-lbl">Opening Balance</span>
          <div class="coa-fg coa-fg2">
            <div>
              <label class="coa-lbl">Opening Balance (₹)</label>
              <input v-model="form.opening" type="number" min="0" step="0.01" class="coa-fi" placeholder="0.00" style="font-family:monospace"/>
            </div>
            <div>
              <label class="coa-lbl">Balance Type</label>
              <select v-model="form.bal_type" class="coa-fi">
                <option value="Debit">Debit (Dr)</option>
                <option value="Credit">Credit (Cr)</option>
              </select>
            </div>
          </div>

          <div>
            <label class="coa-lbl">Description / Notes</label>
            <textarea v-model="form.notes" class="coa-fi" rows="2" style="resize:vertical" placeholder="Optional description..."></textarea>
          </div>
        </div>
        <div class="coa-dfooter">
          <button class="b-btn b-btn-ghost" @click="drawerOpen=false">Cancel</button>
          <button class="b-btn b-btn-primary" @click="saveAccount" :disabled="drawerSaving" style="min-width:130px">
            {{drawerSaving?'Saving…':'Save Account'}}
          </button>
        </div>
      </div>
    </div>
  </transition>

  <!-- Delete Confirm -->
  <transition name="nim-overlay">
    <div v-if="showDel" class="coa-drawer-bg" @click.self="showDel=false" style="justify-content:center;align-items:center">
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:420px;width:100%;border:1px solid #e2e8f0">
        <div style="font-size:17px;font-weight:700;margin-bottom:8px">Delete Account?</div>
        <div style="font-size:14px;color:#868e96;margin-bottom:24px;line-height:1.5">
          <strong>{{deleteTarget}}</strong> and all its child accounts will be permanently removed from local data.
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button @click="showDel=false" class="b-btn b-btn-ghost">Keep It</button>
          <button @click="doDelete" class="b-btn" style="background:#c92a2a;color:#fff;border-color:#c92a2a">Yes, Delete</button>
        </div>
      </div>
    </div>
  </transition>
</div>`
  });

  /* ══════════════════════════════════════════════════
     JOURNAL ENTRIES
  ══════════════════════════════════════════════════ */
  const JE_TEMPLATES = [
    { id:"depreciation", name:"Depreciation",      desc:"Monthly asset depreciation posting",
      lines:[{account:"Depreciation",dr:0,cr:0,type:"Debit"},{account:"Accumulated Depreciation",dr:0,cr:0,type:"Credit"}] },
    { id:"salary",       name:"Salary Accrual",    desc:"Record salary expense before payment",
      lines:[{account:"Salaries & Wages",dr:0,cr:0,type:"Debit"},{account:"Salary Payable",dr:0,cr:0,type:"Credit"}] },
    { id:"bank-charge",  name:"Bank Charges",      desc:"Bank processing / service fee",
      lines:[{account:"Bank Charges",dr:0,cr:0,type:"Debit"},{account:"HDFC Current Account",dr:0,cr:0,type:"Credit"}] },
    { id:"gst-payment",  name:"GST Payment",        desc:"Pay GST liability to government",
      lines:[{account:"CGST Payable",dr:0,cr:0,type:"Debit"},{account:"SGST Payable",dr:0,cr:0,type:"Debit"},{account:"HDFC Current Account",dr:0,cr:0,type:"Credit"}] },
    { id:"prepaid",      name:"Prepaid Expense",   desc:"Advance payment treated as asset",
      lines:[{account:"Prepaid Expenses",dr:0,cr:0,type:"Debit"},{account:"HDFC Current Account",dr:0,cr:0,type:"Credit"}] },
    { id:"provision",    name:"Bad Debt Provision",desc:"Provision for doubtful receivables",
      lines:[{account:"Bad Debt Expense",dr:0,cr:0,type:"Debit"},{account:"Provision for Bad Debts",dr:0,cr:0,type:"Credit"}] },
  ];
  const JE_TYPE_COLOR = { "Journal Entry":"je-type-info","Depreciation":"je-type-muted","Accrual":"je-type-info","Prepaid":"je-type-info","Provision":"je-type-muted","Contra":"je-type-muted","Rectification":"je-type-muted","Opening Entry":"je-type-info" };
  const JE_STATUS_COLOR = { Draft:"je-s-draft", Submitted:"je-s-submitted", Cancelled:"je-s-cancelled" };

  const JournalEntries = defineComponent({
    name: "JournalEntries",
    setup() {
      const allEntries = ref([]);
      const accounts = ref([]);
      const costCenters = ref([]);
      const loading = ref(true);
      const currentFilter = ref("all");
      const searchQ = ref("");
      const dateFrom = ref("");
      const dateTo = ref("");

      // New/Edit drawer
      const drawerOpen = ref(false);
      const editingName = ref(null);
      const drawerSaving = ref(false);
      const selectedTpl = ref("");
      const form = reactive({ date: "", type: "Journal Entry", ref: "", cheque_date: "", narration: "", cost_center: "", status: "Draft" });
      const lines = ref([]);

      // View drawer
      const viewOpen = ref(false);
      const viewEntry = ref(null);

      // Confirm modal
      const showConf = ref(false);
      const confTarget = ref(null);
      const confType = ref(""); // 'delete' | 'cancel'

      const todayStr = () => new Date().toISOString().slice(0, 10);
      const thisMonth = (d) => { const n = new Date(); return (d||"").startsWith(n.getFullYear() + "-" + String(n.getMonth()+1).padStart(2,"0")); };

      function fmtINR(v) {
        if (!v && v !== 0) return "—";
        const n = Number(v); if (n === 0) return "—";
        return "₹" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2 });
      }
      function fmtDate(d) {
        if (!d) return "—";
        try { return new Date(d).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" }); } catch { return d; }
      }
      function nextNum() {
        const nums = allEntries.value.map(x => parseInt((x.name||"JE-0").replace(/\D/g,""))||0);
        return "JE-" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
      }

      const summary = computed(() => {
        const month = allEntries.value.filter(e => thisMonth(e.date));
        const drafts = allEntries.value.filter(e => e.status === "Draft");
        const totalDr = allEntries.value.filter(e => e.status === "Submitted").reduce((s,e) => s + Number(e.total_debit||0), 0);
        return { total: allEntries.value.length, month: month.length, totalDr, drafts: drafts.length };
      });

      const counts = computed(() => ({
        Draft: allEntries.value.filter(e => e.status === "Draft").length,
        Submitted: allEntries.value.filter(e => e.status === "Submitted").length,
        Cancelled: allEntries.value.filter(e => e.status === "Cancelled").length,
      }));

      const filteredRows = computed(() => {
        const q = searchQ.value.toLowerCase();
        let r = currentFilter.value === "all" ? allEntries.value : allEntries.value.filter(e => e.status === currentFilter.value);
        if (dateFrom.value) r = r.filter(e => e.date && e.date >= dateFrom.value);
        if (dateTo.value) r = r.filter(e => e.date && e.date <= dateTo.value);
        if (q) r = r.filter(e => (e.name + e.narration + (e.type||"")).toLowerCase().includes(q));
        return r;
      });

      const totalDr = computed(() => lines.value.reduce((s,l) => s + flt(l.dr), 0));
      const totalCr = computed(() => lines.value.reduce((s,l) => s + flt(l.cr), 0));
      const balanced = computed(() => Math.abs(totalDr.value - totalCr.value) < 0.01);

      async function load() {
        loading.value = true;
        try {
          let frappeEntries = [];
          try {
            frappeEntries = await apiList("Journal Entry", {
              fields: ["name","posting_date","voucher_type","user_remark","total_debit","total_credit","docstatus"],
              order: "posting_date desc", limit: 300
            });
          } catch {}

          if (frappeEntries && frappeEntries.length) {
            allEntries.value = frappeEntries.map(e => ({
              name: e.name, date: e.posting_date, type: e.voucher_type || "Journal Entry",
              narration: e.user_remark || "", total_debit: e.total_debit || 0,
              total_credit: e.total_credit || 0,
              status: e.docstatus === 1 ? "Submitted" : e.docstatus === 2 ? "Cancelled" : "Draft",
              lines: [], source: "frappe"
            }));
          } else {
            try { allEntries.value = JSON.parse(localStorage.getItem("books_journal_entries") || "[]"); } catch { allEntries.value = []; }
          }

          // Load accounts for dropdowns - from COA localStorage or Frappe
          try {
            const accts = await apiList("Account", { fields: ["name","account_name","root_type"], filters: [["is_group","=",0],["disabled","=",0]], limit: 500 });
            accounts.value = accts.map(a => a.name || a.account_name);
          } catch {
            try {
              const coa = JSON.parse(localStorage.getItem("books_coa") || "[]");
              accounts.value = coa.filter(a => !a.is_group).map(a => a.account_name || a.name);
            } catch {}
          }
          if (!accounts.value.length) {
            accounts.value = STANDARD_COA_DATA.filter(a => !a.is_group).map(a => a.name);
          }

          try {
            const cc = await apiList("Cost Center", { fields: ["name"], filters: [["is_group","=",0]], limit: 100 });
            costCenters.value = cc.map(c => c.name);
          } catch {}
        } finally {
          loading.value = false;
        }
      }

      function openAdd() {
        editingName.value = null;
        selectedTpl.value = "";
        lines.value = [
          { id: Date.now(), account: "", party: "", cost_center: "", dr: "", cr: "", type: "Debit" },
          { id: Date.now()+1, account: "", party: "", cost_center: "", dr: "", cr: "", type: "Credit" },
        ];
        Object.assign(form, { date: todayStr(), type: "Journal Entry", ref: "", cheque_date: "", narration: "", cost_center: "", status: "Draft" });
        drawerOpen.value = true;
      }

      function openEdit(name) {
        const e = allEntries.value.find(x => x.name === name);
        if (!e || e.status !== "Draft") return;
        editingName.value = name;
        selectedTpl.value = "";
        Object.assign(form, { date: e.date || todayStr(), type: e.type || "Journal Entry", ref: e.ref || "", cheque_date: e.cheque_date || "", narration: e.narration || "", cost_center: e.cost_center || "", status: e.status || "Draft" });
        lines.value = (e.lines && e.lines.length) ? e.lines.map((l,i) => ({ ...l, id: Date.now()+i })) : [
          { id: Date.now(), account: "", party: "", cost_center: "", dr: "", cr: "", type: "Debit" },
          { id: Date.now()+1, account: "", party: "", cost_center: "", dr: "", cr: "", type: "Credit" },
        ];
        drawerOpen.value = true;
      }

      function openView(name) {
        viewEntry.value = allEntries.value.find(x => x.name === name) || null;
        viewOpen.value = true;
      }

      function applyTemplate(tplId) {
        const tpl = JE_TEMPLATES.find(t => t.id === tplId);
        if (!tpl) return;
        selectedTpl.value = selectedTpl.value === tplId ? "" : tplId;
        if (selectedTpl.value) {
          lines.value = tpl.lines.map((l,i) => ({ id: Date.now()+i, account: l.account, party: "", cost_center: "", dr: l.type==="Debit"?l.dr:"", cr: l.type==="Credit"?l.cr:"", type: l.type }));
          form.narration = tpl.name + " — " + new Date().toLocaleDateString("en-IN", { month:"short", year:"numeric" });
        }
      }

      function addLine(type) {
        lines.value.push({ id: Date.now(), account: "", party: "", cost_center: "", dr: type==="Debit"?"0":"", cr: type==="Credit"?"0":"", type });
      }

      function removeLine(id) {
        if (lines.value.length <= 1) return;
        lines.value = lines.value.filter(l => l.id !== id);
      }

      async function saveEntry(status) {
        if (!form.date) { toast("Date is required", "error"); return; }
        if (!form.narration.trim()) { toast("Narration is required", "error"); return; }
        const hasLines = lines.value.some(l => l.account && (flt(l.dr) > 0 || flt(l.cr) > 0));
        if (!hasLines) { toast("Add at least one line with an account and amount", "error"); return; }
        if (!balanced.value) { toast("Total debits must equal total credits", "error"); return; }
        drawerSaving.value = true;
        try {
          const payload = {
            posting_date: form.date,
            voucher_type: form.type,
            cheque_no: form.ref,
            cheque_date: form.cheque_date || null,
            user_remark: form.narration,
            accounts: lines.value.filter(l => l.account).map(l => ({
              account: l.account,
              party: l.party || null,
              cost_center: l.cost_center || form.cost_center || null,
              debit_in_account_currency: flt(l.dr),
              credit_in_account_currency: flt(l.cr),
            })),
            docstatus: status === "Submitted" ? 1 : 0,
          };
          const lineItems = lines.value.filter(l => l.account);
          const totDr = lineItems.reduce((s,l) => s + flt(l.dr), 0);
          const totCr = lineItems.reduce((s,l) => s + flt(l.cr), 0);

          if (editingName.value) {
            try { await apiPOST("frappe.client.set_value", { doctype:"Journal Entry", name: editingName.value, fieldname: JSON.stringify(payload) }); } catch {}
            const idx = allEntries.value.findIndex(x => x.name === editingName.value);
            if (idx >= 0) allEntries.value[idx] = { ...allEntries.value[idx], date: form.date, type: form.type, narration: form.narration, total_debit: totDr, total_credit: totCr, status, lines: lineItems, ref: form.ref, cheque_date: form.cheque_date, cost_center: form.cost_center };
            toast("Journal entry updated", "success");
          } else {
            const name = nextNum();
            try { await apiPOST("frappe.client.insert", { doc: JSON.stringify({ doctype:"Journal Entry", name, ...payload }) }); } catch {}
            allEntries.value.unshift({ name, date: form.date, type: form.type, narration: form.narration, total_debit: totDr, total_credit: totCr, status, lines: lineItems, ref: form.ref, cheque_date: form.cheque_date, cost_center: form.cost_center, source: "local" });
            toast("Journal entry created", "success");
          }
          try { localStorage.setItem("books_journal_entries", JSON.stringify(allEntries.value)); } catch {}
          drawerOpen.value = false;
        } catch(e) {
          toast(e.message || "Save failed", "error");
        } finally {
          drawerSaving.value = false;
        }
      }

      function confirmAction(name, type) {
        confTarget.value = name;
        confType.value = type;
        showConf.value = true;
      }

      function doAction() {
        const name = confTarget.value;
        if (confType.value === "delete") {
          allEntries.value = allEntries.value.filter(e => e.name !== name);
          toast("Entry deleted", "success");
        } else if (confType.value === "cancel") {
          const idx = allEntries.value.findIndex(e => e.name === name);
          if (idx >= 0) allEntries.value[idx] = { ...allEntries.value[idx], status: "Cancelled" };
          toast("Entry cancelled", "success");
        }
        try { localStorage.setItem("books_journal_entries", JSON.stringify(allEntries.value)); } catch {}
        showConf.value = false;
        confTarget.value = null;
      }

      onMounted(load);

      return { allEntries, accounts, costCenters, loading, currentFilter, searchQ, dateFrom, dateTo, filteredRows, summary, counts, drawerOpen, editingName, drawerSaving, selectedTpl, form, lines, totalDr, totalCr, balanced, viewOpen, viewEntry, showConf, confTarget, confType, JE_TEMPLATES, JE_TYPE_COLOR, JE_STATUS_COLOR, load, openAdd, openEdit, openView, applyTemplate, addLine, removeLine, saveEntry, confirmAction, doAction, fmtINR, fmtDate, flt, icon };
    },
    template: `
<div class="b-page jen-page">

  <!-- Info banner -->
  <div class="jen-info-banner">
    <span v-html="icon('info',15)" style="flex-shrink:0"></span>
    <span>Journal entries record any financial transaction not covered by Sales/Purchase. Total <strong>Debits must equal Credits</strong> in every entry.</span>
  </div>

  <!-- Summary strip -->
  <div class="jen-sum-strip">
    <div class="jen-sum-card">
      <div class="jen-sum-lbl">Total Entries</div>
      <div class="jen-sum-val">{{summary.total}}</div>
    </div>
    <div class="jen-sum-card">
      <div class="jen-sum-lbl" style="color:#3b5bdb">This Month</div>
      <div class="jen-sum-val" style="color:#3b5bdb">{{summary.month}}</div>
    </div>
    <div class="jen-sum-card">
      <div class="jen-sum-lbl" style="color:#2f9e44">Total Debits</div>
      <div class="jen-sum-val" style="color:#2f9e44">{{summary.totalDr>=1000?'₹'+(summary.totalDr/1000).toFixed(1)+'K':fmtINR(summary.totalDr)||'₹0'}}</div>
    </div>
    <div class="jen-sum-card">
      <div class="jen-sum-lbl" style="color:#c92a2a">Drafts</div>
      <div class="jen-sum-val" style="color:#c92a2a">{{summary.drafts}}</div>
    </div>
  </div>

  <!-- Action bar -->
  <div class="b-action-bar" style="margin-bottom:14px;flex-wrap:wrap;gap:10px">
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="jen-pill" :class="{active:currentFilter==='all'}" @click="currentFilter='all'">All</button>
      <button class="jen-pill" :class="{active:currentFilter==='Draft'}" @click="currentFilter='Draft'">
        Draft <span class="jen-pc" style="background:#f1f3f5;color:#868e96">{{counts.Draft}}</span>
      </button>
      <button class="jen-pill" :class="{active:currentFilter==='Submitted'}" @click="currentFilter='Submitted'">
        Submitted <span class="jen-pc" style="background:#ebfbee;color:#2f9e44">{{counts.Submitted}}</span>
      </button>
      <button class="jen-pill" :class="{active:currentFilter==='Cancelled'}" @click="currentFilter='Cancelled'">
        Cancelled <span class="jen-pc" style="background:#ffe3e3;color:#c92a2a">{{counts.Cancelled}}</span>
      </button>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:#868e96">
        <span>From</span>
        <input type="date" v-model="dateFrom" class="jen-date-input"/>
        <span>To</span>
        <input type="date" v-model="dateTo" class="jen-date-input"/>
      </div>
      <div class="b-search" style="border-radius:20px;padding:6px 12px">
        <span v-html="icon('search',13)"></span>
        <input v-model="searchQ" placeholder="Search JE, narration..." style="border:none;outline:none;font-size:13px;background:transparent;width:180px"/>
      </div>
      <button class="b-btn b-btn-ghost" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="b-btn b-btn-primary" @click="openAdd"><span v-html="icon('plus',13)"></span> New Entry</button>
    </div>
  </div>

  <!-- Table -->
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead>
        <tr>
          <th>Entry #</th><th>Date</th><th>Type</th><th>Narration</th>
          <th class="ta-r">Total Debit</th><th class="ta-r">Total Credit</th>
          <th>Lines</th><th>Status</th>
          <th style="text-align:center;width:100px">Actions</th>
        </tr>
      </thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 6" :key="n"><td colspan="9" style="padding:12px 14px"><div class="b-shimmer" style="height:12px"></div></td></tr>
        </template>
        <template v-else-if="filteredRows.length===0">
          <tr><td colspan="9" class="b-empty">
            <div style="font-size:32px;margin-bottom:8px">📄</div>
            <div style="font-weight:600;margin-bottom:4px">{{searchQ?'No entries match':'No journal entries yet'}}</div>
            <div style="font-size:13px;color:#868e96;margin-bottom:12px">{{searchQ?'Try a different search':'Record adjustments, depreciation, accruals and more'}}</div>
            <button v-if="!searchQ" class="b-btn b-btn-primary" @click="openAdd"><span v-html="icon('plus',13)"></span> New Entry</button>
          </td></tr>
        </template>
        <template v-else>
          <tr v-for="e in filteredRows" :key="e.name" class="clickable" @click="openView(e.name)">
            <td style="font-family:monospace;font-size:12px;font-weight:700;color:#2563eb">{{e.name}}</td>
            <td style="font-size:12.5px;color:#868e96">{{fmtDate(e.date)}}</td>
            <td><span class="b-badge" :class="JE_TYPE_COLOR[e.type]||'je-type-info'">{{e.type||'Journal Entry'}}</span></td>
            <td style="font-size:13px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{e.narration||'—'}}</td>
            <td class="ta-r" style="font-family:monospace;font-weight:600;color:#c92a2a">{{fmtINR(e.total_debit)}}</td>
            <td class="ta-r" style="font-family:monospace;font-weight:600;color:#2f9e44">{{fmtINR(e.total_credit)}}</td>
            <td style="font-size:12px;color:#868e96">{{(e.lines||[]).length||'—'}}</td>
            <td><span class="b-badge" :class="JE_STATUS_COLOR[e.status]||'je-s-draft'">{{e.status}}</span></td>
            <td style="text-align:center">
              <div style="display:flex;gap:4px;justify-content:center">
                <button class="b-icon-btn" @click.stop="openView(e.name)" title="View"><span v-html="icon('eye',14)"></span></button>
                <button v-if="e.status==='Draft'" class="b-icon-btn" @click.stop="openEdit(e.name)" title="Edit"><span v-html="icon('edit',14)"></span></button>
                <button v-if="e.status==='Draft'" class="b-icon-btn danger" @click.stop="confirmAction(e.name,'delete')" title="Delete"><span v-html="icon('trash',14)"></span></button>
                <button v-if="e.status==='Submitted'" class="b-icon-btn danger" @click.stop="confirmAction(e.name,'cancel')" title="Cancel"><span v-html="icon('cancel',14)"></span></button>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
  <div style="text-align:right;font-size:12px;color:#868e96;padding:6px 4px">Showing {{filteredRows.length}} of {{allEntries.length}} entries</div>

  <!-- New/Edit Drawer -->
  <transition name="nim-overlay">
    <div v-if="drawerOpen" class="coa-drawer-bg" @click.self="drawerOpen=false">
      <div class="jen-drawer-panel">
        <div class="coa-dh">
          <div><div class="coa-dh-title">{{editingName?'Edit Journal Entry':'New Journal Entry'}}</div>
          <div class="coa-dh-sub">Debits must equal Credits</div></div>
          <button class="coa-dclose" @click="drawerOpen=false"><span v-html="icon('x',16)"></span></button>
        </div>
        <div class="coa-dbody">

          <!-- Quick Templates -->
          <span class="coa-sec-lbl" style="margin-top:0;border-top:none;padding-top:0">Quick Template <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></span>
          <div class="jen-tpl-grid">
            <div v-for="tpl in JE_TEMPLATES" :key="tpl.id"
              class="jen-tpl-card" :class="{selected:selectedTpl===tpl.id}"
              @click="applyTemplate(tpl.id)">
              <div class="jen-tpl-name">{{tpl.name}}</div>
              <div class="jen-tpl-desc">{{tpl.desc}}</div>
            </div>
          </div>

          <!-- Entry Details -->
          <span class="coa-sec-lbl">Entry Details</span>
          <div class="coa-fg jen-fg4">
            <div>
              <label class="coa-lbl">Date <span style="color:#c92a2a">*</span></label>
              <input v-model="form.date" type="date" class="coa-fi"/>
            </div>
            <div>
              <label class="coa-lbl">Entry Type</label>
              <select v-model="form.type" class="coa-fi">
                <option value="Journal Entry">Journal Entry</option>
                <option value="Depreciation">Depreciation</option>
                <option value="Accrual">Accrual Entry</option>
                <option value="Prepaid">Prepaid Expense</option>
                <option value="Provision">Provision Entry</option>
                <option value="Contra">Contra Entry</option>
                <option value="Rectification">Rectification Entry</option>
                <option value="Opening Entry">Opening Entry</option>
              </select>
            </div>
            <div>
              <label class="coa-lbl">Cheque / Ref No.</label>
              <input v-model="form.ref" class="coa-fi" placeholder="Optional reference"/>
            </div>
            <div>
              <label class="coa-lbl">Cheque Date</label>
              <input v-model="form.cheque_date" type="date" class="coa-fi"/>
            </div>
          </div>
          <div style="margin-bottom:16px">
            <label class="coa-lbl">Narration <span style="color:#c92a2a">*</span></label>
            <textarea v-model="form.narration" class="coa-fi" rows="2" style="resize:vertical" placeholder="Describe this journal entry — e.g. Depreciation for March 2026..."></textarea>
          </div>

          <!-- Lines header -->
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <span style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868e96">Lines</span>
            <div style="display:flex;gap:8px">
              <button @click="addLine('Debit')" class="jen-add-line-btn" style="border-color:rgba(201,42,42,.3);color:#c92a2a">
                <span v-html="icon('plus',12)"></span> Debit Row
              </button>
              <button @click="addLine('Credit')" class="jen-add-line-btn" style="border-color:rgba(47,158,68,.3);color:#2f9e44">
                <span v-html="icon('plus',12)"></span> Credit Row
              </button>
            </div>
          </div>

          <!-- Balance indicator -->
          <div class="jen-balance-bar" :class="lines.length&&(totalDr>0||totalCr>0)?(balanced?'jen-bal-ok':'jen-bal-err'):'jen-bal-zero'">
            <div style="display:flex;align-items:center;gap:8px">
              <span v-html="icon(balanced&&(totalDr>0)?'check':'info',14)"></span>
              <span>{{!lines.length||(totalDr===0&&totalCr===0)?'Add debit and credit lines':balanced?'Balanced — ready to post':'Difference: ₹'+Math.abs(totalDr-totalCr).toLocaleString('en-IN',{minimumFractionDigits:2})}}</span>
            </div>
            <div style="font-family:monospace;font-weight:700">
              <span v-if="totalDr>0||totalCr>0">Dr: ₹{{totalDr.toLocaleString('en-IN',{minimumFractionDigits:2})}} / Cr: ₹{{totalCr.toLocaleString('en-IN',{minimumFractionDigits:2})}}</span>
            </div>
          </div>

          <!-- Lines table -->
          <div style="border:1px solid #e8ecf0;border-radius:8px;overflow:hidden;margin-bottom:16px;overflow-x:auto">
            <table class="jen-lines-tbl" style="min-width:680px">
              <thead>
                <tr>
                  <th style="width:28%">Account <span style="color:#c92a2a">*</span></th>
                  <th style="width:20%">Party (Customer/Vendor)</th>
                  <th style="width:15%">Cost Center</th>
                  <th style="width:13%;text-align:right">Debit (Dr)</th>
                  <th style="width:13%;text-align:right">Credit (Cr)</th>
                  <th style="width:7%">Type</th>
                  <th style="width:4%"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="line in lines" :key="line.id">
                  <td>
                    <searchable-select v-model="line.account" :options="accounts" placeholder="— Select Account —" :compact="true" class="ss-cell-wrap"/>
                  </td>
                  <td><input v-model="line.party" class="jen-ci" placeholder="Optional"/></td>
                  <td>
                    <select v-model="line.cost_center" class="jen-ci">
                      <option value="">—</option>
                      <option v-for="cc in costCenters" :key="cc" :value="cc">{{cc}}</option>
                    </select>
                  </td>
                  <td><input v-model="line.dr" type="number" min="0" step="0.01" class="jen-ci" style="text-align:right" placeholder="0.00" @input="line.cr=''"/></td>
                  <td><input v-model="line.cr" type="number" min="0" step="0.01" class="jen-ci" style="text-align:right" placeholder="0.00" @input="line.dr=''"/></td>
                  <td style="font-size:11px;color:#868e96;padding:0 6px">{{flt(line.dr)>0?'Dr':flt(line.cr)>0?'Cr':'—'}}</td>
                  <td style="padding:4px 6px">
                    <button @click="removeLine(line.id)" class="b-icon-btn danger" style="padding:3px 5px"><span v-html="icon('x',12)"></span></button>
                  </td>
                </tr>
                <tr v-if="!lines.length">
                  <td colspan="7" style="text-align:center;padding:20px;color:#868e96;font-size:13px">No lines — click Debit Row or Credit Row to add</td>
                </tr>
                <tr class="jen-total-row">
                  <td colspan="3" style="padding:8px 10px;font-size:12px;font-weight:700;color:#868e96;text-transform:uppercase;letter-spacing:.04em">Totals</td>
                  <td style="text-align:right;padding:8px 10px;font-family:monospace;font-weight:700;color:#c92a2a">₹{{totalDr.toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                  <td style="text-align:right;padding:8px 10px;font-family:monospace;font-weight:700;color:#2f9e44">₹{{totalCr.toLocaleString('en-IN',{minimumFractionDigits:2})}}</td>
                  <td colspan="2"></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="coa-fg coa-fg2">
            <div>
              <label class="coa-lbl">Cost Center (global)</label>
              <select v-model="form.cost_center" class="coa-fi">
                <option value="">— All Centers —</option>
                <option v-for="cc in costCenters" :key="cc" :value="cc">{{cc}}</option>
              </select>
            </div>
            <div>
              <label class="coa-lbl">Status</label>
              <select v-model="form.status" class="coa-fi">
                <option value="Draft">Draft</option>
                <option value="Submitted">Submit (Post to Ledger)</option>
              </select>
            </div>
          </div>

        </div>
        <div class="coa-dfooter" style="justify-content:space-between">
          <div style="font-size:12px;color:#868e96">{{editingName?'Editing: '+editingName:'New entry'}}</div>
          <div style="display:flex;gap:10px">
            <button class="b-btn b-btn-ghost" @click="drawerOpen=false">Cancel</button>
            <button class="b-btn b-btn-ghost" @click="saveEntry('Draft')" :disabled="drawerSaving" style="border-color:#3b5bdb;color:#3b5bdb">Save Draft</button>
            <button class="b-btn b-btn-primary" @click="saveEntry('Submitted')" :disabled="drawerSaving||!balanced" style="min-width:140px">
              <span v-html="icon('check',13)"></span> Post to Ledger
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>

  <!-- View Drawer -->
  <transition name="nim-overlay">
    <div v-if="viewOpen && viewEntry" class="coa-drawer-bg" @click.self="viewOpen=false">
      <div class="jen-drawer-panel">
        <div class="coa-dh" :style="'background:'+(viewEntry.status==='Submitted'?'linear-gradient(135deg,#1a4731,#2f9e44)':viewEntry.status==='Cancelled'?'linear-gradient(135deg,#6b1212,#c92a2a)':'linear-gradient(135deg,#1e3a5f,#2563eb)')">
          <div>
            <div class="coa-dh-title">{{viewEntry.name}}</div>
            <div class="coa-dh-sub">{{viewEntry.type}} · {{fmtDate(viewEntry.date)}}</div>
          </div>
          <button class="coa-dclose" @click="viewOpen=false"><span v-html="icon('x',16)"></span></button>
        </div>
        <div class="coa-dbody">
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px">
            <div><div style="font-size:11px;color:#868e96;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Status</div>
              <span class="b-badge" :class="JE_STATUS_COLOR[viewEntry.status]||'je-s-draft'">{{viewEntry.status}}</span>
            </div>
            <div><div style="font-size:11px;color:#868e96;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Narration</div>
              <div style="font-size:13px;max-width:500px">{{viewEntry.narration||'—'}}</div>
            </div>
          </div>
          <div style="display:flex;gap:24px;margin-bottom:20px;font-size:13px">
            <div><span style="color:#868e96">Total Debit:</span> <strong style="color:#c92a2a;font-family:monospace">{{fmtINR(viewEntry.total_debit)}}</strong></div>
            <div><span style="color:#868e96">Total Credit:</span> <strong style="color:#2f9e44;font-family:monospace">{{fmtINR(viewEntry.total_credit)}}</strong></div>
          </div>
          <div v-if="(viewEntry.lines||[]).length" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
            <div style="display:grid;grid-template-columns:1fr 120px 120px;gap:8px;padding:8px 14px;background:#f8f9fc;border-bottom:1px solid #e2e8f0;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#868e96">
              <div>Account</div><div style="text-align:right">Debit (Dr)</div><div style="text-align:right">Credit (Cr)</div>
            </div>
            <div v-for="(l,i) in viewEntry.lines" :key="i"
              style="display:grid;grid-template-columns:1fr 120px 120px;gap:8px;padding:9px 14px;border-bottom:1px solid #f1f3f5;font-size:13px">
              <div>{{l.account}}<span v-if="l.party" style="color:#868e96;font-size:11px;margin-left:6px">{{l.party}}</span></div>
              <div style="text-align:right;font-family:monospace;color:#c92a2a">{{flt(l.dr)>0?fmtINR(l.dr):'—'}}</div>
              <div style="text-align:right;font-family:monospace;color:#2f9e44">{{flt(l.cr)>0?fmtINR(l.cr):'—'}}</div>
            </div>
          </div>
          <div v-else style="color:#868e96;font-size:13px;margin-top:16px">No line detail available for this entry.</div>
        </div>
        <div class="coa-dfooter" style="justify-content:space-between">
          <div style="font-size:12px;color:#868e96">{{viewEntry.source==='frappe'?'From Frappe':'Local record'}}</div>
          <div style="display:flex;gap:10px">
            <button v-if="viewEntry.status==='Draft'" class="b-btn b-btn-ghost" @click="viewOpen=false;openEdit(viewEntry.name)"><span v-html="icon('edit',13)"></span> Edit</button>
            <button v-if="viewEntry.status==='Submitted'" class="b-btn b-btn-ghost" style="border-color:rgba(201,42,42,.4);color:#c92a2a" @click="viewOpen=false;confirmAction(viewEntry.name,'cancel')"><span v-html="icon('cancel',13)"></span> Cancel</button>
            <button class="b-btn b-btn-ghost" @click="viewOpen=false">Close</button>
          </div>
        </div>
      </div>
    </div>
  </transition>

  <!-- Confirm modal -->
  <transition name="nim-overlay">
    <div v-if="showConf" class="coa-drawer-bg" @click.self="showConf=false" style="justify-content:center;align-items:center">
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:440px;width:100%;border:1px solid #e2e8f0">
        <div style="font-size:17px;font-weight:700;margin-bottom:8px">{{confType==='delete'?'Delete Entry?':'Cancel Entry?'}}</div>
        <div style="font-size:14px;color:#868e96;margin-bottom:24px;line-height:1.5">
          {{confType==='delete'?'This journal entry will be permanently removed.':'This will mark the entry as Cancelled. It cannot be edited after cancellation.'}}
          <br><strong>{{confTarget}}</strong>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button @click="showConf=false" class="b-btn b-btn-ghost">Keep It</button>
          <button @click="doAction" class="b-btn" style="background:#c92a2a;color:#fff;border-color:#c92a2a">{{confType==='delete'?'Yes, Delete':'Yes, Cancel'}}</button>
        </div>
      </div>
    </div>
  </transition>
</div>`
  });

  /* ══════════════════════════════════════════════════
     OPENING BALANCES
  ══════════════════════════════════════════════════ */
  const OpeningBalances = defineComponent({
    name: "OpeningBalances",
    setup() {
      const OB_TYPE_META = {
        Asset:     {color:"#0C8599", bg:"#E0F7FA", label:"Assets",      balType:"Debit"},
        Liability: {color:"#C92A2A", bg:"#FFE3E3", label:"Liabilities", balType:"Credit"},
        Equity:    {color:"#7048E8", bg:"#F3F0FF", label:"Equity",      balType:"Credit"},
        Income:    {color:"#2F9E44", bg:"#EBFBEE", label:"Income",      balType:"Credit"},
        Expense:   {color:"#E67700", bg:"#FFF3BF", label:"Expenses",    balType:"Debit"},
      };
      const OB_TYPES = ["Asset","Liability","Equity","Income","Expense"];
      const loading = ref(true);
      const accounts = ref([]);
      const balances = reactive({});
      const drCrMap = reactive({});
      const goLiveDate = ref(new Date().toISOString().slice(0,10));
      const submitted = ref(false);
      const openSecs = ref(["Asset","Liability","Equity","Income","Expense"]);
      const showSubmitModal = ref(false);
      const showResetModal = ref(false);

      function r2(v){return Math.round(Number(v||0)*100)/100;}
      function fmtINR(v){const n=Number(v||0);if(n===0)return"₹0";return"₹"+Math.abs(n).toLocaleString("en-IN",{minimumFractionDigits:2});}
      function guessRT(t){t=(t||"").toLowerCase();if(t==="income"||t.includes("income"))return"Income";if(t==="expense"||t.includes("expense")||t==="depreciation")return"Expense";if(t==="payable"||t==="liability"||t==="credit card")return"Liability";if(t==="equity"||t.includes("retained"))return"Equity";return"Asset";}

      async function load(){
        loading.value=true;
        try{
          const res=await apiGET("zoho_books_clone.api.books_data.get_chart_of_accounts",{});
          const raw=Array.isArray(res)?res:[];
          accounts.value=raw.filter(a=>!a.is_group).map(a=>({
            name:a.name,account_name:a.account_name||a.name,
            root_type:a.root_type||guessRT(a.account_type),
            account_type:a.account_type||""
          }));
          try{
            const s=JSON.parse(localStorage.getItem("books_ob")||"{}");
            if(s.b)Object.assign(balances,s.b);
            if(s.d)Object.assign(drCrMap,s.d);
            if(s.date)goLiveDate.value=s.date;
            submitted.value=localStorage.getItem("books_ob_status")==="submitted";
          }catch{}
          accounts.value.forEach(a=>{if(!drCrMap[a.name])drCrMap[a.name]=OB_TYPE_META[a.root_type]?.balType||"Debit";});
          if(accounts.value.length) toast("Loaded "+accounts.value.length+" accounts","info");
          else toast("No accounts found — set up Chart of Accounts first","info");
        }catch(e){toast("Could not load accounts: "+e.message,"error");}
        finally{loading.value=false;}
      }

      function saveDraft(){try{localStorage.setItem("books_ob",JSON.stringify({b:{...balances},d:{...drCrMap},date:goLiveDate.value}));}catch{}}

      const eq=computed(()=>{
        let a=0,l=0,e=0;
        accounts.value.forEach(ac=>{
          const v=r2(Number(balances[ac.name]||0));if(!v)return;
          const dc=drCrMap[ac.name]||OB_TYPE_META[ac.root_type]?.balType||"Debit";
          const s=(dc==="Debit"?1:-1)*v;
          if(ac.root_type==="Asset")a+=s;
          else if(ac.root_type==="Liability")l-=s;
          else if(ac.root_type==="Equity")e-=s;
        });
        return{assets:r2(a),liabilities:r2(l),equity:r2(e),diff:r2(a-(l+e))};
      });

      const curStep=computed(()=>{
        if(submitted.value)return 4;
        const {diff}=eq.value;
        const hasB=Object.keys(balances).some(k=>Number(balances[k])>0);
        const bal=hasB&&Math.abs(diff)<0.01;
        return bal?3:hasB?2:goLiveDate.value?1:0;
      });

      const hasBalances=computed(()=>Object.keys(balances).some(k=>Number(balances[k])>0));

      function setB(name,val){const n=parseFloat(val)||0;if(n>0)balances[name]=n;else delete balances[name];saveDraft();}
      function setDC(name,val){drCrMap[name]=val;saveDraft();}
      function toggleSec(t){const i=openSecs.value.indexOf(t);if(i>=0)openSecs.value.splice(i,1);else openSecs.value.push(t);}
      function isSec(t){return openSecs.value.includes(t);}
      function secAccts(t){return accounts.value.filter(a=>a.root_type===t);}
      function secTotal(t){return r2(secAccts(t).reduce((s,a)=>s+r2(Number(balances[a.name]||0)),0));}

      async function doSubmit(){
        showSubmitModal.value=false;
        const date=goLiveDate.value||new Date().toISOString().slice(0,10);
        const lines=[];
        accounts.value.forEach(a=>{const v=r2(Number(balances[a.name]||0));if(!v)return;const dc=drCrMap[a.name]||"Debit";lines.push({account:a.name,debit_in_account_currency:dc==="Debit"?v:0,credit_in_account_currency:dc==="Credit"?v:0});});
        try{
          const doc={doctype:"Journal Entry",voucher_type:"Opening Entry",posting_date:date,user_remark:"Opening Balances as at "+date,is_opening:"Yes",accounts:lines};
          const saved=await apiPOST("frappe.client.save",{doc:JSON.stringify(doc)});
          const fresh=await apiGET("frappe.client.get",{doctype:"Journal Entry",name:saved.name});
          await apiPOST("frappe.client.submit",{doc:JSON.stringify({doctype:"Journal Entry",name:saved.name,modified:fresh.modified})});
          toast("Opening entry posted: "+saved.name);
        }catch(e){toast("Submitted locally — "+e.message,"info");}
        submitted.value=true;localStorage.setItem("books_ob_status","submitted");saveDraft();
      }

      function doReset(){
        Object.keys(balances).forEach(k=>delete balances[k]);
        submitted.value=false;localStorage.removeItem("books_ob_status");
        accounts.value.forEach(a=>{drCrMap[a.name]=OB_TYPE_META[a.root_type]?.balType||"Debit";});
        showResetModal.value=false;saveDraft();toast("Opening balances reset");
      }

      onMounted(load);
      return{loading,accounts,balances,drCrMap,goLiveDate,submitted,openSecs,showSubmitModal,showResetModal,OB_TYPE_META,OB_TYPES,eq,curStep,hasBalances,secAccts,secTotal,setB,setDC,toggleSec,isSec,doSubmit,doReset,saveDraft,fmtINR,r2,icon};
    },
    template: `
<div class="b-page">
  <!-- Info banner -->
  <div style="background:#EEF2FF;border:1px solid rgba(59,91,219,.15);border-radius:8px;padding:12px 16px;font-size:13px;color:#2f4ec4;line-height:1.6">
    <strong>What is this?</strong> Enter account balances from your previous accounting system as of the date you start using Books. This is done <strong>once</strong>. After submission, balances are locked and posted as an Opening Journal Entry.
  </div>

  <!-- Steps -->
  <div class="b-card" style="padding:14px 18px;display:flex;align-items:center">
    <template v-for="(s,i) in ['Set go-live date','Enter balances','Verify equation','Submit']" :key="i">
      <div style="display:flex;align-items:center">
        <div class="ob-step-dot" :class="i<curStep||submitted?'ob-dot-done':i===curStep&&!submitted?'ob-dot-active':'ob-dot-pending'">
          <span v-if="i<curStep||submitted" v-html="icon('check',12)"></span>
          <span v-else>{{i+1}}</span>
        </div>
        <span class="ob-step-lbl" :class="i<curStep||submitted?'ob-lbl-done':i===curStep&&!submitted?'ob-lbl-active':'ob-lbl-muted'">{{s}}</span>
      </div>
      <div v-if="i<3" class="ob-step-line" :class="i<curStep||submitted?'ob-line-done':''"></div>
    </template>
  </div>

  <!-- Action bar -->
  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <label style="font-size:13px;font-weight:600;color:#868E96;white-space:nowrap">Go-live Date</label>
      <input type="date" v-model="goLiveDate" @change="saveDraft" :disabled="submitted" class="b-input"/>
      <span style="font-size:12px;color:#868E96">Balances as at the closing of this date from your previous system.</span>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <span v-if="submitted" style="display:inline-flex;align-items:center;gap:6px;background:#EBFBEE;color:#2F9E44;border:1px solid rgba(47,158,68,.2);border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600"><span v-html="icon('check',13)"></span>Submitted</span>
      <button v-if="hasBalances||submitted" class="b-btn b-btn-ghost" @click="showResetModal=true">Reset</button>
      <button v-if="!submitted" class="b-btn" :class="Math.abs(eq.diff)<0.01&&hasBalances?'b-btn-primary':'b-btn-ghost'" :disabled="!hasBalances" @click="Math.abs(eq.diff)<0.01&&hasBalances?showSubmitModal=true:null">
        <span v-html="icon('check',13)"></span>
        {{Math.abs(eq.diff)<0.01&&hasBalances?'Submit Opening Balances':'Needs Balancing'}}
      </button>
    </div>
  </div>

  <!-- Loading -->
  <div v-if="loading" class="b-card" style="padding:40px;text-align:center;color:#868E96">
    <div class="b-shimmer" style="max-width:300px;margin:0 auto;height:14px"></div>
  </div>

  <!-- Equation bar -->
  <div v-else class="b-card" style="padding:16px 20px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#868E96;margin-bottom:12px">Accounting Equation Check — Assets = Liabilities + Equity</div>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:0">
      <div style="flex:1;min-width:140px;padding:12px 16px;border-radius:8px;text-align:center;background:#E0F7FA">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#0C8599;margin-bottom:4px">Assets</div>
        <div style="font-size:18px;font-weight:700;font-family:var(--mono);color:#0C8599">{{fmtINR(eq.assets)}}</div>
      </div>
      <div style="font-size:20px;font-weight:700;color:#868E96;padding:0 12px;align-self:center">=</div>
      <div style="flex:1;min-width:140px;padding:12px 16px;border-radius:8px;text-align:center;background:#FFE3E3">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#C92A2A;margin-bottom:4px">Liabilities</div>
        <div style="font-size:18px;font-weight:700;font-family:var(--mono);color:#C92A2A">{{fmtINR(eq.liabilities)}}</div>
      </div>
      <div style="font-size:20px;font-weight:700;color:#868E96;padding:0 12px;align-self:center">+</div>
      <div style="flex:1;min-width:140px;padding:12px 16px;border-radius:8px;text-align:center;background:#F3F0FF">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#7048E8;margin-bottom:4px">Equity</div>
        <div style="font-size:18px;font-weight:700;font-family:var(--mono);color:#7048E8">{{fmtINR(eq.equity)}}</div>
      </div>
    </div>
    <div class="ob-eq-diff" :class="!eq.assets&&!eq.liabilities&&!eq.equity?'ob-eq-zero':Math.abs(eq.diff)<0.01?'ob-eq-ok':'ob-eq-err'">
      <span v-if="!eq.assets&&!eq.liabilities&&!eq.equity">Enter balances to check the equation</span>
      <span v-else-if="Math.abs(eq.diff)<0.01">✓ Balanced — Assets = Liabilities + Equity = {{fmtINR(eq.assets)}}</span>
      <span v-else>✗ Out of balance by {{fmtINR(Math.abs(eq.diff))}} — {{eq.diff>0?"Assets exceed Liabilities+Equity":"Liabilities+Equity exceed Assets"}}</span>
    </div>
  </div>

  <!-- Account sections -->
  <template v-if="!loading">
    <template v-for="type in OB_TYPES" :key="type">
      <div v-if="secAccts(type).length" class="b-card" style="padding:0;overflow:hidden">
        <!-- Section header -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;cursor:pointer;user-select:none" @click="toggleSec(type)">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px" :style="{background:OB_TYPE_META[type].bg,color:OB_TYPE_META[type].color}">{{OB_TYPE_META[type].label}}</span>
            <span style="font-size:13px;color:#868E96">{{secAccts(type).length}} accounts &nbsp;·&nbsp; {{secAccts(type).filter(a=>balances[a.name]>0).length}} filled</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <span style="font-family:var(--mono);font-size:14px;font-weight:700" :style="{color:OB_TYPE_META[type].color}">{{fmtINR(secTotal(type))}}</span>
            <span style="font-size:11px;color:#868E96;transition:transform .2s;display:inline-block" :style="{transform:isSec(type)?'rotate(90deg)':'rotate(0deg)'}">&#9654;</span>
          </div>
        </div>
        <!-- Account rows (when open) -->
        <template v-if="isSec(type)">
          <div style="display:grid;grid-template-columns:1fr 130px 130px;align-items:center;gap:10px;padding:8px 16px;background:#F8F9FC;border-top:1px solid #F1F3F5">
            <div style="font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#868E96">Account</div>
            <div style="font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#868E96;text-align:right">Balance (₹)</div>
            <div style="font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#868E96">Dr / Cr</div>
          </div>
          <div v-for="a in secAccts(type)" :key="a.name" class="ob-acct-row">
            <div>
              <div style="font-size:13px;color:#1A1D23">{{a.account_name}}</div>
              <div v-if="a.account_type" style="font-size:11px;color:#868E96">{{a.account_type}}</div>
            </div>
            <input type="number" min="0" step="0.01" class="ob-bal-input" :class="balances[a.name]>0?'ob-has-val':''"
              :value="balances[a.name]||''" placeholder="0.00" :disabled="submitted"
              @input="setB(a.name,$event.target.value)" @focus="$event.target.select()"/>
            <select class="ob-dr-cr-sel" :class="(drCrMap[a.name]||'Debit')==='Debit'?'ob-dr':'ob-cr'"
              :disabled="submitted" @change="setDC(a.name,$event.target.value)">
              <option value="Debit" :selected="(drCrMap[a.name]||'Debit')==='Debit'">Dr (Debit)</option>
              <option value="Credit" :selected="(drCrMap[a.name]||'Debit')==='Credit'">Cr (Credit)</option>
            </select>
          </div>
          <!-- Section footer -->
          <div style="display:grid;grid-template-columns:1fr 130px 130px;gap:10px;padding:10px 16px;background:#F8F9FC;border-top:1px solid #E2E8F0">
            <div style="font-size:12px;font-weight:600;color:#868E96">Total {{OB_TYPE_META[type].label}}</div>
            <div style="font-family:var(--mono);font-size:13px;font-weight:700;text-align:right" :style="{color:OB_TYPE_META[type].color}">{{fmtINR(secTotal(type))}}</div>
            <div></div>
          </div>
        </template>
      </div>
    </template>
    <div v-if="!accounts.length" class="b-card" style="padding:40px;text-align:center;color:#868E96">
      <div style="font-size:36px;margin-bottom:12px">📄</div>
      <div style="font-weight:600;margin-bottom:8px;color:#1A1D23">No accounts found</div>
      <div style="font-size:13px;margin-bottom:16px">Set up your Chart of Accounts first, then come back to enter opening balances.</div>
      <router-link to="/accounting/chart-of-accounts" class="b-btn b-btn-primary">Go to Chart of Accounts</router-link>
    </div>
  </template>

  <!-- Submit modal -->
  <teleport to="body">
    <div v-if="showSubmitModal" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:20px" @click.self="showSubmitModal=false">
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:500px;width:100%">
        <div style="font-size:18px;font-weight:700;margin-bottom:8px">Submit Opening Balances?</div>
        <div style="font-size:13px;color:#868E96;margin-bottom:14px;line-height:1.6">This will create an <strong>Opening Entry</strong> journal in Frappe and lock all balances. You <strong>cannot edit</strong> opening balances after submission without cancelling the journal entry.</div>
        <div class="ob-eq-diff" :class="Math.abs(eq.diff)<0.01?'ob-eq-ok':'ob-eq-err'" style="margin-bottom:20px">
          <span v-if="Math.abs(eq.diff)<0.01">✓ Assets ({{fmtINR(eq.assets)}}) = Liabilities ({{fmtINR(eq.liabilities)}}) + Equity ({{fmtINR(eq.equity)}})</span>
          <span v-else>✗ Out of balance by {{fmtINR(Math.abs(eq.diff))}}. Please fix before submitting.</span>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="b-btn b-btn-ghost" @click="showSubmitModal=false">Go Back</button>
          <button class="b-btn" style="background:#2F9E44;color:#fff;border-color:#2F9E44" :disabled="Math.abs(eq.diff)>=0.01" @click="doSubmit">Yes, Submit</button>
        </div>
      </div>
    </div>
  </teleport>

  <!-- Reset modal -->
  <teleport to="body">
    <div v-if="showResetModal" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:20px" @click.self="showResetModal=false">
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:420px;width:100%">
        <div style="font-size:18px;font-weight:700;margin-bottom:8px">Reset All Balances?</div>
        <div style="font-size:13px;color:#868E96;margin-bottom:24px;line-height:1.6">This will clear all entered balances. You will need to re-enter them.</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="b-btn b-btn-ghost" @click="showResetModal=false">Cancel</button>
          <button class="b-btn" style="background:#C92A2A;color:#fff;border-color:#C92A2A" @click="doReset">Yes, Reset</button>
        </div>
      </div>
    </div>
  </teleport>
</div>`
  });

  /* ══════════════════════════════════════════════════
     COST CENTERS
  ══════════════════════════════════════════════════ */
  const CostCenters = defineComponent({
    name: "CostCenters",
    setup() {
      const CC_COLORS = ["#3B5BDB","#0C8599","#2F9E44","#E67700","#C92A2A","#7048E8","#D4537E","#1098AD","#495057"];
      const CC_TYPE_ICONS = {Department:"🏢",Project:"📄",Product:"📦",Region:"🌍",Group:"📁"};
      const CC_DEFAULTS = [
        {name:"Main",code:"MAIN",parent:"",type:"Group",color:"#495057",budget:0,budget_period:"Annual",alert_pct:80,budget_action:"Warn",is_group:1,status:"Active",desc:"Root cost center"},
        {name:"Engineering",code:"ENG",parent:"Main",type:"Department",color:"#3B5BDB",budget:5000000,budget_period:"Annual",alert_pct:80,budget_action:"Warn",is_group:0,status:"Active",desc:"Product engineering team"},
        {name:"Sales",code:"SLS",parent:"Main",type:"Department",color:"#2F9E44",budget:3000000,budget_period:"Annual",alert_pct:80,budget_action:"Warn",is_group:0,status:"Active",desc:"Sales and business development"},
        {name:"Marketing",code:"MKT",parent:"Main",type:"Department",color:"#E67700",budget:2000000,budget_period:"Annual",alert_pct:80,budget_action:"Warn",is_group:0,status:"Active",desc:"Brand and demand generation"},
        {name:"Operations",code:"OPS",parent:"Main",type:"Department",color:"#0C8599",budget:1500000,budget_period:"Annual",alert_pct:80,budget_action:"Warn",is_group:0,status:"Active",desc:"Infrastructure and ops"},
      ];
      const MOCK_EXP = {Engineering:2800000,Sales:1200000,Marketing:1650000,Operations:900000,Main:0};

      const loading = ref(true);
      const allCC = ref([]);
      const selected = ref(null);
      const editing = ref(null);
      const deleteTarget = ref(null);
      const expandedCC = ref([]);
      const ccSearch = ref("");
      const showDrawer = ref(false);
      const showDelModal = ref(false);
      const saving = ref(false);
      const fromFrappe = ref(false);

      const fForm = reactive({name:"",code:"",parent:"",type:"Department",color:CC_COLORS[0],budget:"",budget_period:"Annual",alert_pct:80,budget_action:"Warn",is_group:0,status:"Active",desc:""});

      function r2(v){return Math.round(Number(v||0)*100)/100;}
      function fmtINR(v){const n=Number(v||0);if(n===0)return"₹0";return"₹"+Math.abs(n).toLocaleString("en-IN",{minimumFractionDigits:0});}
      function pct(spent,budget){if(!budget)return 0;return Math.min(100,Math.round(spent/budget*100));}
      function saveLocal(){try{localStorage.setItem("books_cost_centers",JSON.stringify(allCC.value));}catch{}}
      function loadLocal(){try{return JSON.parse(localStorage.getItem("books_cost_centers")||"null");}catch{return null;}}

      async function load(){
        loading.value=true;
        try{
          const ccs=await apiGET("frappe.client.get_list",{doctype:"Cost Center",fields:JSON.stringify(["name","cost_center_name","cost_center_number","parent_cost_center","is_group","disabled"]),order_by:"lft asc",limit_page_length:200})||[];
          if(ccs.length){
            allCC.value=ccs.map(c=>({name:c.name,code:c.cost_center_number||"",parent:c.parent_cost_center||"",type:"Department",color:"#3B5BDB",budget:0,budget_period:"Annual",alert_pct:80,budget_action:"Warn",is_group:c.is_group?1:0,status:c.disabled?"Inactive":"Active",desc:"",source:"frappe"}));
            fromFrappe.value=true;toast("Loaded "+allCC.value.length+" cost centers","info");
          } else throw new Error("none");
        }catch{
          const saved=loadLocal();
          allCC.value=saved||CC_DEFAULTS.map(c=>({...c,source:"local"}));
          if(!saved)saveLocal();
        }
        allCC.value.filter(c=>c.is_group).forEach(c=>{ if(!expandedCC.value.includes(c.name)) expandedCC.value.push(c.name); });
        loading.value=false;
      }

      const visibleNodes=computed(()=>{
        const q=ccSearch.value.toLowerCase();
        const result=[];
        if(q){
          allCC.value.filter(c=>(c.name||"").toLowerCase().includes(q)||(c.code||"").toLowerCase().includes(q)).forEach(c=>{
            result.push({...c,depth:0,hasChildren:allCC.value.some(x=>x.parent===c.name),isOpen:false});
          });
        } else {
          function walk(parent,depth){
            allCC.value.filter(c=>(c.parent||"")===(parent||"")).forEach(c=>{
              const hasChildren=allCC.value.some(x=>x.parent===c.name);
              const isOpen=expandedCC.value.includes(c.name);
              result.push({...c,depth,hasChildren,isOpen});
              if(isOpen&&hasChildren)walk(c.name,depth+1);
            });
          }
          walk("",0);
        }
        return result;
      });

      function toggleCC(name){const i=expandedCC.value.indexOf(name);if(i>=0)expandedCC.value.splice(i,1);else expandedCC.value.push(name);}
      function expandAll(open){if(open)allCC.value.forEach(c=>{if(!expandedCC.value.includes(c.name))expandedCC.value.push(c.name);});else expandedCC.value=[];}

      function selectCC(name){selected.value=name;}

      const selectedCC=computed(()=>allCC.value.find(c=>c.name===selected.value)||null);
      const ccChildren=computed(()=>selectedCC.value?allCC.value.filter(c=>c.parent===selectedCC.value.name):[]);

      function openAdd(parentName){
        editing.value=null;
        Object.assign(fForm,{name:"",code:"",parent:parentName||"",type:"Department",color:CC_COLORS[0],budget:"",budget_period:"Annual",alert_pct:80,budget_action:"Warn",is_group:0,status:"Active",desc:""});
        showDrawer.value=true;
      }
      function openEdit(name){
        const cc=allCC.value.find(c=>c.name===name);if(!cc)return;
        editing.value=name;
        Object.assign(fForm,{...cc,budget:cc.budget||""});
        showDrawer.value=true;
      }
      function closeDrawer(){showDrawer.value=false;editing.value=null;}

      async function saveCC(){
        if(!fForm.name.trim()){toast("Cost Center Name is required","error");return;}
        saving.value=true;
        const data={...fForm,budget:Number(fForm.budget)||0};
        if(fromFrappe.value){
          try{
            const doc={doctype:"Cost Center",cost_center_name:data.name,cost_center_number:data.code,parent_cost_center:data.parent||"",is_group:data.is_group,company:window.frappe?.boot?.sysdefaults?.company||""};
            if(editing.value)doc.name=editing.value;
            await apiPOST("frappe.client.save",{doc:JSON.stringify(doc)});
            await load();toast(editing.value?"Cost center updated":"Cost center created");
          }catch(e){toast("Frappe error: "+e.message,"error");}
        } else {
          if(editing.value){const i=allCC.value.findIndex(c=>c.name===editing.value);if(i>=0)allCC.value[i]={...allCC.value[i],...data};}
          else allCC.value.push({...data,source:"local"});
          saveLocal();toast(editing.value?"Cost center updated":"Cost center created");
        }
        saving.value=false;closeDrawer();
      }

      function confirmDel(name){deleteTarget.value=name;showDelModal.value=true;}
      function closeDelModal(){showDelModal.value=false;deleteTarget.value=null;}
      async function doDelete(){
        const name=deleteTarget.value;if(!name)return;
        if(fromFrappe.value){
          try{await apiPOST("frappe.client.delete",{doctype:"Cost Center",name});await load();toast("Deleted");}
          catch(e){toast("Frappe error: "+e.message,"error");}
        } else {
          allCC.value=allCC.value.filter(c=>c.name!==name);saveLocal();
          if(selected.value===name)selected.value=null;
          toast("Deleted");
        }
        closeDelModal();
      }

      onMounted(load);
      return{loading,allCC,selected,selectedCC,ccChildren,editing,deleteTarget,expandedCC,ccSearch,showDrawer,showDelModal,saving,fromFrappe,fForm,CC_COLORS,CC_TYPE_ICONS,visibleNodes,r2,fmtINR,pct,load,toggleCC,expandAll,selectCC,openAdd,openEdit,closeDrawer,saveCC,confirmDel,closeDelModal,doDelete,MOCK_EXP,icon};
    },
    template: `
<div style="display:flex;flex-direction:column;height:calc(100vh - 56px);overflow:hidden">
  <div style="display:flex;flex:1;gap:0;overflow:hidden">

    <!-- Left: Tree panel -->
    <div style="width:340px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid #E2E8F0;background:#fff">
      <!-- Tree header -->
      <div style="padding:12px 16px;border-bottom:1px solid #E2E8F0;background:#F8F9FC;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
        <span style="font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#868E96">{{loading?"Loading...":allCC.length+" cost centers"}}</span>
        <div style="display:flex;gap:6px">
          <button style="border:1px solid #E2E8F0;border-radius:5px;padding:4px 7px;background:#fff;cursor:pointer;color:#868E96;font-size:12px;display:inline-flex;align-items:center" @click="expandAll(true)" title="Expand all"><span v-html="icon('chevD',13)"></span></button>
          <button style="border:1px solid #E2E8F0;border-radius:5px;padding:4px 7px;background:#fff;cursor:pointer;color:#868E96;font-size:12px;display:inline-flex;align-items:center" @click="expandAll(false)" title="Collapse all"><span v-html="icon('chevU',13)"></span></button>
          <button class="b-btn b-btn-primary" style="font-size:12px;padding:5px 10px" @click="openAdd()"><span v-html="icon('plus',12)"></span> New</button>
        </div>
      </div>
      <!-- Search -->
      <div style="padding:8px 12px;border-bottom:1px solid #F1F3F5;flex-shrink:0">
        <input v-model="ccSearch" type="text" placeholder="Search cost centers..." style="width:100%;border:1px solid #E2E8F0;border-radius:6px;padding:6px 10px;font-size:13px;outline:none;font-family:inherit"/>
      </div>
      <!-- Tree -->
      <div style="overflow-y:auto;flex:1">
        <div v-if="loading" style="padding:20px;text-align:center;color:#868E96">Loading...</div>
        <template v-else>
          <div v-for="node in visibleNodes" :key="node.name"
            style="display:flex;align-items:center;border-bottom:1px solid #F8F9FC;cursor:pointer;transition:background .12s;user-select:none"
            :style="{background:selected===node.name?'rgba(59,91,219,.07)':'',borderLeft:selected===node.name?'3px solid #3B5BDB':'3px solid transparent'}"
            @click="selectCC(node.name)">
            <div style="width:20px;height:36px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#868E96;cursor:pointer;margin-left:4px"
              v-if="node.hasChildren" @click.stop="toggleCC(node.name)">
              <span style="display:inline-block;transition:transform .15s;font-size:10px" :style="{transform:node.isOpen?'rotate(90deg)':'rotate(0deg)'}">&#9654;</span>
            </div>
            <div v-else style="width:24px;flex-shrink:0"></div>
            <div style="width:22px;height:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;margin-right:8px;margin-left:4px" :style="{background:node.color+'22',color:node.color,marginLeft:(node.depth*18+4)+'px'}">
              {{CC_TYPE_ICONS[node.type]||"🏢"}}
            </div>
            <div style="flex:1;padding:8px 4px 8px 0;min-width:0">
              <div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" :style="{fontWeight:node.is_group?600:400,color:selected===node.name?'#3B5BDB':'#1A1D23'}">{{node.name}}</div>
              <div v-if="node.code" style="font-size:10.5px;color:#868E96;padding-left:0">{{node.code}}</div>
            </div>
            <span v-if="node.status==='Inactive'" style="font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:10px;background:#F1F3F5;color:#868E96;margin-right:8px;flex-shrink:0">Off</span>
          </div>
          <div v-if="!visibleNodes.length" style="padding:20px;text-align:center;color:#868E96;font-size:13px">No cost centers found</div>
        </template>
      </div>
    </div>

    <!-- Right: Detail panel -->
    <div style="flex:1;overflow-y:auto;padding:20px;background:#F3F4F6">
      <!-- Empty state -->
      <div v-if="!selectedCC" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;color:#868E96;padding:40px">
        <div style="font-size:40px;margin-bottom:12px">🏢</div>
        <div style="font-size:15px;font-weight:600;color:#1A1D23;margin-bottom:6px">Select a cost center</div>
        <div style="font-size:13px;margin-bottom:20px;max-width:280px;line-height:1.5">Click any cost center in the tree to see its budget, expenses, and breakdown</div>
        <button class="b-btn b-btn-primary" @click="openAdd()"><span v-html="icon('plus',13)"></span>Add First Cost Center</button>
      </div>

      <!-- Detail card -->
      <template v-else>
        <div class="b-card" style="padding:0;overflow:hidden;margin-bottom:16px">
          <div style="padding:14px 20px;border-bottom:1px solid #E2E8F0;display:flex;align-items:center;justify-content:space-between">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px" :style="{background:selectedCC.color+'22',color:selectedCC.color}">{{CC_TYPE_ICONS[selectedCC.type]||"🏢"}}</div>
              <div>
                <div style="font-size:15px;font-weight:700;color:#1A1D23">{{selectedCC.name}}</div>
                <div style="font-size:12px;color:#868E96">{{selectedCC.type}}{{selectedCC.code?" · "+selectedCC.code:""}}{{selectedCC.parent?" · under "+selectedCC.parent:""}}</div>
              </div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="b-btn b-btn-ghost" @click="openEdit(selectedCC.name)"><span v-html="icon('edit',13)"></span>Edit</button>
              <button v-if="selectedCC.source!=='frappe'" style="border:1px solid rgba(201,42,42,.3);border-radius:5px;cursor:pointer;padding:5px 7px;display:inline-flex;color:#C92A2A;background:none" @click="confirmDel(selectedCC.name)"><span v-html="icon('trash',14)"></span></button>
            </div>
          </div>
          <div style="padding:20px">
            <div v-if="selectedCC.desc" style="font-size:13px;color:#868E96;margin-bottom:16px;line-height:1.5">{{selectedCC.desc}}</div>

            <!-- Stats row (non-group) -->
            <template v-if="!selectedCC.is_group">
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
                <div style="background:#F8F9FC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px">
                  <div style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:4px">Annual Budget</div>
                  <div style="font-size:17px;font-weight:700;font-family:var(--mono);color:#3B5BDB">{{fmtINR(selectedCC.budget)||"—"}}</div>
                </div>
                <div style="background:#F8F9FC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px">
                  <div style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:4px">Spent (YTD)</div>
                  <div style="font-size:17px;font-weight:700;font-family:var(--mono)" :style="{color:pct(MOCK_EXP[selectedCC.name]||0,selectedCC.budget)>=100?'#C92A2A':pct(MOCK_EXP[selectedCC.name]||0,selectedCC.budget)>=80?'#E67700':'#1A1D23'}">{{fmtINR(MOCK_EXP[selectedCC.name]||0)}}</div>
                </div>
                <div style="background:#F8F9FC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px">
                  <div style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:4px">{{selectedCC.budget-(MOCK_EXP[selectedCC.name]||0)>=0?"Remaining":"Over Budget"}}</div>
                  <div style="font-size:17px;font-weight:700;font-family:var(--mono)" :style="{color:selectedCC.budget-(MOCK_EXP[selectedCC.name]||0)>=0?'#2F9E44':'#C92A2A'}">{{fmtINR(Math.abs(selectedCC.budget-(MOCK_EXP[selectedCC.name]||0)))}}</div>
                </div>
              </div>
              <!-- Budget bar -->
              <div v-if="selectedCC.budget" style="margin-bottom:20px">
                <div style="display:flex;justify-content:space-between;font-size:12px;color:#868E96;margin-bottom:6px">
                  <span>Budget utilisation</span>
                  <span style="font-weight:700" :style="{color:pct(MOCK_EXP[selectedCC.name]||0,selectedCC.budget)>=100?'#C92A2A':pct(MOCK_EXP[selectedCC.name]||0,selectedCC.budget)>=80?'#E67700':'#1A1D23'}">{{pct(MOCK_EXP[selectedCC.name]||0,selectedCC.budget)}}%</span>
                </div>
                <div style="background:#E8ECF0;border-radius:20px;height:8px;overflow:hidden">
                  <div style="height:100%;border-radius:20px;transition:width .4s ease" :style="{width:pct(MOCK_EXP[selectedCC.name]||0,selectedCC.budget)+'%',background:pct(MOCK_EXP[selectedCC.name]||0,selectedCC.budget)>=100?'#C92A2A':pct(MOCK_EXP[selectedCC.name]||0,selectedCC.budget)>=80?'#E67700':'#2F9E44'}"></div>
                </div>
              </div>
            </template>

            <!-- Group stats -->
            <template v-if="selectedCC.is_group">
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
                <div style="background:#F8F9FC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px"><div style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:4px">Child Centers</div><div style="font-size:17px;font-weight:700;font-family:var(--mono)">{{ccChildren.length}}</div></div>
                <div style="background:#F8F9FC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px"><div style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:4px">Total Budget</div><div style="font-size:17px;font-weight:700;font-family:var(--mono);color:#3B5BDB">{{fmtINR(ccChildren.reduce((s,c)=>s+Number(c.budget||0),0))}}</div></div>
                <div style="background:#F8F9FC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px"><div style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#868E96;margin-bottom:4px">Total Spent</div><div style="font-size:17px;font-weight:700;font-family:var(--mono)">{{fmtINR(ccChildren.reduce((s,c)=>s+(MOCK_EXP[c.name]||0),0))}}</div></div>
              </div>
              <!-- Allocation chart -->
              <div v-if="ccChildren.length">
                <div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#868E96;margin-bottom:10px">Sub-centers expense allocation</div>
                <div v-for="c in ccChildren" :key="c.name" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  <span style="font-size:12.5px;width:120px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{c.name}}</span>
                  <div style="flex:1;background:#E8ECF0;border-radius:10px;height:6px;overflow:hidden">
                    <div style="height:100%;border-radius:10px;transition:width .4s" :style="{width:Math.round((MOCK_EXP[c.name]||0)/Math.max(1,...ccChildren.map(x=>MOCK_EXP[x.name]||0))*100)+'%',background:c.color}"></div>
                  </div>
                  <span style="font-size:12px;font-family:var(--mono);color:#868E96;width:70px;text-align:right;flex-shrink:0">{{fmtINR(MOCK_EXP[c.name]||0)}}</span>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Budget settings card (non-group) -->
        <div v-if="!selectedCC.is_group" class="b-card" style="padding:0;overflow:hidden">
          <div style="padding:12px 20px;border-bottom:1px solid #E2E8F0"><span style="font-size:13px;font-weight:600">Budget Settings</span></div>
          <div style="padding:14px 20px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;font-size:13px">
            <div><div style="color:#868E96;font-size:11.5px;margin-bottom:3px">Period</div><div style="font-weight:500">{{selectedCC.budget_period||"Annual"}}</div></div>
            <div><div style="color:#868E96;font-size:11.5px;margin-bottom:3px">Alert at</div><div style="font-weight:500">{{selectedCC.alert_pct||80}}%</div></div>
            <div><div style="color:#868E96;font-size:11.5px;margin-bottom:3px">Action</div><div style="font-weight:500">{{selectedCC.budget_action||"Warn"}}</div></div>
          </div>
        </div>
      </template>
    </div>
  </div>

  <!-- Add/Edit Drawer -->
  <teleport to="body">
    <div v-if="showDrawer" class="cc-drawer-open" style="position:fixed;inset:0;z-index:9000;background:rgba(15,23,42,.45);display:flex;justify-content:flex-end;backdrop-filter:blur(2px)" @click.self="closeDrawer">
      <div style="width:480px;max-width:95vw;height:100%;background:#fff;display:flex;flex-direction:column;box-shadow:-20px 0 60px rgba(0,0,0,.15)">
        <div style="background:linear-gradient(135deg,#2563eb,#4f46e5);padding:18px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
          <div>
            <div style="color:#fff;font-size:16px;font-weight:700">{{editing?"Edit Cost Center":"New Cost Center"}}</div>
            <div style="color:rgba(255,255,255,.7);font-size:12px;margin-top:2px">Track expenses by department or project</div>
          </div>
          <button @click="closeDrawer" style="background:rgba(255,255,255,.2);border:none;cursor:pointer;width:30px;height:30px;border-radius:6px;color:#fff;display:flex;align-items:center;justify-content:center"><span v-html="icon('x',16)"></span></button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:24px">
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868E96;margin-bottom:10px">Details</div>
          <div style="display:grid;gap:14px;margin-bottom:14px">
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Cost Center Name <span style="color:#C92A2A">*</span></label>
              <input v-model="fForm.name" class="b-input" placeholder="e.g. Engineering, Sales, Project Alpha" :disabled="!!editing"/>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Cost Center Code</label>
                <input v-model="fForm.code" class="b-input" placeholder="e.g. ENG, SLS"/>
              </div>
              <div>
                <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Parent Cost Center</label>
                <select v-model="fForm.parent" class="b-input">
                  <option value="">— Root level —</option>
                  <option v-for="c in allCC.filter(c=>c.name!==fForm.name)" :key="c.name" :value="c.name">{{c.name}}</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Type</label>
                <select v-model="fForm.type" class="b-input">
                  <option value="Department">Department</option>
                  <option value="Project">Project</option>
                  <option value="Product">Product Line</option>
                  <option value="Region">Region / Branch</option>
                  <option value="Group">Group (parent only)</option>
                </select>
              </div>
              <div>
                <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Colour Tag</label>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
                  <div v-for="c in CC_COLORS" :key="c" @click="fForm.color=c" style="width:22px;height:22px;border-radius:50%;cursor:pointer;transition:all .15s;flex-shrink:0"
                    :style="{background:c,outline:fForm.color===c?'2px solid '+c:'none',border:fForm.color===c?'2px solid #fff':'2px solid transparent'}"></div>
                </div>
              </div>
            </div>
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Description</label>
              <textarea v-model="fForm.desc" class="b-input" rows="2" style="resize:vertical" placeholder="What this cost center tracks..."></textarea>
            </div>
          </div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868E96;margin-bottom:10px;margin-top:20px;padding-top:20px;border-top:1px solid #E2E8F0">Budget</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Annual Budget (₹)</label>
              <input v-model="fForm.budget" class="b-input" type="number" min="0" step="1000" placeholder="0" style="font-family:var(--mono)"/>
            </div>
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Budget Period</label>
              <select v-model="fForm.budget_period" class="b-input">
                <option value="Annual">Annual</option>
                <option value="Quarterly">Quarterly</option>
                <option value="Monthly">Monthly</option>
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Budget Alert At (%)</label>
              <input v-model="fForm.alert_pct" class="b-input" type="number" min="0" max="100" style="font-family:var(--mono)"/>
            </div>
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Budget Action</label>
              <select v-model="fForm.budget_action" class="b-input">
                <option value="Warn">Warn only</option>
                <option value="Stop">Stop and warn</option>
                <option value="None">No action</option>
              </select>
            </div>
          </div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868E96;margin-bottom:10px;margin-top:20px;padding-top:20px;border-top:1px solid #E2E8F0">Settings</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Is Group?</label>
              <div style="display:flex;align-items:center;gap:12px;margin-top:6px">
                <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px"><input type="radio" v-model="fForm.is_group" :value="1" style="accent-color:#3B5BDB"/> Yes</label>
                <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px"><input type="radio" v-model="fForm.is_group" :value="0" style="accent-color:#3B5BDB"/> No</label>
              </div>
            </div>
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Status</label>
              <select v-model="fForm.status" class="b-input"><option value="Active">Active</option><option value="Inactive">Inactive</option></select>
            </div>
          </div>
        </div>
        <div style="padding:16px 24px;border-top:1px solid #E2E8F0;display:flex;justify-content:flex-end;gap:10px;background:#F8F9FC;flex-shrink:0">
          <button class="b-btn b-btn-ghost" @click="closeDrawer">Cancel</button>
          <button class="b-btn b-btn-primary" @click="saveCC" :disabled="saving" style="min-width:120px">{{saving?"Saving...":editing?"Update":"Create"}}</button>
        </div>
      </div>
    </div>
  </teleport>

  <!-- Delete confirm -->
  <teleport to="body">
    <div v-if="showDelModal" style="position:fixed;inset:0;z-index:9100;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px)" @click.self="closeDelModal">
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:420px;width:100%">
        <div style="font-size:17px;font-weight:700;margin-bottom:8px">Delete Cost Center?</div>
        <div style="font-size:14px;color:#868E96;margin-bottom:24px;line-height:1.5">"<strong>{{deleteTarget}}</strong>" will be permanently removed. This cannot be undone.</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="b-btn b-btn-ghost" @click="closeDelModal">Keep It</button>
          <button class="b-btn" style="background:#C92A2A;color:#fff;border-color:#C92A2A" @click="doDelete">Yes, Delete</button>
        </div>
      </div>
    </div>
  </teleport>
</div>`
  });

  /* ══════════════════════════════════════════════════
     FISCAL YEARS
  ══════════════════════════════════════════════════ */
  const FiscalYears = defineComponent({
    name: "FiscalYears",
    setup() {
      const FY_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const FY_MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

      const loading = ref(true);
      const allYears = ref([]);
      const selectedYear = ref(null);
      const editingName = ref(null);
      const showDrawer = ref(false);
      const showCloseModal = ref(false);
      const closeModalYear = ref(null);
      const saving = ref(false);
      const fromFrappe = ref(false);

      const fForm = reactive({name:"",start:"",end:"",period_type:"Monthly",closing_acct:"Retained Earnings",auto_close:0,is_default:0});

      function today_(){return new Date().toISOString().slice(0,10);}
      function parseDate(s){return s?new Date(s):null;}
      function fmtDate(d){if(!d)return"—";const dt=new Date(d);return dt.getDate()+" "+FY_MONTHS[dt.getMonth()]+" "+dt.getFullYear();}
      function fmtShort(d){if(!d)return"";const dt=new Date(d);return FY_MONTHS[dt.getMonth()]+"'"+String(dt.getFullYear()).slice(2);}
      function daysBetween(a,b){return Math.round((new Date(b)-new Date(a))/(1000*60*60*24));}
      function daysElapsed(start,end){const now=new Date(),s=new Date(start),e=new Date(end);if(now<s)return 0;if(now>e)return daysBetween(start,end);return daysBetween(start,now.toISOString().slice(0,10));}
      function saveLocal(){try{localStorage.setItem("books_fiscal_years",JSON.stringify(allYears.value));}catch{}}
      function loadLocal(){try{return JSON.parse(localStorage.getItem("books_fiscal_years")||"null");}catch{return null;}}

      function generatePeriods(start,end,type){
        const periods=[];const s=new Date(start),e=new Date(end);const now=new Date();
        if(type==="Annual"){periods.push({name:start+" to "+end,start,end,locked:false,is_current:now>=s&&now<=e});return periods;}
        const step=type==="Quarterly"?3:1;let cur=new Date(s);
        while(cur<=e){
          const pStart=cur.toISOString().slice(0,10);
          const nxt=new Date(cur);nxt.setMonth(nxt.getMonth()+step);nxt.setDate(0);
          const pEnd=nxt>e?e.toISOString().slice(0,10):nxt.toISOString().slice(0,10);
          const ps=new Date(pStart),pe=new Date(pEnd);
          periods.push({name:type==="Quarterly"?"Q"+Math.ceil((ps.getMonth()+1)/3)+" "+ps.getFullYear():FY_MONTHS_FULL[ps.getMonth()]+" "+ps.getFullYear(),start:pStart,end:pEnd,locked:pe<now&&pe<e,is_current:now>=ps&&now<=pe});
          cur=new Date(nxt);cur.setDate(cur.getDate()+1);if(cur>e)break;
        }
        return periods;
      }

      function autoFillName(){
        if(fForm.start&&fForm.end){
          const sy=new Date(fForm.start).getFullYear(),ey=new Date(fForm.end).getFullYear();
          fForm.name=sy===ey?String(sy):sy+"-"+String(ey).slice(2);
        }
      }

      function buildDefaultYears(){
        const now=new Date();const curFYStart=now.getMonth()>=3?now.getFullYear():now.getFullYear()-1;
        const yrs=[];
        for(let i=0;i<3;i++){const ys=curFYStart-i,ye=ys+1;const start=ys+"-04-01",end=ye+"-03-31";yrs.push({name:ys+"-"+String(ye).slice(2),start,end,period_type:"Monthly",closing_acct:"Retained Earnings",auto_close:0,is_default:i===0?1:0,is_closed:i>=2?1:0,periods:generatePeriods(start,end,"Monthly"),source:"local"});}
        return yrs;
      }

      async function load(){
        loading.value=true;
        try{
          const yrs=await apiGET("frappe.client.get_list",{doctype:"Fiscal Year",fields:JSON.stringify(["name","year_start_date","year_end_date","disabled","is_short_year"]),order_by:"year_start_date desc",limit_page_length:20})||[];
          if(yrs.length){
            allYears.value=yrs.map(y=>({name:y.name,start:y.year_start_date,end:y.year_end_date,period_type:"Monthly",closing_acct:"Retained Earnings",auto_close:0,is_default:0,is_closed:y.disabled?1:0,periods:generatePeriods(y.year_start_date,y.year_end_date,"Monthly"),source:"frappe"}));
            fromFrappe.value=true;toast("Loaded from Frappe","info");
          } else throw new Error("none");
        }catch{
          const saved=loadLocal();
          allYears.value=saved||buildDefaultYears();
          if(!saved)saveLocal();
        }
        loading.value=false;
      }

      const stats=computed(()=>{
        const now=new Date();
        const current=allYears.value.find(y=>new Date(y.start)<=now&&new Date(y.end)>=now);
        const allPeriods=allYears.value.flatMap(y=>y.periods||[]);
        const locked=allPeriods.filter(p=>p.locked).length;
        const el=current?daysElapsed(current.start,current.end):0;
        const tot=current?daysBetween(current.start,current.end):0;
        return{total:allYears.value.length,currentName:current?current.name:"None",elapsed:current?el+" / "+tot:"—",locked};
      });

      const selectedYearData=computed(()=>allYears.value.find(y=>y.name===selectedYear.value)||null);

      function selectYear(name){selectedYear.value=name;}

      function togglePeriodLock(yearName,periodIdx){
        const y=allYears.value.find(x=>x.name===yearName);if(!y)return;
        y.periods[periodIdx].locked=!y.periods[periodIdx].locked;
        saveLocal();toast(y.periods[periodIdx].locked?"Period locked":"Period unlocked");
      }

      function lockAllPeriods(yearName,lock){
        const y=allYears.value.find(x=>x.name===yearName);if(!y)return;
        const now=new Date();
        y.periods.forEach(p=>{if(!p.is_current){if(lock&&new Date(p.end)<now)p.locked=true;else if(!lock)p.locked=false;}});
        saveLocal();toast(lock?"All past periods locked":"All periods unlocked");
      }

      function openAdd(){
        editingName.value=null;
        const now=new Date();const ys=now.getMonth()>=3?now.getFullYear():now.getFullYear()-1;
        Object.assign(fForm,{name:ys+"-"+String(ys+1).slice(2),start:ys+"-04-01",end:(ys+1)+"-03-31",period_type:"Monthly",closing_acct:"Retained Earnings",auto_close:0,is_default:0});
        showDrawer.value=true;
      }
      function openEdit(name){
        const y=allYears.value.find(x=>x.name===name);if(!y)return;
        editingName.value=name;Object.assign(fForm,{name:y.name,start:y.start,end:y.end,period_type:y.period_type||"Monthly",closing_acct:y.closing_acct||"Retained Earnings",auto_close:y.auto_close||0,is_default:y.is_default||0});
        showDrawer.value=true;
      }
      function closeDrawer(){showDrawer.value=false;editingName.value=null;}

      const periodPreview=computed(()=>{
        if(!fForm.start||!fForm.end)return[];
        return generatePeriods(fForm.start,fForm.end,fForm.period_type);
      });

      async function saveYear(){
        if(!fForm.name.trim()||!fForm.start||!fForm.end){toast("Name, start and end dates are required","error");return;}
        saving.value=true;
        if(fromFrappe.value){
          try{
            const doc={doctype:"Fiscal Year",year:fForm.name,year_start_date:fForm.start,year_end_date:fForm.end};
            if(editingName.value)doc.name=editingName.value;
            await apiPOST("frappe.client.save",{doc:JSON.stringify(doc)});
            await load();toast(editingName.value?"Fiscal year updated":"Fiscal year created");
          }catch(e){toast("Frappe error: "+e.message,"error");}
        } else {
          const newY={name:fForm.name,start:fForm.start,end:fForm.end,period_type:fForm.period_type,closing_acct:fForm.closing_acct,auto_close:fForm.auto_close,is_default:fForm.is_default,is_closed:0,periods:generatePeriods(fForm.start,fForm.end,fForm.period_type),source:"local"};
          if(editingName.value){const i=allYears.value.findIndex(y=>y.name===editingName.value);if(i>=0)allYears.value[i]={...allYears.value[i],...newY};}
          else allYears.value.unshift(newY);
          saveLocal();toast(editingName.value?"Fiscal year updated":"Fiscal year created");
        }
        saving.value=false;closeDrawer();
      }

      function openCloseYear(name){closeModalYear.value=name;showCloseModal.value=true;}
      async function doCloseYear(){
        const name=closeModalYear.value;if(!name)return;
        const y=allYears.value.find(x=>x.name===name);if(!y)return;
        if(fromFrappe.value){
          try{await apiPOST("frappe.client.set_value",{doctype:"Fiscal Year",name,fieldname:"disabled",value:1});await load();toast("Fiscal year closed");}
          catch(e){toast("Frappe error: "+e.message,"error");}
        } else {
          y.is_closed=1;y.periods.forEach(p=>{p.locked=true;});saveLocal();toast("Fiscal year closed");
        }
        showCloseModal.value=false;closeModalYear.value=null;
      }

      onMounted(load);
      return{loading,allYears,selectedYear,selectedYearData,showDrawer,showCloseModal,closeModalYear,saving,fromFrappe,fForm,stats,periodPreview,editingName,selectYear,togglePeriodLock,lockAllPeriods,openAdd,openEdit,closeDrawer,saveYear,openCloseYear,doCloseYear,autoFillName,fmtDate,fmtShort,daysBetween,daysElapsed,icon,FY_MONTHS};
    },
    template: `
<div class="b-page">
  <!-- Stats strip -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
    <div class="b-card" style="padding:13px 16px"><div style="font-size:11px;color:#868E96;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Total Years</div><div style="font-size:19px;font-weight:700;font-family:var(--mono)">{{stats.total}}</div></div>
    <div class="b-card" style="padding:13px 16px"><div style="font-size:11px;color:#2F9E44;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Current Year</div><div style="font-size:14px;font-weight:700;font-family:var(--mono);color:#2F9E44">{{stats.currentName}}</div></div>
    <div class="b-card" style="padding:13px 16px"><div style="font-size:11px;color:#3B5BDB;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Days Elapsed</div><div style="font-size:19px;font-weight:700;font-family:var(--mono);color:#3B5BDB">{{stats.elapsed}}</div></div>
    <div class="b-card" style="padding:13px 16px"><div style="font-size:11px;color:#E67700;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Periods Locked</div><div style="font-size:19px;font-weight:700;font-family:var(--mono);color:#E67700">{{stats.locked}}</div></div>
  </div>

  <!-- Main grid -->
  <div style="display:grid;grid-template-columns:400px 1fr;gap:20px;align-items:start">

    <!-- Left: year cards -->
    <div style="display:flex;flex-direction:column;gap:14px">
      <div v-if="loading" class="b-card" style="padding:40px;text-align:center;color:#868E96">Loading fiscal years...</div>
      <template v-else>
        <div v-for="y in allYears" :key="y.name"
          style="background:#fff;border:1.5px solid #E2E8F0;border-radius:10px;padding:20px;cursor:pointer;transition:all .15s;position:relative;overflow:hidden"
          :style="{borderColor:selectedYear===y.name?'#3B5BDB':new Date()>=new Date(y.start)&&new Date()<=new Date(y.end)?'#2F9E44':'#E2E8F0',background:selectedYear===y.name?'#FAFBFF':'#fff'}"
          @click="selectYear(y.name)">
          <!-- ribbon -->
          <div v-if="new Date()>=new Date(y.start)&&new Date()<=new Date(y.end)" style="position:absolute;top:0;right:0;background:#2F9E44;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:0 10px 0 6px;letter-spacing:.5px">CURRENT</div>
          <div v-if="y.is_closed" style="position:absolute;top:0;right:0;background:#868E96;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:0 10px 0 6px;letter-spacing:.5px">CLOSED</div>
          <div style="font-size:16px;font-weight:700;margin-bottom:4px">{{y.name}}</div>
          <div style="font-size:12.5px;color:#868E96;margin-bottom:12px;font-family:var(--mono)">{{fmtDate(y.start)}} → {{fmtDate(y.end)}}</div>
          <!-- Progress bar (current year only) -->
          <template v-if="new Date()>=new Date(y.start)&&new Date()<=new Date(y.end)">
            <div style="margin-bottom:10px">
              <div style="display:flex;justify-content:space-between;font-size:11.5px;color:#868E96;margin-bottom:5px">
                <span>Year progress</span>
                <span style="font-weight:700">{{Math.round(daysElapsed(y.start,y.end)/daysBetween(y.start,y.end)*100)}}%</span>
              </div>
              <div style="background:#E8ECF0;border-radius:20px;height:8px;overflow:hidden">
                <div style="height:100%;border-radius:20px;background:#3B5BDB;transition:width .4s ease" :style="{width:Math.round(daysElapsed(y.start,y.end)/daysBetween(y.start,y.end)*100)+'%'}"></div>
              </div>
            </div>
          </template>
          <!-- Chips -->
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:3px 9px;border-radius:20px;font-weight:500" :style="{background:new Date()>=new Date(y.start)&&new Date()<=new Date(y.end)?'rgba(59,91,219,.1)':'#F8F9FC',color:new Date()>=new Date(y.start)&&new Date()<=new Date(y.end)?'#3B5BDB':'#868E96'}">{{y.period_type}} periods</span>
            <span v-if="(y.periods||[]).filter(p=>p.locked).length" style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:3px 9px;border-radius:20px;font-weight:500;background:#FFF5F5;color:#C92A2A">{{(y.periods||[]).filter(p=>p.locked).length}} locked</span>
            <span v-if="y.is_default" style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:3px 9px;border-radius:20px;font-weight:500;background:#EBFBEE;color:#2F9E44">Default</span>
            <span v-if="new Date()>new Date(y.end)&&!y.is_closed" style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:3px 9px;border-radius:20px;font-weight:500;background:#FFF3BF;color:#E67700">Needs closing</span>
          </div>
          <!-- Mini period grid -->
          <div v-if="(y.periods||[]).length" style="display:grid;grid-template-columns:repeat(12,1fr);gap:3px;margin-top:6px">
            <div v-for="(p,i) in (y.periods||[]).slice(0,12)" :key="i" style="height:6px;border-radius:2px" :style="{background:p.locked?'#E8ECF0':p.is_current?'#3B5BDB':new Date()>new Date(y.end)?'#B5D4F4':'#D3D1C7'}" :title="p.name+(p.locked?' (Locked)':p.is_current?' (Current)':'')"></div>
          </div>
        </div>
        <button class="b-btn b-btn-ghost" @click="openAdd" style="width:100%"><span v-html="icon('plus',13)"></span>Add Fiscal Year</button>
      </template>
    </div>

    <!-- Right: detail -->
    <div>
      <div v-if="!selectedYearData" class="b-card" style="padding:40px;text-align:center;color:#868E96">
        <div style="font-size:36px;margin-bottom:12px">📅</div>
        <div style="font-weight:600;font-size:15px;color:#1A1D23;margin-bottom:6px">Select a fiscal year</div>
        <div style="font-size:13px">Click any year card to manage its accounting periods and year-end settings</div>
      </div>
      <template v-else>
        <div class="b-card" style="padding:0;overflow:hidden;margin-bottom:14px">
          <div style="padding:16px 20px;border-bottom:1px solid #E2E8F0;display:flex;align-items:center;justify-content:space-between;background:#F8F9FC">
            <div>
              <div style="font-size:15px;font-weight:700">{{selectedYearData.name}}</div>
              <div style="font-size:12px;color:#868E96;margin-top:2px">{{fmtDate(selectedYearData.start)}} → {{fmtDate(selectedYearData.end)}} · {{daysBetween(selectedYearData.start,selectedYearData.end)}} days</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <span v-if="new Date()>=new Date(selectedYearData.start)&&new Date()<=new Date(selectedYearData.end)" style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:#EBFBEE;color:#2F9E44">Current</span>
              <span v-if="selectedYearData.is_closed" style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:#F1F3F5;color:#868E96">Closed</span>
              <button v-if="new Date()>new Date(selectedYearData.end)&&!selectedYearData.is_closed" class="b-btn b-btn-ghost" style="border-color:#E67700;color:#E67700;font-size:12px;padding:5px 10px" @click="openCloseYear(selectedYearData.name)">🔒 Close Year</button>
              <button class="b-btn b-btn-ghost" style="font-size:12px;padding:5px 10px" @click="openEdit(selectedYearData.name)">Edit</button>
            </div>
          </div>
          <!-- Progress bar for current year -->
          <div v-if="new Date()>=new Date(selectedYearData.start)&&new Date()<=new Date(selectedYearData.end)" style="padding:14px 20px;border-bottom:1px solid #E2E8F0">
            <div style="display:flex;justify-content:space-between;font-size:12px;color:#868E96;margin-bottom:6px">
              <span>Year progress — {{daysElapsed(selectedYearData.start,selectedYearData.end)}} of {{daysBetween(selectedYearData.start,selectedYearData.end)}} days</span>
              <span style="font-weight:700;color:#3B5BDB">{{Math.round(daysElapsed(selectedYearData.start,selectedYearData.end)/daysBetween(selectedYearData.start,selectedYearData.end)*100)}}%</span>
            </div>
            <div style="background:#E8ECF0;border-radius:20px;height:10px;overflow:hidden">
              <div style="height:100%;border-radius:20px;background:#3B5BDB;transition:width .4s" :style="{width:Math.round(daysElapsed(selectedYearData.start,selectedYearData.end)/daysBetween(selectedYearData.start,selectedYearData.end)*100)+'%'}"></div>
            </div>
          </div>
          <!-- Period table header -->
          <div style="display:grid;grid-template-columns:1fr 130px 100px 90px;gap:10px;padding:8px 16px;background:#F8F9FC;border-bottom:1px solid #E2E8F0;font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#868E96">
            <span>Period</span><span>Date Range</span><span>Status</span><span>Action</span>
          </div>
          <!-- Period rows -->
          <div v-for="(p,i) in (selectedYearData.periods||[])" :key="i"
            style="display:grid;grid-template-columns:1fr 130px 100px 90px;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #F1F3F5;font-size:13px;transition:background .12s"
            :style="{background:p.locked?'#FFF5F5':p.is_current?'#EEF2FF':''}">
            <div>
              <div :style="{fontWeight:p.is_current?600:400}">{{p.name}}</div>
              <div v-if="p.is_current" style="font-size:11px;color:#3B5BDB;font-weight:600">● Current period</div>
            </div>
            <div style="font-size:12px;color:#868E96;font-family:var(--mono)">{{fmtShort(p.start)}} – {{fmtShort(p.end)}}</div>
            <div>
              <span v-if="p.locked" style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:#FFE3E3;color:#C92A2A">🔒 Locked</span>
              <span v-else-if="p.is_current" style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:#EEF2FF;color:#3B5BDB">Open</span>
              <span v-else style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:#F1F3F5;color:#868E96">{{new Date(p.end)<new Date()?"Past":"Future"}}</span>
            </div>
            <div>
              <button v-if="!p.is_current"
                style="background:none;border:1px solid #E2E8F0;border-radius:5px;cursor:pointer;padding:3px 7px;font-size:11px;font-family:inherit;display:inline-flex;align-items:center;gap:3px;transition:all .15s"
                :style="{borderColor:p.locked?'rgba(201,42,42,.3)':'#E2E8F0',color:p.locked?'#C92A2A':'#868E96',background:p.locked?'#FFF5F5':'#fff'}"
                @click="togglePeriodLock(selectedYearData.name,i)">
                {{p.locked?"🔓 Unlock":"🔒 Lock"}}
              </button>
              <span v-else style="color:#868E96">—</span>
            </div>
          </div>
          <!-- Footer actions -->
          <div style="padding:12px 16px;background:#F8F9FC;border-top:1px solid #E2E8F0;display:flex;justify-content:space-between;align-items:center;font-size:12.5px">
            <span style="color:#868E96">{{(selectedYearData.periods||[]).filter(p=>p.locked).length}} of {{(selectedYearData.periods||[]).length}} periods locked</span>
            <div style="display:flex;gap:8px">
              <button class="b-btn b-btn-ghost" style="font-size:12px;padding:5px 10px" @click="lockAllPeriods(selectedYearData.name,true)">Lock All Past</button>
              <button class="b-btn b-btn-ghost" style="font-size:12px;padding:5px 10px" @click="lockAllPeriods(selectedYearData.name,false)">Unlock All</button>
            </div>
          </div>
        </div>

        <!-- Year-end config card -->
        <div class="b-card" style="padding:0;overflow:hidden">
          <div style="padding:14px 20px;border-bottom:1px solid #E2E8F0"><span style="font-size:13px;font-weight:600">Year-End Configuration</span></div>
          <div style="padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:13px">
            <div><div style="font-size:11px;color:#868E96;margin-bottom:3px">Closing Account</div><div style="font-weight:500">{{selectedYearData.closing_acct||"Retained Earnings"}}</div></div>
            <div><div style="font-size:11px;color:#868E96;margin-bottom:3px">Period Type</div><div style="font-weight:500">{{selectedYearData.period_type||"Monthly"}}</div></div>
            <div><div style="font-size:11px;color:#868E96;margin-bottom:3px">Auto-close on End</div><div style="font-weight:500">{{selectedYearData.auto_close?"Yes":"No"}}</div></div>
            <div><div style="font-size:11px;color:#868E96;margin-bottom:3px">Default Year</div><div style="font-weight:500">{{selectedYearData.is_default?"Yes":"No"}}</div></div>
          </div>
        </div>
      </template>
    </div>
  </div>

  <!-- Add / Edit Drawer -->
  <teleport to="body">
    <div v-if="showDrawer" class="fy-drawer-open" style="position:fixed;inset:0;z-index:9000;background:rgba(15,23,42,.45);display:flex;justify-content:flex-end;backdrop-filter:blur(2px)" @click.self="closeDrawer">
      <div style="width:480px;max-width:95vw;height:100%;background:#fff;display:flex;flex-direction:column;box-shadow:-20px 0 60px rgba(0,0,0,.15)">
        <div style="background:linear-gradient(135deg,#2563eb,#4f46e5);padding:18px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
          <div>
            <div style="color:#fff;font-size:16px;font-weight:700">{{editingName?"Edit Fiscal Year":"New Fiscal Year"}}</div>
            <div style="color:rgba(255,255,255,.7);font-size:12px;margin-top:2px">Define start and end dates</div>
          </div>
          <button @click="closeDrawer" style="background:rgba(255,255,255,.15);border:none;cursor:pointer;width:30px;height:30px;border-radius:8px;color:#fff;display:grid;place-items:center;transition:.15s"><span v-html="icon('x',16)"></span></button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:24px">
          <div style="background:#EEF2FF;border:1px solid rgba(59,91,219,.15);border-radius:8px;padding:12px 14px;font-size:12.5px;color:#2f4ec4;line-height:1.6;margin-bottom:20px">
            In India, the standard fiscal year runs <strong>1 April to 31 March</strong>. Companies can choose a different year-end with MCA approval.
          </div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868E96;margin-bottom:10px">Year Definition</div>
          <div style="display:grid;gap:14px;margin-bottom:14px">
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Year Name <span style="color:#C92A2A">*</span></label>
              <input v-model="fForm.name" class="b-input" placeholder="e.g. 2025-26, FY2026"/>
              <div style="font-size:11px;color:#868E96;margin-top:3px">Auto-filled when you set dates below</div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Start Date <span style="color:#C92A2A">*</span></label>
                <input v-model="fForm.start" class="b-input" type="date" @input="autoFillName"/>
              </div>
              <div>
                <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">End Date <span style="color:#C92A2A">*</span></label>
                <input v-model="fForm.end" class="b-input" type="date" @input="autoFillName"/>
              </div>
            </div>
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Period Generation</label>
              <select v-model="fForm.period_type" class="b-input">
                <option value="Monthly">Monthly (12 periods)</option>
                <option value="Quarterly">Quarterly (4 periods)</option>
                <option value="Annual">Annual (1 period)</option>
              </select>
              <div style="font-size:11px;color:#868E96;margin-top:3px">Accounting periods let you lock past periods to prevent backdating</div>
            </div>
          </div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868E96;margin-bottom:10px;margin-top:20px;padding-top:20px;border-top:1px solid #E2E8F0">Year-End Settings</div>
          <div style="display:grid;gap:14px;margin-bottom:14px">
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Closing Account for P&amp;L</label>
              <input v-model="fForm.closing_acct" class="b-input" placeholder="e.g. Retained Earnings"/>
              <div style="font-size:11px;color:#868E96;margin-top:3px">P&amp;L balances are transferred here at year end</div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Auto-close on Year End?</label>
                <div style="display:flex;gap:12px;margin-top:6px">
                  <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px"><input type="radio" v-model="fForm.auto_close" :value="1" style="accent-color:#3B5BDB"/> Yes</label>
                  <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px"><input type="radio" v-model="fForm.auto_close" :value="0" style="accent-color:#3B5BDB"/> No</label>
                </div>
              </div>
              <div>
                <label style="display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px">Is Default Year?</label>
                <div style="display:flex;gap:12px;margin-top:6px">
                  <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px"><input type="radio" v-model="fForm.is_default" :value="1" style="accent-color:#3B5BDB"/> Yes</label>
                  <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px"><input type="radio" v-model="fForm.is_default" :value="0" style="accent-color:#3B5BDB"/> No</label>
                </div>
              </div>
            </div>
          </div>
          <!-- Period preview -->
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868E96;margin-bottom:10px;margin-top:20px;padding-top:20px;border-top:1px solid #E2E8F0">Preview</div>
          <div style="border:1px solid #E2E8F0;border-radius:8px;overflow:hidden">
            <div v-if="!periodPreview.length" style="padding:16px;text-align:center;color:#868E96;font-size:13px">Set start and end dates to preview periods</div>
            <div v-for="(p,i) in periodPreview.slice(0,6)" :key="i" style="display:flex;justify-content:space-between;padding:8px 14px;border-bottom:1px solid #F1F3F5;font-size:12.5px">
              <span>{{p.name}}</span><span style="color:#868E96;font-family:var(--mono)">{{p.start}} – {{p.end}}</span>
            </div>
            <div v-if="periodPreview.length>6" style="padding:8px 14px;text-align:center;color:#868E96;font-size:12px;background:#F8F9FC">...and {{periodPreview.length-6}} more periods</div>
          </div>
        </div>
        <div style="padding:16px 24px;border-top:1px solid #E2E8F0;display:flex;justify-content:flex-end;gap:10px;background:#F8F9FC;flex-shrink:0">
          <button class="b-btn b-btn-ghost" @click="closeDrawer">Cancel</button>
          <button class="b-btn b-btn-primary" @click="saveYear" :disabled="saving" style="min-width:120px">{{saving?"Saving...":editingName?"Update Year":"Create Year"}}</button>
        </div>
      </div>
    </div>
  </teleport>

  <!-- Close Year Modal -->
  <teleport to="body">
    <div v-if="showCloseModal" style="position:fixed;inset:0;z-index:9100;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px)" @click.self="showCloseModal=false">
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:480px;width:100%">
        <div style="font-size:18px;font-weight:700;margin-bottom:6px">Close Fiscal Year {{closeModalYear}}?</div>
        <div style="font-size:13px;color:#868E96;margin-bottom:14px">All periods will be locked. This cannot be reversed without journal entries.</div>
        <ul style="list-style:none;margin:12px 0 20px;display:flex;flex-direction:column;gap:8px">
          <li style="display:flex;align-items:center;gap:8px;font-size:13px;color:#868E96"><span style="width:16px;height:16px;border-radius:50%;background:#EBFBEE;color:#2F9E44;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0">✓</span>All past periods will be locked</li>
          <li style="display:flex;align-items:center;gap:8px;font-size:13px;color:#868E96"><span style="width:16px;height:16px;border-radius:50%;background:#F1F3F5;color:#868E96;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0">●</span>P&amp;L will be transferred to Retained Earnings</li>
          <li style="display:flex;align-items:center;gap:8px;font-size:13px;color:#868E96"><span style="width:16px;height:16px;border-radius:50%;background:#F1F3F5;color:#868E96;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0">●</span>All transactions in this year become read-only</li>
        </ul>
        <div style="background:#FFF3BF;border:1px solid rgba(230,119,0,.2);border-radius:8px;padding:10px 14px;font-size:12.5px;color:#7F3E00;margin-bottom:20px">⚠ Closing a year locks <strong>all periods</strong> and transfers P&amp;L to Retained Earnings. This cannot be reversed without journal entries.</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="b-btn b-btn-ghost" @click="showCloseModal=false">Cancel</button>
          <button class="b-btn b-btn-primary" @click="doCloseYear">Proceed &amp; Close Year</button>
        </div>
      </div>
    </div>
  </teleport>
</div>`
  });

  const Reports = defineComponent({
    name: "Reports",
    props: { defaultTab: { type: String, default: "pl" } },
    setup(props) {
      const route = useRoute();
      const today_str = new Date().toISOString().slice(0, 10);
      const from = ref(new Date(new Date().getFullYear(), 3, 1).toISOString().slice(0, 10));
      const to = ref(today_str);
      // If navigated to /reports/trial-balance or /reports/ar-aging, pick correct tab
      const initTab = props.defaultTab || (route.name === "trial-balance" ? "tb" : route.name === "ar-aging" ? "aging" : "pl");
      const tab = ref(initTab), running = ref(false);
      const fyMode = ref("fy"); // "fy" | "custom"
      const selectedFY = ref("");
      const fiscalYears = ref([]);
      const pl = ref(null), bs = ref(null), cf = ref(null), gst = ref(null), tb = ref(null), aging = ref(null);
      const plBreakdown = ref([]);
      const showBreakdown = ref(false);
      const tabs = [
        { k: "pl", lbl: "P & L" },
        { k: "bs", lbl: "Balance Sheet" },
        { k: "cf", lbl: "Cash Flow" },
        { k: "tb", lbl: "Trial Balance" },
        { k: "aging", lbl: "AR Aging" },
        { k: "gst", lbl: "GST Summary" },
      ];

      function loadFY() {
        const raw = localStorage.getItem("books_fy_data");
        if (raw) { try { fiscalYears.value = JSON.parse(raw); } catch {} }
        if (!fiscalYears.value.length) {
          const yr = new Date().getFullYear();
          const isBeforeApril = new Date().getMonth() < 3;
          const curStart = isBeforeApril ? yr - 1 : yr;
          fiscalYears.value = [
            { name: `${curStart}-${curStart + 1}`, year_start_date: `${curStart}-04-01`, year_end_date: `${curStart + 1}-03-31` },
            { name: `${curStart - 1}-${curStart}`, year_start_date: `${curStart - 1}-04-01`, year_end_date: `${curStart}-03-31` },
            { name: `${curStart - 2}-${curStart - 1}`, year_start_date: `${curStart - 2}-04-01`, year_end_date: `${curStart - 1}-03-31` },
          ];
        }
        const now = new Date();
        const cur = fiscalYears.value.find(fy => new Date(fy.year_start_date) <= now && new Date(fy.year_end_date) >= now);
        const pick = cur || fiscalYears.value[0];
        if (pick) applyFY(pick);
      }

      function applyFY(fyOrName) {
        const fy = typeof fyOrName === "string" ? fiscalYears.value.find(f => f.name === fyOrName) : fyOrName;
        if (!fy) return;
        selectedFY.value = fy.name;
        from.value = fy.year_start_date;
        to.value = fy.year_end_date > today_str ? today_str : fy.year_end_date;
      }

      function onFYChange() { if (fyMode.value === "fy") applyFY(selectedFY.value); }

      async function run() {
        running.value = true;
        const c = co(), args = { company: c, from_date: from.value, to_date: to.value };
        try {
          if (tab.value === "pl") {
            [pl.value, plBreakdown.value] = await Promise.all([
              apiGET("zoho_books_clone.db.queries.get_profit_and_loss", args),
              apiGET("zoho_books_clone.db.queries.get_pl_monthly_breakdown", args),
            ]);
          }
          else if (tab.value === "bs") bs.value = await apiGET("zoho_books_clone.db.queries.get_balance_sheet_totals", { company: c, as_of_date: to.value });
          else if (tab.value === "cf") cf.value = await apiGET("zoho_books_clone.db.queries.get_cash_flow", args);
          else if (tab.value === "tb") tb.value = await apiGET("zoho_books_clone.db.queries.get_trial_balance", args);
          else if (tab.value === "aging") aging.value = await apiGET("zoho_books_clone.db.queries.get_ar_aging", { company: c, as_of_date: to.value });
          else gst.value = await apiGET("zoho_books_clone.db.queries.get_gst_summary", args);
        } catch (e) { toast(e.message, "error"); }
        finally { running.value = false; }
      }

      const fyBadge = computed(() => {
        if (!selectedFY.value) return null;
        const fy = fiscalYears.value.find(f => f.name === selectedFY.value);
        if (!fy) return null;
        const now = new Date();
        return { name: fy.name, isCurrent: new Date(fy.year_start_date) <= now && new Date(fy.year_end_date) >= now };
      });

      const tbTotals = computed(() => {
        if (!tb.value) return { dr: 0, cr: 0 };
        return { dr: tb.value.reduce((s, r) => s + r.debit, 0), cr: tb.value.reduce((s, r) => s + r.credit, 0) };
      });

      const agingTotal = computed(() => {
        if (!aging.value) return 0;
        return aging.value.reduce((s, r) => s + r.total, 0);
      });

      const bdMax = computed(() => {
        if (!plBreakdown.value.length) return 1;
        return Math.max(...plBreakdown.value.map(p => Math.max(p.income, p.expense)), 1);
      });

      onMounted(loadFY);

      return { from, to, tab, tabs, pl, bs, cf, gst, tb, aging, plBreakdown, showBreakdown, running, run,
               fyMode, selectedFY, fiscalYears, applyFY, onFYChange, fyBadge, tbTotals, agingTotal, bdMax, fmt, icon, flt };
    },
    template: `
<div class="b-page">
  <!-- Tab strip -->
  <div class="b-report-tabs">
    <button v-for="t in tabs" :key="t.k" class="b-rtab" :class="{active:tab===t.k}"
      @click="tab=t.k;pl=null;bs=null;cf=null;gst=null;tb=null;aging=null;plBreakdown=[]">{{t.lbl}}</button>
  </div>

  <!-- Filter bar -->
  <div class="b-card" style="padding:14px 20px">
    <!-- Mode toggle -->
    <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
      <div style="display:flex;gap:6px;background:#F0F2F5;border-radius:8px;padding:4px">
        <button class="rpt-mode-btn" :class="{active:fyMode==='fy'}" @click="fyMode='fy'">
          <span v-html="icon('fiscal',13)"></span> Fiscal Year
        </button>
        <button class="rpt-mode-btn" :class="{active:fyMode==='custom'}" @click="fyMode='custom'">
          <span v-html="icon('calendar',13)"></span> Custom Range
        </button>
      </div>

      <!-- FY picker -->
      <template v-if="fyMode==='fy'">
        <select class="b-input" style="min-width:160px" v-model="selectedFY" @change="onFYChange">
          <option v-for="fy in fiscalYears" :key="fy.name" :value="fy.name">FY {{fy.name}}</option>
        </select>
        <div v-if="fyBadge" style="display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600"
          :style="fyBadge.isCurrent?'background:#EEF2FF;color:#3B5BDB;border:1px solid #C5D0FA':'background:#F8F9FA;color:#868E96;border:1px solid #DEE2E6'">
          <span v-html="icon('fiscal',11)"></span> {{fyBadge.isCurrent?'Current Year':'Past Year'}}
        </div>
      </template>

      <!-- Custom date inputs -->
      <template v-if="fyMode==='custom'">
        <label style="font-size:12px;font-weight:700;color:var(--text-3)">From</label>
        <input type="date" v-model="from" class="b-input"/>
        <label style="font-size:12px;font-weight:700;color:var(--text-3)">To</label>
        <input type="date" v-model="to" class="b-input"/>
      </template>

      <!-- Always show date range as info when FY mode -->
      <div v-if="fyMode==='fy'" style="font-size:12px;color:#868E96;display:flex;align-items:center;gap:4px">
        <span v-html="icon('calendar',12)"></span>
        {{from}} → {{to}}
      </div>

      <button class="b-btn b-btn-primary" @click="run" :disabled="running" style="margin-left:auto">
        <span v-html="icon('trend',13)"></span>&nbsp;{{running?'Running…':'Run Report'}}
      </button>
    </div>
  </div>

  <!-- ── P & L ── -->
  <div v-if="tab==='pl'">
    <div class="b-card b-card-body">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:16px;font-weight:700">Profit &amp; Loss Statement</div>
          <div v-if="fyBadge&&fyMode==='fy'" style="font-size:12px;color:#868E96;margin-top:2px">FY {{fyBadge.name}} &nbsp;·&nbsp; {{from}} to {{to}}</div>
        </div>
        <button v-if="pl&&plBreakdown.length>1" class="b-btn b-btn-ghost" style="font-size:12px" @click="showBreakdown=!showBreakdown">
          <span v-html="icon('chart',13)"></span>&nbsp;{{showBreakdown?'Hide':'Show'}} Period Breakdown
        </button>
      </div>
      <div v-if="running" class="b-shimmer" style="height:80px"></div>
      <template v-else-if="pl">
        <div class="b-pl-row"><span>Total Income</span><span class="mono fw-700 c-green">{{fmt(pl.total_income)}}</span></div>
        <div class="b-pl-row"><span>Total Expense</span><span class="mono fw-700 c-red">{{fmt(pl.total_expense)}}</span></div>
        <div class="b-pl-row b-pl-net"><span>Net Profit / (Loss)</span><span class="mono fw-700" :class="flt(pl.net_profit)>=0?'c-green':'c-red'">{{fmt(pl.net_profit)}}</span></div>
        <!-- profit margin badge -->
        <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
          <div class="rpt-kpi-chip">
            <div class="rpt-kpi-label">Gross Margin</div>
            <div class="rpt-kpi-val" :style="flt(pl.total_income)>0?(flt(pl.net_profit)/flt(pl.total_income)*100>=0?'color:#2F9E44':'color:#C92A2A'):''">
              {{flt(pl.total_income)>0?(flt(pl.net_profit)/flt(pl.total_income)*100).toFixed(1)+'%':'—'}}
            </div>
          </div>
          <div class="rpt-kpi-chip">
            <div class="rpt-kpi-label">Expense Ratio</div>
            <div class="rpt-kpi-val">{{flt(pl.total_income)>0?(flt(pl.total_expense)/flt(pl.total_income)*100).toFixed(1)+'%':'—'}}</div>
          </div>
        </div>
      </template>
      <div v-else class="b-empty">Select a period and click Run Report.</div>
    </div>

    <!-- Period Breakdown -->
    <div v-if="showBreakdown&&plBreakdown.length" class="b-card" style="padding:0;overflow:hidden">
      <div class="b-card-head"><span class="b-card-title">Monthly Breakdown</span></div>
      <div style="padding:16px 20px;overflow-x:auto">
        <!-- Mini bar chart -->
        <div style="display:flex;align-items:flex-end;gap:6px;height:80px;margin-bottom:12px">
          <template v-for="p in plBreakdown" :key="p.label">
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;height:100%">
              <div style="flex:1;display:flex;align-items:flex-end;gap:2px;width:100%">
                <div style="flex:1;border-radius:3px 3px 0 0;background:#2F9E44;transition:height .3s"
                  :style="{height:bdMax>0?Math.round(p.income/bdMax*68)+'px':'0'}"></div>
                <div style="flex:1;border-radius:3px 3px 0 0;background:#FA5252;transition:height .3s"
                  :style="{height:bdMax>0?Math.round(p.expense/bdMax*68)+'px':'0'}"></div>
              </div>
            </div>
          </template>
        </div>
        <!-- Labels row -->
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <div v-for="p in plBreakdown" :key="p.label+'l'" style="flex:1;text-align:center;font-size:10px;color:#868E96;font-weight:600">{{p.label}}</div>
        </div>
        <!-- Legend -->
        <div style="display:flex;gap:16px;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#495057">
            <div style="width:10px;height:10px;border-radius:2px;background:#2F9E44"></div>Income
          </div>
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#495057">
            <div style="width:10px;height:10px;border-radius:2px;background:#FA5252"></div>Expense
          </div>
        </div>
        <!-- Table -->
        <table class="b-table">
          <thead><tr><th>Period</th><th class="ta-r">Income</th><th class="ta-r">Expense</th><th class="ta-r">Net Profit</th></tr></thead>
          <tbody>
            <tr v-for="p in plBreakdown" :key="p.label+'r'">
              <td><span class="b-badge b-badge-blue">{{p.label}}</span></td>
              <td class="ta-r mono fw-600 c-green">{{fmt(p.income)}}</td>
              <td class="ta-r mono fw-600 c-red">{{fmt(p.expense)}}</td>
              <td class="ta-r mono fw-700" :class="p.profit>=0?'c-green':'c-red'">{{fmt(p.profit)}}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ── Balance Sheet ── -->
  <div v-if="tab==='bs'" class="b-card b-card-body">
    <div style="font-size:16px;font-weight:700;margin-bottom:4px">Balance Sheet</div>
    <div v-if="fyBadge&&fyMode==='fy'" style="font-size:12px;color:#868E96;margin-bottom:16px">As of {{to}}&nbsp;·&nbsp;FY {{fyBadge.name}}</div>
    <div v-if="running" class="b-shimmer" style="height:80px"></div>
    <div v-else-if="bs" class="b-bs-grid">
      <div class="b-bs-block"><div class="b-bs-lbl">Assets</div><div class="b-bs-amt c-accent">{{fmt(bs.total_assets)}}</div></div>
      <div class="b-bs-block"><div class="b-bs-lbl">Liabilities</div><div class="b-bs-amt c-red">{{fmt(bs.total_liabilities)}}</div></div>
      <div class="b-bs-block"><div class="b-bs-lbl">Equity</div><div class="b-bs-amt c-amber">{{fmt(bs.total_equity)}}</div></div>
    </div>
    <div v-else class="b-empty">Select a period and click Run Report.</div>
  </div>

  <!-- ── Cash Flow ── -->
  <div v-if="tab==='cf'" class="b-card b-card-body">
    <div style="font-size:16px;font-weight:700;margin-bottom:4px">Cash Flow Statement</div>
    <div v-if="fyBadge&&fyMode==='fy'" style="font-size:12px;color:#868E96;margin-bottom:16px">FY {{fyBadge.name}}&nbsp;·&nbsp;{{from}} to {{to}}</div>
    <div v-if="running" class="b-shimmer" style="height:80px"></div>
    <template v-else-if="cf">
      <div class="b-pl-row"><span>Operating Activities</span><span class="mono fw-700" :class="flt(cf.operating)>=0?'c-green':'c-red'">{{fmt(cf.operating)}}</span></div>
      <div class="b-pl-row"><span>Investing Activities</span><span class="mono fw-700" :class="flt(cf.investing)>=0?'c-green':'c-red'">{{fmt(cf.investing)}}</span></div>
      <div class="b-pl-row"><span>Financing Activities</span><span class="mono fw-700" :class="flt(cf.financing)>=0?'c-green':'c-red'">{{fmt(cf.financing)}}</span></div>
      <div class="b-pl-row b-pl-net"><span>Net Change in Cash</span><span class="mono fw-700" :class="flt(cf.net_change)>=0?'c-green':'c-red'">{{fmt(cf.net_change)}}</span></div>
    </template>
    <div v-else class="b-empty">Select a period and click Run Report.</div>
  </div>

  <!-- ── Trial Balance ── -->
  <div v-if="tab==='tb'" class="b-card" style="padding:0;overflow:hidden">
    <div class="b-card-head">
      <span class="b-card-title">Trial Balance</span>
      <span v-if="fyBadge&&fyMode==='fy'" style="font-size:12px;color:#868E96">FY {{fyBadge.name}} · {{from}} to {{to}}</span>
    </div>
    <div v-if="running" style="padding:20px"><div class="b-shimmer" style="height:80px"></div></div>
    <template v-else-if="tb">
      <table class="b-table" v-if="tb.length">
        <thead>
          <tr>
            <th>Account</th>
            <th class="ta-r">Debit</th>
            <th class="ta-r">Credit</th>
            <th class="ta-r">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in tb" :key="r.account">
            <td style="font-weight:500">{{r.account}}</td>
            <td class="ta-r mono">{{r.debit>0?fmt(r.debit):'—'}}</td>
            <td class="ta-r mono">{{r.credit>0?fmt(r.credit):'—'}}</td>
            <td class="ta-r mono fw-700" :class="r.debit-r.credit>=0?'c-accent':'c-red'">{{fmt(Math.abs(r.debit-r.credit))}} {{r.debit-r.credit>=0?'Dr':'Cr'}}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr style="background:#F8F9FC;font-weight:700">
            <td>Totals</td>
            <td class="ta-r mono">{{fmt(tbTotals.dr)}}</td>
            <td class="ta-r mono">{{fmt(tbTotals.cr)}}</td>
            <td class="ta-r mono" :class="Math.abs(tbTotals.dr-tbTotals.cr)<0.01?'c-green':'c-red'">
              {{Math.abs(tbTotals.dr-tbTotals.cr)<0.01?'✓ Balanced':'✗ Diff: '+fmt(Math.abs(tbTotals.dr-tbTotals.cr))}}
            </td>
          </tr>
        </tfoot>
      </table>
      <div v-else class="b-empty">No journal entries found for this period.</div>
    </template>
    <div v-else class="b-empty">Click Run Report to compute Trial Balance from journal entries.</div>
  </div>

  <!-- ── AR Aging ── -->
  <div v-if="tab==='aging'">
    <div class="b-card b-card-body">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px">AR Aging Report</div>
      <div style="font-size:12px;color:#868E96;margin-bottom:16px">Outstanding receivables as of {{to}}</div>
      <div v-if="running" class="b-shimmer" style="height:60px"></div>
      <template v-else-if="aging">
        <div v-if="agingTotal===0" class="b-empty">No outstanding receivables found.</div>
        <template v-else>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
            <div v-for="b in aging" :key="b.range" class="rpt-kpi-chip" :style="b.range==='91+ days'?'border-color:#FA5252':''">
              <div class="rpt-kpi-label">{{b.range}}</div>
              <div class="rpt-kpi-val" :style="b.range==='91+ days'&&b.total>0?'color:#C92A2A':''">{{fmt(b.total)}}</div>
              <div style="font-size:11px;color:#868E96;margin-top:2px">{{b.count}} invoice{{b.count!==1?'s':''}}</div>
            </div>
          </div>
          <div style="font-size:12px;font-weight:600;color:#495057;margin-bottom:8px">Aging Distribution</div>
          <div v-for="b in aging" :key="b.range+'bar'" style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
              <span style="color:#495057;font-weight:500">{{b.range}}</span>
              <span class="mono fw-600">{{fmt(b.total)}} ({{b.pct}}%)</span>
            </div>
            <div style="height:8px;background:#E9ECEF;border-radius:4px;overflow:hidden">
              <div style="height:100%;border-radius:4px;transition:width .4s"
                :style="{width:b.pct+'%',background:b.range==='91+ days'?'#FA5252':b.range==='61-90 days'?'#FF922B':b.range==='31-60 days'?'#FCC419':'#51CF66'}"></div>
            </div>
          </div>
          <div class="b-pl-row b-pl-net" style="margin-top:14px">
            <span>Total Outstanding</span>
            <span class="mono fw-700 c-red">{{fmt(agingTotal)}}</span>
          </div>
        </template>
      </template>
      <div v-else class="b-empty">Click Run Report to compute AR aging from invoices.</div>
    </div>
  </div>

  <!-- ── GST Summary ── -->
  <div v-if="tab==='gst'" class="b-card" style="padding:0;overflow:hidden">
    <div class="b-card-head">
      <span class="b-card-title">GST Summary</span>
      <span v-if="fyBadge&&fyMode==='fy'" style="font-size:12px;color:#868E96">FY {{fyBadge.name}}</span>
    </div>
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
    {
      section: "INVOICING", items: [
        { to: "/customers", lbl: "Customers", icon: "users" },
        { to: "/quotes", lbl: "Quotes", icon: "quote" },
        { to: "/sales-orders", lbl: "Sales Orders", icon: "order" },
        { to: "/invoices", lbl: "Sales Invoices", icon: "file" },
        { to: "/recurring", lbl: "Recurring", icon: "recurring" },
        { to: "/credit-notes", lbl: "Credit Notes", icon: "creditnote" },
        { to: "/payments-received", lbl: "Payments Received", icon: "pay" },
        { to: "/eway-bills", lbl: "E-Way Bills", icon: "truck" },
      ]
    },
    {
      section: "PURCHASES", items: [
        { to: "/vendors", lbl: "Vendors", icon: "vendors" },
        { to: "/purchase-orders", lbl: "Purchase Orders", icon: "order" },
        { to: "/purchases", lbl: "Purchase Bills", icon: "purchase" },
        { to: "/debit-notes", lbl: "Debit Notes", icon: "creditnote" },
        { to: "/payments", lbl: "Payments", icon: "pay" },
      ]
    },
    {
      section: "ACCOUNTING", items: [
        { to: "/accounting/chart-of-accounts", lbl: "Chart of Accounts", icon: "coa" },
        { to: "/accounting/journal-entries", lbl: "Journal Entries", icon: "journal" },
        { to: "/accounting/opening-balances", lbl: "Opening Balances", icon: "opening" },
        { to: "/accounting/cost-centers", lbl: "Cost Centers", icon: "costcenter" },
        { to: "/accounting/fiscal-years", lbl: "Fiscal Years", icon: "fiscal" },
      ]
    },
    {
      section: "REPORTS", items: [
        { to: "/reports", lbl: "P & L", icon: "trend" },
        { to: "/reports/trial-balance", lbl: "Trial Balance", icon: "journal" },
        { to: "/reports/ar-aging", lbl: "AR Aging", icon: "pay" },
        { to: "/accounts", lbl: "Balance Sheet", icon: "chart" },
      ]
    },
    {
      section: "BANKING", items: [
        { to: "/banking/accounts",       lbl: "Bank Accounts",     icon: "bank"       },
        { to: "/banking/transactions",   lbl: "Bank Transactions", icon: "pay"        },
        { to: "/banking/reconciliation", lbl: "Bank Reconciliation",icon: "journal"   },
        { to: "/banking/cheques",        lbl: "Cheque Management", icon: "creditnote" },
        { to: "/banking/cash",           lbl: "Cash Management",   icon: "cash"       },
      ]
    },
  ];
  const TITLES = { dashboard: "Dashboard", customers: "Customers", quotes: "Quotes", "sales-orders": "Sales Orders", invoices: "Sales Invoices", "invoice-detail": "Sales Invoices", recurring: "Recurring Invoices", "credit-notes": "Credit Notes", "payments-received": "Payments Received", "eway-bills": "E-Way Bills", vendors: "Vendors", "purchase-orders": "Purchase Orders", purchases: "Purchase Bills", "debit-notes": "Debit Notes", payments: "Payments", "bank-accounts": "Bank Accounts", "bank-transactions": "Bank Transactions", "bank-reconciliation": "Bank Reconciliation", "cheque-management": "Cheque Management", "cash-management": "Cash Management", accounts: "Chart of Accounts", "template-editor": "Invoice Template", reports: "Reports", "trial-balance": "Trial Balance", "ar-aging": "AR Aging", "chart-of-accounts": "Chart of Accounts", "journal-entries": "Journal Entries", "opening-balances": "Opening Balances", "cost-centers": "Cost Centers", "fiscal-years": "Fiscal Years" };

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
        { icon: "file", label: "Create invoice for [customer] ₹[amount]", hint: "Create invoice for Prasath ₹80,000" },
        { icon: "fileplus", label: "Create invoice for [customer] [item] ₹[rate]", hint: "Create invoice for hari laptop ₹50,000" },
        { icon: "payment", label: "Record payment for [invoice]", hint: "Record payment for INV-2026-00005" },
        { icon: "alert", label: "Show overdue invoices", hint: "Show overdue invoices" },
        { icon: "search", label: "Find invoices for [customer]", hint: "Find invoices for hari" },
        { icon: "rupee", label: "Show total outstanding", hint: "Show total outstanding" },
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
            fields: ["name", "customer_name", "due_date", "outstanding_amount", "status"],
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
            fields: ["name", "customer_name", "posting_date", "grand_total", "outstanding_amount", "status"],
            filters: [["customer_name", "like", `%${customer}%`]],
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
            fields: ["name", "customer_name", "outstanding_amount"],
            filters: [["outstanding_amount", ">", 0]], limit: 200,
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
          file: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
          fileplus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
          payment: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
          alert: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
          search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
          rupee: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
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

      return {
        cname, initials, fullname, title, NAV, icon, collapsed, mobileOpen, logout, closeMobile,
        aiOpen, aiInput, aiRunning, aiResult, COMMANDS, filteredCommands, fillCommand, runAI, onAIKey, aiIcon, fmtDate, fmt, route
      };
    },
    template: `
<div :class="{'books-root':true, collapsed:collapsed, 'mobile-open':mobileOpen}">
  <div class="b-mob-overlay" v-if="mobileOpen" @click="closeMobile"></div>

  <aside class="b-sidebar">
    <div class="b-brand">
      <div class="b-brand-icon" @click="collapsed&&(collapsed=false)" :class="{'b-brand-icon-expand':collapsed}" title="">B</div>
      <div class="b-brand-info"><div class="b-brand-name">Books</div><div class="b-brand-sub">Accounting</div></div>
      <button v-if="!collapsed" class="b-collapse-top" @click="collapsed=true" title="Collapse sidebar">
        <span v-html="icon('chevL',15)"></span>
      </button>
      <button class="b-mob-close" @click="closeMobile" title="Close menu">✕</button>
    </div>
    <nav class="b-nav">
      <template v-for="group in NAV" :key="group.section">
        <div v-if="group.section" class="b-nav-section">{{group.section}}</div>
        <router-link v-for="n in group.items" :key="n.to" :to="n.to" custom v-slot="{navigate,isActive}">
          <div class="b-nav-item" :class="{active: isActive || route.path.startsWith(n.to + '/')}" @click="()=>{navigate();closeMobile();}">
            <span class="b-nav-icon" v-html="icon(n.icon,16)"></span>
            <span class="b-nav-label">{{n.lbl}}</span>
          </div>
        </router-link>
      </template>
    </nav>
    <div class="b-sidebar-footer">
      <div class="b-user-row">
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
        <!-- Expand sidebar button — only shows when sidebar is collapsed -->
        <button v-if="collapsed" class="b-topbar-expand" @click="collapsed=false" title="Expand sidebar">
          <span v-html="icon('chevR',15)"></span>
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
/* ══ Opening Balances ══ */
.ob-step-dot{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.ob-dot-done{background:#3B5BDB;color:#fff}
.ob-dot-active{background:#3B5BDB;color:#fff;box-shadow:0 0 0 4px rgba(59,91,219,.1)}
.ob-dot-pending{background:#E8ECF0;color:#868E96}
.ob-step-lbl{font-size:12px;margin-left:7px;white-space:nowrap;font-weight:500}
.ob-lbl-done{color:#1A1D23}
.ob-lbl-active{color:#3B5BDB;font-weight:600}
.ob-lbl-muted{color:#868E96}
.ob-step-line{flex:1;height:2px;background:#E8ECF0;margin:0 8px;min-width:16px}
.ob-line-done{background:#3B5BDB}
.ob-eq-diff{padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.ob-eq-ok{background:#EBFBEE;color:#2F9E44;border:1px solid rgba(47,158,68,.2)}
.ob-eq-err{background:#FFF5F5;color:#C92A2A;border:1px solid rgba(201,42,42,.2)}
.ob-eq-zero{background:#F8F9FC;color:#868E96;border:1px solid #E2E8F0}
.ob-acct-row{display:grid;grid-template-columns:1fr 130px 130px;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid #F8F9FC}
.ob-acct-row:last-child{border-bottom:none}
.ob-acct-row:hover{background:#FAFBFD}
.ob-bal-input{border:1px solid #CDD5E0;border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--mono);text-align:right;width:100%;outline:none;color:#1A1D23;background:#fff;transition:border-color .15s}
.ob-bal-input:focus{border-color:#3B5BDB;box-shadow:0 0 0 3px rgba(59,91,219,.08)}
.ob-bal-input:disabled{background:#F8F9FC;color:#868E96;cursor:not-allowed}
.ob-has-val{border-color:#3B5BDB!important;background:#EEF2FF!important}
.ob-dr-cr-sel{border:1px solid #CDD5E0;border-radius:6px;padding:6px 8px;font-size:12px;outline:none;background:#fff;cursor:pointer;color:#1A1D23;appearance:none;width:100%;transition:border-color .15s;font-family:inherit}
.ob-dr{border-color:rgba(201,42,42,.4)!important;background:#FFF5F5!important;color:#C92A2A!important}
.ob-cr{border-color:rgba(47,158,68,.4)!important;background:#F0FBF3!important;color:#2F9E44!important}
/* ══ Reports ══ */
.rpt-mode-btn{display:flex;align-items:center;gap:5px;padding:6px 12px;border:none;border-radius:6px;font-size:12.5px;font-weight:500;cursor:pointer;background:transparent;color:#6c757d;transition:all .15s;font-family:inherit}
.rpt-mode-btn.active{background:#fff;color:#1A1D23;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.1)}
.rpt-kpi-chip{background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:12px 16px;min-width:110px;flex:1}
.rpt-kpi-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9CA3AF;margin-bottom:4px}
.rpt-kpi-val{font-size:20px;font-weight:700;color:#1A1D23;font-family:var(--mono);letter-spacing:-.02em}
/* ══ Recurring Invoices ══ */
.ri-next-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;font-size:11.5px;font-weight:600}
.ri-today{background:#fff3e0;color:#e65100}
.ri-soon{background:#fef3c7;color:#d97706}
.ri-ok{background:#d1fae5;color:#059669}
.ri-none{background:#f3f4f6;color:#9ca3af}
.ri-schedule-preview{background:#f8f9fc;border:1.5px solid #e4e8f0;border-radius:9px;padding:13px 16px}
.ri-preview-label{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.ri-preview-dates{display:flex;gap:7px;flex-wrap:wrap}
.ri-sdate{padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500;background:#fff;border:1.5px solid #e4e8f0;font-family:monospace;color:#374151}
.ri-sdate-past{opacity:.4;text-decoration:line-through}
.ri-sdate-next{background:#eff6ff;border-color:#2563eb;color:#2563eb;font-weight:700}

/* ══ Sales Orders Status Timeline ══ */
.so-timeline{display:flex;align-items:center;padding:14px 16px;background:#f8f9fc;border-radius:10px;border:1px solid #e4e8f0;margin-bottom:18px;flex-shrink:0}
.so-tl-step{display:flex;align-items:center;flex:1;gap:0}
.so-tl-dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;transition:all .2s}
.so-done{background:#2563eb;color:#fff}
.so-active{background:#2563eb;color:#fff;box-shadow:0 0 0 4px rgba(37,99,235,.15)}
.so-pending{background:#e4e8f0;color:#9ca3af}
.so-tl-label{font-size:11px;margin-left:6px;white-space:nowrap;font-weight:500}
.so-tl-active{color:#2563eb;font-weight:700}
.so-tl-pending{color:#9ca3af}
.so-tl-line{flex:1;height:2px;background:#e4e8f0;margin:0 4px;min-width:10px}
.so-line-done{background:#2563eb}

/* ══ Quotes Summary Strip ══ */
.qt-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;flex-shrink:0}
.qt-sum-card{background:#fff;border:1px solid #e4e8f0;border-radius:10px;padding:14px 18px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.qt-sum-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;margin-bottom:4px}
.qt-sum-value{font-size:22px;font-weight:700;color:#111827;letter-spacing:-.02em;font-family:monospace}
/* Customer typeahead */
.qt-cust-drop{position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:9999;background:#fff;border:1.5px solid #e4e8f0;border-radius:8px;max-height:200px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.1)}
.qt-drop-item{padding:9px 14px;cursor:pointer;border-bottom:1px solid #f1f3f7;transition:background .1s}
.qt-drop-item:hover{background:#f5f8ff}
@media(max-width:900px){.qt-summary{grid-template-columns:repeat(2,1fr)}}

/* ══ Customers Page ══ */
.cust-page{display:flex;flex-direction:column;gap:16px;height:100%;min-height:0}
.cust-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;flex-shrink:0}
.cust-toolbar-left{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cust-toolbar-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cust-filters{display:flex;gap:5px;flex-wrap:wrap}
.cust-search{display:flex;align-items:center;gap:7px;background:#fff;border:1.5px solid #e4e8f0;border-radius:20px;padding:6px 12px}
.cust-search-input{border:none;outline:none;background:none;font-size:12.5px;font-family:inherit;color:#111827;width:180px;caret-color:#2563eb}
.cust-search-input::placeholder{color:#9ca3af}
.cust-table-card{overflow:hidden;flex:1;display:flex;flex-direction:column}
.cust-table-wrap{flex:1;overflow-y:auto}
.cust-table{width:100%;border-collapse:collapse;font-size:13px}
.cust-table thead tr{background:#f8f9fc}
.cust-table th{padding:10px 14px;text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;border-bottom:1.5px solid #e4e8f0;white-space:nowrap;position:sticky;top:0;background:#f8f9fc;z-index:2}
.cust-table td{padding:11px 14px;border-bottom:1px solid #f1f3f7;vertical-align:middle}
.cust-row{cursor:pointer;transition:background .1s}
.cust-row:hover td{background:#f8faff}
.cust-row-disabled{opacity:.5}
.cust-name{font-weight:600;color:#111827;font-size:13px}
.cust-id{font-size:11px;color:#9ca3af;margin-top:1px;font-family:monospace}
.cust-mono{font-family:monospace;font-size:12px;color:#374151}
.cust-secondary{font-size:12.5px;color:#374151}
.cust-empty{text-align:center;padding:48px 20px}
.cust-empty-icon{margin-bottom:12px;display:flex;justify-content:center}
.cust-empty-title{font-size:15px;font-weight:600;color:#111827;margin-bottom:6px}
.cust-empty-sub{font-size:13px;color:#9ca3af;margin-bottom:4px}
.cust-act-btn{width:28px;height:28px;border-radius:6px;border:1.5px solid #e4e8f0;background:none;cursor:pointer;display:grid;place-items:center;transition:.15s}
.cust-act-edit{color:#2563eb}.cust-act-edit:hover{background:#eff6ff;border-color:#2563eb}
.cust-act-del{color:#9ca3af}.cust-act-del:hover{background:#fee2e2;border-color:#dc2626;color:#dc2626}
.cust-row-count{padding:8px 14px;font-size:11.5px;color:#9ca3af;border-top:1px solid #f1f3f7;text-align:right;flex-shrink:0}
/* Drawer */
.cust-backdrop{position:fixed;inset:0;z-index:9000;background:rgba(15,23,42,.45);display:flex;justify-content:flex-end;backdrop-filter:blur(2px)}
.cust-drawer{width:560px;max-width:95vw;height:100%;background:#fff;display:flex;flex-direction:column;box-shadow:-20px 0 60px rgba(0,0,0,.15)}
.cust-drawer-fade-enter-active,.cust-drawer-fade-leave-active{transition:opacity .2s}
.cust-drawer-fade-enter-from,.cust-drawer-fade-leave-to{opacity:0}
.cust-drawer-slide-enter-active,.cust-drawer-slide-leave-active{transition:transform .25s cubic-bezier(.4,0,.2,1)}
.cust-drawer-slide-enter-from,.cust-drawer-slide-leave-to{transform:translateX(100%)}
.cust-drawer-header{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;background:linear-gradient(135deg,#2563eb,#4f46e5);flex-shrink:0}
.cust-drawer-header-left{display:flex;align-items:center;gap:12px}
.cust-drawer-icon{width:36px;height:36px;border-radius:9px;background:rgba(255,255,255,.18);display:grid;place-items:center;color:#fff;flex-shrink:0}
.cust-drawer-title{font-size:16px;font-weight:700;color:#fff;letter-spacing:-.01em}
.cust-drawer-sub{font-size:11.5px;color:rgba(255,255,255,.6);margin-top:2px}
.cust-drawer-body{flex:1;overflow-y:auto;padding:22px 24px}
.cust-sec-label{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af;margin-bottom:10px;margin-top:20px;display:block}
.cust-sec-label:first-child{margin-top:0}
.cust-disable-box{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#fef2f2;border:1.5px solid rgba(220,38,38,.2);border-radius:9px;margin-top:8px;cursor:pointer}

/* ══ New Invoice Modal (nim) ══ */
.nim-overlay{
  position:fixed;inset:0;z-index:9000;
  display:flex;align-items:center;justify-content:center;
  background:rgba(15,23,42,.5);padding:20px 16px;
  backdrop-filter:blur(3px);
}
.nim-dialog{
  background:#fff;border-radius:14px;width:100%;max-width:840px;
  box-shadow:0 24px 80px rgba(0,0,0,.2);overflow:hidden;
  display:flex;flex-direction:column;
  max-height:92vh;
}
/* Header */
.nim-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:18px 24px;
  background:linear-gradient(135deg,#2563eb,#4f46e5);
  flex-shrink:0;
}
.nim-header-left{display:flex;align-items:center;gap:12px;}
.nim-header-icon{
  width:36px;height:36px;border-radius:9px;
  background:rgba(255,255,255,.18);
  display:grid;place-items:center;color:#fff;flex-shrink:0;
}
.nim-header-title{font-size:16px;font-weight:700;color:#fff;letter-spacing:-.01em;}
.nim-header-sub{font-size:11.5px;color:rgba(255,255,255,.6);margin-top:2px;}
.nim-close{
  background:rgba(255,255,255,.15);border:none;cursor:pointer;
  color:#fff;width:30px;height:30px;border-radius:8px;
  display:grid;place-items:center;transition:.15s;
}
.nim-close:hover{background:rgba(255,255,255,.28);}
/* Body */
.nim-body{padding:22px 24px;overflow-y:auto;flex:1;}
.nim-section-label{
  font-size:10.5px;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:#9ca3af;margin-bottom:10px;
}
.nim-section-header{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:8px;
}
.nim-mb{margin-bottom:18px;}
.nim-mb-sm{margin-bottom:8px;}
/* Grid layouts */
.nim-grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;}
.nim-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.nim-span-1{grid-column:1;}
/* Fields */
.nim-field{display:flex;flex-direction:column;gap:5px;}
.nim-label{font-size:11.5px;font-weight:600;color:#6b7280;letter-spacing:.01em;}
.nim-req{color:#ef4444;}
.nim-input{
  height:36px;padding:0 11px;
  border:1.5px solid #e4e8f0;border-radius:7px;
  font-size:13.5px;color:#111827;background:#fff;
  outline:none;width:100%;box-sizing:border-box;
  transition:border-color .15s,box-shadow .15s;font-family:inherit;
}
.nim-input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1);}
.nim-select{
  height:36px;padding:0 11px;
  border:1.5px solid #e4e8f0;border-radius:7px;
  font-size:13.5px;color:#111827;background:#fff;
  outline:none;width:100%;box-sizing:border-box;
  transition:border-color .15s;font-family:inherit;
  appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 11px center;
  padding-right:30px;cursor:pointer;
}
.nim-select:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1);}
.nim-select-sm{
  height:30px;padding:0 26px 0 9px;font-size:12px;
  border:1.5px solid #e4e8f0;border-radius:6px;
  color:#374151;background:#fff;outline:none;
  font-family:inherit;cursor:pointer;
  appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 8px center;
}
.nim-textarea{height:auto;padding:9px 11px;resize:vertical;line-height:1.5;}
/* Table */
.nim-table-wrap{
  border:1.5px solid #e4e8f0;border-radius:9px;overflow:hidden;
}
.nim-table{width:100%;border-collapse:collapse;font-size:13px;}
.nim-table thead tr{background:#f8f9fc;}
.nim-table th{
  padding:9px 12px;text-align:left;
  font-size:10.5px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;color:#9ca3af;
  border-bottom:1.5px solid #e4e8f0;white-space:nowrap;
}
.nim-tr td{padding:5px 8px;border-bottom:1px solid #f1f3f7;}
.nim-tr:last-child td{border-bottom:none;}
.nim-tr:hover td{background:#f8f9fc;}
.nim-cell{
  width:100%;border:none;outline:none;background:transparent;
  font-size:13px;color:#111827;font-family:inherit;
  padding:5px 6px;border-radius:5px;transition:background .1s;
}
.nim-cell:focus{background:#eff6ff;box-shadow:0 0 0 2px rgba(37,99,235,.2);}
select.nim-cell{
  -webkit-appearance:none;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E"),none;
  background-repeat:no-repeat;background-position:right 7px center;
  padding-right:26px!important;cursor:pointer;
  border:1px solid #e5e7eb;border-radius:6px;
  transition:border-color .15s,box-shadow .15s;
}
select.nim-cell:focus{border-color:#2563eb;background-color:#eff6ff;box-shadow:0 0 0 2px rgba(37,99,235,.15);}
.nim-num{text-align:right;width:80px;}
.nim-amount{
  font-size:13px;font-weight:600;color:#111827;
  padding-right:12px !important;font-family:monospace;
}
.nim-del-btn{
  background:none;border:none;cursor:pointer;
  color:#d1d5db;padding:3px;border-radius:4px;
  display:grid;place-items:center;transition:.15s;
}
.nim-del-btn:hover{color:#ef4444;background:#fee2e2;}
.nim-table-footer{
  padding:8px 12px;background:#f8f9fc;
  border-top:1px solid #f1f3f7;
}
.nim-add-btn{
  background:none;border:none;cursor:pointer;
  color:#2563eb;font-size:12.5px;font-weight:600;
  display:inline-flex;align-items:center;gap:5px;
  font-family:inherit;padding:3px 6px;border-radius:5px;
  transition:.15s;
}
.nim-add-btn:hover{background:#eff6ff;}
/* Bottom row */
.nim-bottom-row{
  display:flex;gap:20px;align-items:flex-start;margin-top:4px;
}
.nim-totals{
  min-width:260px;border:1.5px solid #e4e8f0;border-radius:9px;
  overflow:hidden;flex-shrink:0;
}
.nim-total-row{
  display:flex;justify-content:space-between;align-items:center;
  padding:9px 14px;border-bottom:1px solid #f1f3f7;
  font-size:13px;
}
.nim-total-label{color:#6b7280;}
.nim-total-val{font-family:monospace;font-weight:600;color:#111827;}
.nim-tax-row{font-size:12px;}
.nim-tax-row .nim-total-label{color:#9ca3af;}
.nim-total-grand{
  display:flex;justify-content:space-between;align-items:center;
  padding:12px 14px;
  background:#eff6ff;
  font-size:15px;font-weight:700;color:#2563eb;
}
/* Footer */
.nim-footer{
  display:flex;align-items:center;justify-content:space-between;
  padding:14px 75px 14px 24px;border-top:1.5px solid #e4e8f0;
  background:#f8f9fc;flex-shrink:0;
}
.nim-btn{
  height:37px;padding:0 18px;border-radius:8px;
  font-size:13.5px;font-weight:600;cursor:pointer;
  font-family:inherit;border:none;transition:all .15s;
  display:inline-flex;align-items:center;gap:7px;white-space:nowrap;
}
.nim-btn:disabled{opacity:.55;cursor:not-allowed;}
.nim-btn-ghost{
  background:#fff;border:1.5px solid #e4e8f0;color:#374151;
}
.nim-btn-ghost:hover:not(:disabled){background:#f1f3f7;}
.nim-btn-outline{
  background:#fff;border:1.5px solid #2563eb;color:#2563eb;
}
.nim-btn-outline:hover:not(:disabled){background:#eff6ff;}
.nim-btn-primary{
  background:#2563eb;color:#fff;
  box-shadow:0 2px 8px rgba(37,99,235,.3);
}
.nim-btn-primary:hover:not(:disabled){background:#1d4ed8;box-shadow:0 4px 12px rgba(37,99,235,.4);}
@keyframes spin{to{transform:rotate(360deg)}}

/* ══ Debit Notes Overhaul ══ */
.dn-sum-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.dn-sum-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px}
.dn-sum-lbl{font-size:11px;color:#868e96;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.dn-sum-val{font-size:20px;font-weight:700;font-family:monospace}
.dn-pill{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:20px;font-size:12.5px;font-weight:600;border:1px solid #e2e8f0;background:#fff;color:#868e96;cursor:pointer;transition:all .15s}
.dn-pill:hover{border-color:#2563eb;color:#2563eb}.dn-pill.active{background:rgba(37,99,235,0.1);border-color:#2563eb;color:#2563eb}
.dn-pc{font-size:11px;font-weight:500;padding:1px 6px;border-radius:10px;margin-left:2px}
.dn-tbl{width:100%;border-collapse:collapse;font-size:13px}
.dn-tbl th{text-align:left;padding:10px 14px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#868e96;font-weight:600;white-space:nowrap;background:#f8f9fc}
.dn-tbl td{padding:11px 14px;border-bottom:1px solid #f1f3f5;vertical-align:middle}
.dn-dh{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:20px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.dn-dh-title{color:#fff;font-size:16px;font-weight:700}
.dn-dh-sub{color:rgba(255,255,255,0.7);font-size:12px;margin-top:2px}
.dn-sec-lbl{font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868e96;margin-bottom:10px;margin-top:20px;display:block;padding-top:20px;border-top:1px solid #e2e8f0}
.dn-sec-lbl:first-child{border-top:none;padding-top:0;margin-top:0}
.dn-fg{display:grid;gap:14px;margin-bottom:14px}.dn-fg2{grid-template-columns:1fr 1fr}.dn-fg3{grid-template-columns:1fr 1fr 1fr}
.dn-fi{width:100%;border:1px solid #cdd5e0;border-radius:6px;padding:8px 10px;font-size:13.5px;color:#1a1d23;background:#fff;outline:none;transition:border-color .15s}
.dn-fi:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,0.1)}
.dn-bill-info{background:#fff3e0;border:1px solid rgba(230,119,0,0.2);border-radius:8px;padding:14px 16px;margin-bottom:16px}
.dn-itbl{width:100%;border-collapse:collapse}
.dn-itbl th{padding:8px 10px;text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#868e96;border-bottom:1px solid #e8ecf0;background:#fafbfc}
.dn-itbl td{padding:7px 8px;border-bottom:1px solid #f1f3f5;vertical-align:middle}
.dn-ci{border:none;outline:none;background:transparent;font-size:13px;color:#1a1d23;width:100%;padding:4px 6px;border-radius:4px}
.dn-ci:focus{background:#eff6ff;box-shadow:0 0 0 2px rgba(37,99,235,0.15)}
.dn-sel{-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 6px center;padding-right:22px;cursor:pointer;border-radius:5px;border:1px solid #e2e8f0;}
.dn-totals{background:#f0f5ff;border:1px solid rgba(37,99,235,0.15);border-radius:8px;overflow:hidden}
.dn-t-row{display:flex;justify-content:space-between;padding:9px 16px;font-size:13px;border-bottom:1px solid rgba(37,99,235,0.08)}
.dn-t-row:last-child{border-bottom:none;font-size:15px;font-weight:700;background:#dbeafe;color:#1e40af}
@media(max-width:640px){
  .nim-grid-3{grid-template-columns:1fr 1fr;}
  .nim-grid-2{grid-template-columns:1fr;}
  .nim-bottom-row{flex-direction:column;}
  .nim-totals{min-width:100%;}
}

/* Payment type toggle */
.nim-type-toggle{
  display:flex;background:#f1f5f9;border-radius:10px;
  padding:4px;gap:4px;
}
.nim-type-btn{
  flex:1;height:36px;border-radius:7px;border:none;
  font-size:13px;font-weight:600;cursor:pointer;
  font-family:inherit;transition:all .18s;
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  color:#6b7280;background:transparent;
}
.nim-type-btn:hover{color:#374151;}
.nim-type-btn.active{
  background:#fff;color:#2563eb;
  box-shadow:0 1px 4px rgba(0,0,0,.12),0 0 0 1px rgba(37,99,235,.15);
}
/* Amount input */
.nim-amount-input{
  font-size:18px !important;font-weight:700 !important;
  color:#111827;letter-spacing:-.01em;
}
/* Outstanding invoices banner */
.nim-invoices-banner{
  background:#f0fdf4;border:1.5px solid #86efac;border-radius:9px;
  padding:12px 14px;font-size:13px;
}
.nim-invoices-title{
  display:flex;align-items:center;gap:6px;
  font-weight:700;color:#16a34a;margin-bottom:8px;font-size:12.5px;
}
.nim-invoice-row{
  display:flex;justify-content:space-between;
  color:#374151;padding:3px 0;font-size:12.5px;
  border-bottom:1px solid rgba(134,239,172,.4);
}
.nim-invoice-row:last-of-type{border-bottom:none;}
.nim-invoice-more{color:#9ca3af;font-size:12px;margin-top:5px;}

/* ══ AI Automator FAB ══ */
body:has(.nim-overlay) .ai-fab,
body:has(.nim-overlay) .ai-panel,
body:has(.cust-backdrop) .ai-fab,
body:has(.cust-backdrop) .ai-panel,
body:has(.coa-drawer-bg) .ai-fab,
body:has(.coa-drawer-bg) .ai-panel,
body:has(.bk-drawer-bg) .ai-fab,
body:has(.bk-drawer-bg) .ai-panel,
body:has(.bk-modal-bg) .ai-fab,
body:has(.bk-modal-bg) .ai-panel,
body:has(.cc-drawer-open) .ai-fab,
body:has(.cc-drawer-open) .ai-panel,
body:has(.fy-drawer-open) .ai-fab,
body:has(.fy-drawer-open) .ai-panel {
  display:none !important;
}
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
.b-badge-purple{background:#f3f0ff;color:#7048e8}
/* PDF view */
.zb-pdf-wrap{flex:1;overflow-y:auto;overflow-x:hidden;background:#f4f6fa;padding:16px;display:flex;flex-direction:column;align-items:center;gap:0;min-width:0}
.zb-pdf-paper{background:#fff;width:100%;max-width:640px;padding:24px 28px;box-shadow:0 2px 16px rgba(0,0,0,.1);border-radius:4px;overflow-x:auto}
.zb-sent-ribbon{position:absolute;top:12px;right:-28px;background:#059669;color:#fff;font-size:10px;font-weight:800;padding:4px 32px;transform:rotate(45deg);letter-spacing:.08em}
.zb-draft-ribbon{position:absolute;top:12px;right:-28px;background:#9ca3af;color:#fff;font-size:10px;font-weight:800;padding:4px 32px;transform:rotate(45deg);letter-spacing:.08em}
.zb-pdf-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid #111827}
.zb-pdf-co-name{font-size:18px;font-weight:800;color:#111827;letter-spacing:-.01em}
.zb-pdf-co-meta{font-size:11px;color:#6b7280;margin-top:2px}
.zb-pdf-inv-title{font-size:22px;font-weight:900;color:#111827;letter-spacing:.04em;text-transform:uppercase}
.zb-pdf-info-table{width:100%;min-width:380px;border-collapse:collapse;margin-bottom:16px;font-size:12px}
.zb-pdf-info-table th{background:#f8f9fc;padding:6px 8px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;border:1px solid #e4e8f0;white-space:nowrap}
.zb-pdf-info-table td{padding:6px 8px;border:1px solid #e4e8f0;color:#374151;white-space:nowrap}
.zb-pdf-bill-section{margin-bottom:16px}
.zb-pdf-bill-label{font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.zb-pdf-bill-name{font-size:14px;font-weight:700;color:#2563eb}
.zb-pdf-items{width:100%;min-width:420px;border-collapse:collapse;margin-bottom:0}
.zb-pdf-th{padding:8px 10px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;background:#f8f9fc;border-bottom:2px solid #e4e8f0;text-align:left}
.zb-pdf-item-row{border-bottom:1px solid #f1f3f7}
.zb-pdf-item-row:hover{background:#f8f9fc}
.zb-pdf-bottom{display:flex;border-top:2px solid #e4e8f0;margin-top:0}
.zb-pdf-words-block{flex:1;padding:12px 10px;border-right:1px solid #e4e8f0;font-size:11px}
.zb-pdf-words-lbl{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af;margin-bottom:3px}
.zb-pdf-words-val{font-size:11px;color:#374151;line-height:1.5}
.zb-pdf-totals-block{width:200px;min-width:160px;padding:8px 12px;display:flex;flex-direction:column;gap:0}
.zb-pdf-total-row{display:flex;justify-content:space-between;font-size:12px;color:#6b7280;padding:4px 0;border-bottom:1px solid #f1f3f7}
.zb-pdf-total-row:last-child{border-bottom:none}
.zb-pdf-total-bold{font-weight:800;font-size:14px;color:#111827;padding:7px 0}
.zb-pdf-balance{font-weight:800;font-size:14px;color:#2563eb;border-top:2px solid #111827!important;padding-top:7px}
.zb-pdf-sig-row{display:flex;justify-content:flex-end;padding:14px 0 6px}
.zb-pdf-sig-box{width:180px;text-align:center;border-top:1px solid #9ca3af;padding-top:5px;font-size:10px;color:#9ca3af}
.zb-pdf-footer{text-align:right;font-size:10px;color:#9ca3af;border-top:1px solid #e4e8f0;padding-top:8px;margin-top:2px}
/* Right panel */
.zb-right-panel{width:220px;flex-shrink:0;border-left:1px solid #e4e8f0;background:#fafbfd;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
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
/* Sidebar top collapse toggle */
.b-collapse-top{
  background:none;border:none;cursor:pointer;
  color:rgba(255,255,255,.7);
  width:28px;height:28px;
  display:flex;align-items:center;justify-content:center;
  border-radius:6px;flex-shrink:0;margin-left:auto;
  transition:background .15s,color .15s;
}
.b-collapse-top:hover{background:rgba(255,255,255,.15);color:#fff;}
/* Topbar expand button — shown when sidebar is collapsed */
.b-topbar-expand{
  background:none;border:1px solid #e2e8f0;cursor:pointer;
  color:#64748b;width:30px;height:30px;
  display:flex;align-items:center;justify-content:center;
  border-radius:6px;flex-shrink:0;
  transition:background .15s,color .15s,border-color .15s;
}
.b-topbar-expand:hover{background:#f1f5f9;color:#1e293b;border-color:#cbd5e1;}
/* When collapsed: B icon becomes the expand button */
.b-brand-icon-expand{cursor:pointer!important;position:relative;}
.b-brand-icon-expand::after{
  content:'›';position:absolute;bottom:-6px;right:-6px;
  width:16px;height:16px;background:rgba(255,255,255,.2);
  border-radius:50%;font-size:11px;line-height:16px;text-align:center;
  color:#fff;font-weight:700;
}
.b-brand-icon-expand:hover{background:rgba(255,255,255,.25)!important;transform:scale(1.07);}
/* Collapsed */
.books-root.collapsed .b-brand-info{opacity:0;width:0;pointer-events:none}
.books-root.collapsed .b-nav-label{opacity:0;width:0;pointer-events:none}
.books-root.collapsed .b-nav-section{opacity:0;height:0;padding:0;margin:0;overflow:hidden}
.books-root.collapsed .b-nav-badge{display:none}
.books-root.collapsed .b-user-info{opacity:0;width:0;overflow:hidden;pointer-events:none}
.books-root.collapsed .b-nav-item{justify-content:center;padding:10px}
.books-root.collapsed .b-nav-icon{margin:0}
.books-root.collapsed .b-logout-btn{justify-content:center}
/* Responsive */
@media(max-width:900px){.b-kpi-grid{grid-template-columns:repeat(2,1fr)!important}.b-mid-grid{grid-template-columns:1fr!important}}
/* ── Invoice list table responsive ── */
@media(max-width:900px){
  .qt-summary{grid-template-columns:repeat(2,1fr)}
  .zb-inv-summary-grid{grid-template-columns:repeat(2,1fr)!important}
}

/* ── Invoice detail: collapse right panel below ~1100px ── */
@media(max-width:1100px){
  .zb-right-panel{width:190px!important;padding:8px!important;font-size:11px!important}
  .zb-panel-row{font-size:11px!important}
}
@media(max-width:950px){
  /* Stack right panel below PDF */
  .zb-detail-area > div[style*="display:flex;flex:1"]{flex-direction:column!important;overflow-y:auto!important}
  .zb-right-panel{width:100%!important;border-left:none!important;border-top:1px solid #e4e8f0;flex-direction:row!important;flex-wrap:wrap!important;gap:8px!important;overflow-y:visible!important}
  .zb-panel-card{flex:1;min-width:180px}
  .zb-pdf-wrap{padding:10px!important}
  .zb-pdf-paper{padding:18px 16px!important}
}

@media(max-width:768px){
  /* Invoice list: hide low-priority columns */
  table th:nth-child(3),table td:nth-child(3){display:none}
  .zb-pdf-wrap{padding:8px!important}
  .zb-pdf-paper{padding:14px 12px!important}
  /* Invoice detail: stack instead of split */
  .zb-master-detail{flex-direction:column!important}
  .zb-split-list{width:100%!important;max-height:42vh;border-right:none!important;border-bottom:1px solid #e4e8f0}
  .zb-detail-area{min-height:0;flex:1;overflow-y:auto}
  /* Action buttons wrap */
  .zb-ab-bar{flex-wrap:wrap!important;gap:6px!important;padding:8px 12px!important}
  .zb-ab-btn{font-size:12px!important;padding:6px 10px!important}
  /* Right info panel stack */
  .zb-info-col{width:100%!important;border-left:none!important;border-top:1px solid #e8ecf0}
  /* NIM modals full screen */
  .nim-modal{width:100vw!important;max-width:100vw!important;
    height:100dvh!important;max-height:100dvh!important;
    border-radius:0!important;top:0!important;left:0!important;transform:none!important;margin:0!important;position:fixed!important;}
  .nim-modal-scroll{max-height:calc(100dvh - 130px)!important;overflow-y:auto}
  .nim-grid-3{grid-template-columns:1fr 1fr!important}
  .nim-grid-2{grid-template-columns:1fr!important}
  .nim-footer{padding:10px 14px!important}
  /* Cust/vendor toolbar */
  .cust-toolbar{flex-direction:column!important;align-items:stretch!important}
  .cust-toolbar-left,.cust-toolbar-right{justify-content:space-between!important;width:100%}
}
@media(max-width:640px){
  /* Show mobile back button in detail view */
  .zb-mob-back{display:flex!important}
  .b-hamburger{display:inline-flex!important}.b-mob-close{display:block!important}
  .books-root{grid-template-columns:1fr!important}
  .b-sidebar{position:fixed;left:-260px;top:0;bottom:0;z-index:50;width:260px!important;transition:left .25s ease}
  .books-root.mobile-open .b-sidebar{left:0!important;box-shadow:4px 0 24px rgba(0,0,0,.25)}
  .books-root.mobile-open .b-mob-overlay{display:block!important}
  .b-right{width:100vw}.b-topbar{padding:0 12px}.b-search{display:none!important}
  .b-main{padding:10px}.b-kpi-grid{grid-template-columns:1fr 1fr!important;gap:8px}
  /* Invoice list page */
  .no-sidebar-pad{overflow-x:hidden}
  /* Pill tabs scroll horizontally */
  .zb-split-pills{flex-wrap:nowrap!important;overflow-x:auto;padding-bottom:6px;scrollbar-width:none}
  .zb-split-pills::-webkit-scrollbar{display:none}
  /* NIM form grids: full single column */
  .nim-grid-3,.nim-grid-2{grid-template-columns:1fr!important}
  /* NIM footer buttons stack */
  .nim-footer{flex-direction:column-reverse!important;gap:8px!important}
  .nim-footer .nim-btn,.nim-footer button{width:100%!important;justify-content:center!important}
  /* Tables: horizontal scroll */
  .cust-table-wrap{overflow-x:auto!important;-webkit-overflow-scrolling:touch}
  .cust-table{min-width:580px}
  .nim-table-wrap{overflow-x:auto!important}
  .nim-table{min-width:460px}
  /* Invoice split view: mobile nav */
  .zb-master-detail{flex-direction:column!important;overflow-y:auto!important}
  .zb-split-list{width:100%!important;max-height:none!important;border-right:none!important}
  .zb-detail-area{width:100%!important}
  /* hide detail panel list column on very small - detail is full screen when navigated */
  .zb-mob-hide-list .zb-split-list{display:none!important}
  .zb-mob-hide-list .zb-detail-area{display:flex!important}
}
@media(max-width:400px){
  .b-kpi-grid{grid-template-columns:1fr!important}
  .b-kpi-value{font-size:20px!important}
  .nim-modal-body,.nim-modal-scroll{padding:10px!important}
  .zb-pdf-paper{padding:10px 8px!important}
}

/* ══════════════════════════════════════════════════
   CHART OF ACCOUNTS
══════════════════════════════════════════════════ */
.coa-page{display:flex;flex-direction:column;gap:0;padding-bottom:72px}
.coa-type-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px}
.coa-type-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;cursor:pointer;transition:all .15s;border-left:3px solid #e2e8f0}
.coa-type-card:hover{transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,.06)}
.coa-type-card.active{transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,.08)}
.coa-type-lbl{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px}
.coa-type-val{font-size:18px;font-weight:700;font-family:monospace}
.coa-type-sub{font-size:11px;color:#868e96;margin-top:2px}

.coa-tbl th{white-space:nowrap}
.coa-row{cursor:pointer;transition:background .12s}
.coa-group-row td{background:#fafbfd}
.coa-group-row:hover td,.coa-leaf-row:hover td{background:#f1f4fd}
.coa-tree-cell{display:flex;align-items:center;padding:9px 14px;gap:0}
.coa-toggle{width:18px;height:18px;border-radius:4px;border:none;background:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;color:#868e96;flex-shrink:0;transition:transform .15s;padding:0}
.coa-toggle.open{transform:rotate(90deg)}
.coa-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block}
.coa-acct-name{font-size:13px;flex:1;margin-left:6px}
.coa-group-chip{font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:10px;margin-left:6px;flex-shrink:0;white-space:nowrap}
.coa-acct-type{font-family:monospace;font-size:11.5px;color:#868e96;margin-left:8px}
.coa-dr{color:#c92a2a}
.coa-cr{color:#2f9e44}

/* COA Drawer */
.coa-drawer-bg{position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.45);display:flex;justify-content:flex-end}
.coa-drawer-panel{width:540px;max-width:95vw;height:100%;background:#fff;display:flex;flex-direction:column;transform:none;box-shadow:-20px 0 60px rgba(0,0,0,.15);overflow:hidden}
.coa-dh{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:20px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.coa-dh-title{color:#fff;font-size:16px;font-weight:700}
.coa-dh-sub{color:rgba(255,255,255,.7);font-size:12px;margin-top:2px}
.coa-dclose{background:rgba(255,255,255,.2);border:none;cursor:pointer;width:30px;height:30px;border-radius:6px;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.coa-dclose:hover{background:rgba(255,255,255,.35)}
.coa-dbody{flex:1;overflow-y:auto;padding:24px}
.coa-dfooter{padding:16px 24px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:10px;background:#f8f9fc;flex-shrink:0}
.coa-sec-lbl{font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#868e96;margin-bottom:10px;margin-top:20px;display:block;padding-top:20px;border-top:1px solid #e2e8f0}
.coa-sec-lbl:first-child{border-top:none;padding-top:0;margin-top:0}
.coa-info-box{background:#eff6ff;border:1px solid rgba(37,99,235,.15);border-radius:8px;padding:12px 14px;font-size:12.5px;color:#2f4ec4;line-height:1.5;margin-bottom:16px;display:flex;align-items:flex-start;gap:8px}
.coa-fg{display:grid;gap:14px;margin-bottom:14px}
.coa-fg2{grid-template-columns:1fr 1fr}
.coa-lbl{display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px}
.coa-fi{width:100%;border:1px solid #cdd5e0;border-radius:6px;padding:8px 10px;font-size:13.5px;font-family:inherit;color:#1a1d23;background:#fff;outline:none;transition:border-color .15s;-webkit-appearance:none;appearance:none}
.coa-fi:focus{border-color:#3b5bdb;box-shadow:0 0 0 3px rgba(59,91,219,.1)}
.coa-fi::placeholder{color:#adb5bd}
select.coa-fi{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;padding-right:28px}

/* b-icon-btn (shared) */
.b-icon-btn{background:none;border:1px solid #e2e8f0;border-radius:5px;cursor:pointer;padding:5px 7px;display:inline-flex;color:#868e96;transition:all .15s;line-height:1}
.b-icon-btn:hover{border-color:#3b5bdb;color:#3b5bdb;background:#eff6ff}
.b-icon-btn.danger{border-color:rgba(201,42,42,.3);color:#c92a2a}
.b-icon-btn.danger:hover{background:rgba(201,42,42,.07)}

@media(max-width:900px){.coa-type-strip{grid-template-columns:repeat(3,1fr)}}
@media(max-width:600px){.coa-type-strip{grid-template-columns:repeat(2,1fr)}.coa-drawer-panel{width:100vw;max-width:100vw}}

/* ══════════════════════════════════════════════════
   JOURNAL ENTRIES
══════════════════════════════════════════════════ */
.jen-page{display:flex;flex-direction:column;padding-bottom:72px}
.jen-info-banner{background:#eef2ff;border:1px solid rgba(59,91,219,.15);border-radius:8px;padding:11px 16px;margin-bottom:16px;font-size:13px;color:#2f4ec4;display:flex;align-items:center;gap:10px;line-height:1.5}
.jen-sum-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.jen-sum-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px}
.jen-sum-lbl{font-size:11px;color:#868e96;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.jen-sum-val{font-size:20px;font-weight:700;font-family:monospace}
.jen-pill{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:20px;font-size:12.5px;font-weight:600;border:1px solid #e2e8f0;background:#fff;color:#868e96;cursor:pointer;transition:all .15s;font-family:inherit}
.jen-pill:hover{border-color:#3b5bdb;color:#1a1d23}
.jen-pill.active{background:#eef2ff;border-color:#3b5bdb;color:#3b5bdb}
.jen-pc{font-size:11px;font-weight:500;padding:1px 6px;border-radius:10px;margin-left:2px}
.jen-date-input{border:1px solid #e2e8f0;border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit;color:#1a1d23;background:#fff;outline:none}
.jen-date-input:focus{border-color:#3b5bdb}

/* JE badge colours */
.je-type-info{background:#eef2ff;color:#3b5bdb}
.je-type-muted{background:#f1f3f5;color:#868e96}
.je-s-draft{background:#f1f3f5;color:#868e96}
.je-s-submitted{background:#ebfbee;color:#2f9e44}
.je-s-cancelled{background:#ffe3e3;color:#c92a2a}

/* JE Drawer (wider) */
.jen-drawer-panel{width:860px;max-width:97vw;height:100%;background:#fff;display:flex;flex-direction:column;box-shadow:-20px 0 60px rgba(0,0,0,.15);overflow:hidden}

/* Template grid */
.jen-tpl-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.jen-tpl-card{border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;cursor:pointer;transition:all .15s}
.jen-tpl-card:hover{border-color:#3b5bdb;background:#eef2ff}
.jen-tpl-card.selected{border-color:#3b5bdb;background:#eef2ff}
.jen-tpl-name{font-size:13px;font-weight:600;margin-bottom:3px}
.jen-tpl-desc{font-size:11.5px;color:#868e96;line-height:1.4}

/* fg4 for JE form */
.jen-fg4{grid-template-columns:1fr 1fr 1fr 1fr}

/* Balance bar */
.jen-balance-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:13px;border:1px solid transparent}
.jen-bal-ok{background:#ebfbee;border-color:rgba(47,158,68,.2);color:#2f9e44}
.jen-bal-err{background:#fff5f5;border-color:rgba(201,42,42,.2);color:#c92a2a}
.jen-bal-zero{background:#f8f9fc;border-color:#e2e8f0;color:#868e96}

/* Add line button */
.jen-add-line-btn{background:none;border:1px solid;border-radius:6px;padding:5px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px;transition:background .12s}

/* JE Lines table */
.jen-lines-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.jen-lines-tbl th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#868e96;border-bottom:1px solid #e8ecf0;background:#fafbfc;white-space:nowrap}
.jen-lines-tbl td{padding:5px 6px;border-bottom:1px solid #f1f3f5;vertical-align:middle}
.jen-total-row td{background:#f0f4ff;border-top:2px solid #e2e8f0}
.jen-ci{border:none;outline:none;background:transparent;font-family:inherit;font-size:12.5px;color:#1a1d23;width:100%;padding:4px 6px;border-radius:4px;-webkit-appearance:none;appearance:none}
.jen-ci:focus{background:#eef2ff;box-shadow:0 0 0 2px rgba(59,91,219,.15)}
select.jen-ci{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 5px center;padding-right:18px;cursor:pointer}

@media(max-width:900px){.jen-sum-strip{grid-template-columns:repeat(2,1fr)}.jen-fg4{grid-template-columns:1fr 1fr}.jen-tpl-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px){.jen-drawer-panel{width:100vw;max-width:100vw}.jen-fg4{grid-template-columns:1fr}.jen-tpl-grid{grid-template-columns:1fr}}

/* ── SearchableSelect ─────────────────────────────────────── */
.ss-wrap{position:relative;width:100%;display:block}
.ss-trigger{
  display:flex;align-items:center;justify-content:space-between;gap:6px;
  width:100%;min-height:36px;padding:7px 10px;
  border:1px solid #dde1e9;border-radius:8px;
  background:#fff;cursor:pointer;font-size:13px;color:#1a1d23;
  box-sizing:border-box;transition:border-color .15s,box-shadow .15s;
  user-select:none;
}
.ss-trigger:hover{border-color:#a5b4fc}
.ss-trigger.open{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.12)}
.ss-trigger.ss-disabled{background:#f9fafb;cursor:not-allowed;opacity:.65}
.ss-trigger.ss-compact{min-height:30px;padding:4px 8px;border-radius:6px;font-size:12px}
.ss-display{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}
.ss-ph{color:#9ca3af}
.ss-caret{flex-shrink:0;display:flex;align-items:center;color:#9ca3af;transition:transform .15s}
.ss-trigger.open .ss-caret{transform:rotate(180deg)}
.ss-drop{
  background:#fff;border:1px solid #e2e8f0;border-radius:10px;
  box-shadow:0 8px 28px rgba(0,0,0,.13);
  animation:ssDropIn .12s ease;
  overflow:hidden;
}
@keyframes ssDropIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.ss-search-row{padding:8px;border-bottom:1px solid #f0f2f5}
.ss-search-input{
  width:100%;padding:6px 10px;border:1px solid #dde1e9;border-radius:6px;
  font-size:13px;outline:none;box-sizing:border-box;background:#f9fafc;
  transition:border-color .15s;
}
.ss-search-input:focus{border-color:#4f46e5;background:#fff}
.ss-opts{max-height:220px;overflow-y:auto}
.ss-opt{
  padding:8px 14px;font-size:13px;cursor:pointer;color:#374151;
  transition:background .1s;border-bottom:1px solid #f7f8fa;
}
.ss-opt:last-child{border-bottom:none}
.ss-opt:hover{background:#f5f7ff;color:#1a1d23}
.ss-opt.ss-opt-sel{background:#eff6ff;color:#2563eb;font-weight:600}
.ss-no-match{padding:14px;text-align:center;color:#9ca3af;font-size:13px}
/* compact variant for table cells */
.ss-wrap.ss-cell-wrap .ss-trigger{border:none;border-radius:4px;background:transparent;padding:4px 6px;min-height:28px;font-size:12px}
.ss-wrap.ss-cell-wrap .ss-trigger:hover{background:#f0f2ff}
.ss-wrap.ss-cell-wrap .ss-trigger.open{background:#f0f2ff;border:1px solid #a5b4fc}

/* ══════════════════════════════════════════════
   BANKING MODULE — .bk-* styles
══════════════════════════════════════════════ */
/* Hero banner */
.bk-hero{background:linear-gradient(135deg,#1a3a6b 0%,#2563eb 60%,#1e40af 100%);border-radius:16px;padding:32px 36px;color:#fff;display:flex;align-items:center;gap:36px;flex-wrap:wrap;margin-bottom:24px}
.bk-hero-lbl{font-size:12px;font-weight:600;letter-spacing:.08em;opacity:.75;text-transform:uppercase;margin-bottom:4px}
.bk-hero-val{font-size:36px;font-weight:800;letter-spacing:-.5px;line-height:1}
.bk-hero-sub{font-size:13px;opacity:.7;margin-top:6px}
.bk-hero-chips{display:flex;gap:12px;flex-wrap:wrap;margin-left:auto}
.bk-hero-chip{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:12px 20px;min-width:110px}
.bk-hc-lbl{font-size:11px;opacity:.7;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}
.bk-hc-val{font-size:18px;font-weight:700}
/* Account cards grid */
.bk-acct-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-bottom:24px}
.bk-acct-card{background:#fff;border:1px solid #e8eaf0;border-radius:14px;padding:20px;cursor:pointer;transition:box-shadow .15s,transform .15s;position:relative;overflow:hidden}
.bk-acct-card:hover{box-shadow:0 6px 24px rgba(0,0,0,.1);transform:translateY(-2px)}
.bk-acct-hdr{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px}
.bk-acct-icon{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.bk-acct-name{font-size:14px;font-weight:700;color:#1a1d23;line-height:1.2}
.bk-acct-bank{font-size:12px;color:#868e96;margin-top:3px}
.bk-acct-num{font-size:12px;color:#adb5bd;font-family:monospace;margin-top:2px}
.bk-acct-bal{font-size:22px;font-weight:800;color:#1a1d23;margin-bottom:4px}
.bk-acct-footer{display:flex;align-items:center;justify-content:space-between;margin-top:14px;padding-top:12px;border-top:1px solid #f1f3f5;font-size:12px;color:#868e96}
.bk-add-card{border:2px dashed #d0d5e8;background:#f9faff;border-radius:14px;padding:20px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:160px;color:#6c7296;transition:border-color .15s,background .15s;gap:8px;font-size:13px;font-weight:600}
.bk-add-card:hover{border-color:#4f46e5;background:#f0f0ff;color:#4f46e5}
/* Reconciliation bar */
.bk-rec-bar{background:#f1f5f9;border-radius:4px;height:6px;overflow:hidden;margin-top:8px}
.bk-rec-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#22c55e,#16a34a);transition:width .4s}
/* Summary strip */
.bk-sum-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:20px}
.bk-sum-card{background:#fff;border:1px solid #e8eaf0;border-radius:12px;padding:14px 16px}
.bk-sum-lbl{font-size:11px;font-weight:600;color:#868e96;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.bk-sum-val{font-size:18px;font-weight:800;color:#1a1d23}
/* Pills / filters */
.bk-pill{padding:5px 13px;border-radius:20px;font-size:12px;font-weight:600;border:1px solid #dde1e9;background:#fff;cursor:pointer;color:#555;transition:all .15s}
.bk-pill.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.bk-pill:hover:not(.active){background:#f0f0ff;border-color:#a5b4fc;color:#4f46e5}
.bk-pc{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 0}
/* Transaction row chip */
.bk-txn-row td{padding:10px 12px;border-bottom:1px solid #f5f7fa;vertical-align:middle;font-size:13px}
.bk-txn-row:hover td{background:#f9faff}
/* Drawer */
.bk-drawer-bg{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9000;display:flex;justify-content:flex-end;backdrop-filter:blur(2px)}
.bk-drawer-panel{width:520px;max-width:95vw;height:100%;background:#fff;box-shadow:-20px 0 60px rgba(0,0,0,.15);display:flex;flex-direction:column}
.bk-drawer-slide-enter-active,.bk-drawer-slide-leave-active{transition:transform .25s cubic-bezier(.4,0,.2,1)}
.bk-drawer-slide-enter-from,.bk-drawer-slide-leave-to{transform:translateX(100%)}
.bk-drawer-fade-enter-active,.bk-drawer-fade-leave-active{transition:opacity .2s}
.bk-drawer-fade-enter-from,.bk-drawer-fade-leave-to{opacity:0}
.bk-dh{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;background:linear-gradient(135deg,#2563eb,#4f46e5);flex-shrink:0}
.bk-dh-left{display:flex;align-items:center;gap:12px}
.bk-dh-icon{width:36px;height:36px;border-radius:9px;background:rgba(255,255,255,.18);display:grid;place-items:center;color:#fff;flex-shrink:0}
.bk-dh h3{margin:0;font-size:16px;font-weight:700;color:#fff;letter-spacing:-.01em}
.bk-dh-sub{font-size:11.5px;color:rgba(255,255,255,.6);margin-top:2px}
.bk-d-close{background:rgba(255,255,255,.15);border:none;cursor:pointer;color:#fff;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;transition:.15s}
.bk-d-close:hover{background:rgba(255,255,255,.28)}
.bk-d-body{flex:1;overflow-y:auto;padding:22px 24px}
.bk-d-footer{padding:16px 24px;border-top:1px solid #f0f2f5;display:flex;gap:10px;justify-content:flex-end;flex-shrink:0;background:#fafbfd}
/* Form layout helpers */
.bk-sec-lbl{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af;margin:20px 0 10px;display:block;border-bottom:1px solid #f0f2f5;padding-bottom:8px}
.bk-sec-lbl:first-child{margin-top:0}
/* .bk-fl = field label (on <label> elements), .bk-fi = field input (on <input>/<select> elements) */
.bk-fl{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin-bottom:5px;display:block}
.bk-fi{width:100%;padding:8px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;font-family:inherit;background:#fff;color:#1a1d23;outline:none;box-sizing:border-box;transition:border-color .15s,box-shadow .15s;appearance:none}
.bk-fi:focus{border-color:#3b5bdb;box-shadow:0 0 0 3px rgba(59,91,219,.1)}
.bk-fi::placeholder{color:#adb5bd}
select.bk-fi{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:28px;cursor:pointer}
.bk-fg{display:grid;gap:14px}
/* Modal overlay */
.bk-modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:9100;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)}
.bk-modal-box{background:#fff;border-radius:16px;padding:28px;width:400px;max-width:94vw;box-shadow:0 24px 80px rgba(0,0,0,.22);animation:bkModalIn .18s ease}
@keyframes bkModalIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
.bk-modal-box h4{font-size:17px;font-weight:700;margin:0 0 8px;color:#1a1d23}
.bk-modal-box p{font-size:13.5px;color:#6b7280;line-height:1.6;margin:0 0 22px}
/* Category grid (12-cell) */
.bk-cat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}
.bk-cat-cell{border:1.5px solid #e8eaf0;border-radius:10px;padding:10px 6px;cursor:pointer;text-align:center;font-size:11px;font-weight:600;color:#374151;transition:all .15s;background:#fff}
.bk-cat-cell:hover{border-color:#a5b4fc;background:#f5f3ff;color:#4f46e5}
.bk-cat-cell.active{border-color:#4f46e5;background:#ede9fe;color:#4f46e5}
.bk-cat-cell .bk-cat-ico{font-size:20px;display:block;margin-bottom:4px}
/* Cheque / Cash tabs */
.bk-tab-bar{display:flex;border-bottom:2px solid #e8eaf0;margin-bottom:20px;gap:0}
.bk-tab-btn{padding:9px 20px;font-size:13px;font-weight:600;color:#868e96;border:none;background:none;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;transition:color .15s,border-color .15s}
.bk-tab-btn.active{color:#4f46e5;border-bottom-color:#4f46e5}
/* Cheque badge variants */
.bk-badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.03em}
.bk-badge-issued{background:#dbeafe;color:#1d4ed8}
.bk-badge-received{background:#dcfce7;color:#166534}
.bk-badge-cleared{background:#f0fdf4;color:#15803d}
.bk-badge-bounced{background:#fee2e2;color:#b91c1c}
.bk-badge-void{background:#f3f4f6;color:#6b7280}
.bk-badge-presented{background:#fef9c3;color:#854d0e}
/* Reconciliation panels */
.bk-recon-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
.bk-recon-panel{border:1px solid #e8eaf0;border-radius:12px;padding:16px;background:#fff}
.bk-recon-panel h4{margin:0 0 12px;font-size:13px;font-weight:700;color:#374151}
.bk-recon-item{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;border:1.5px solid transparent;margin-bottom:6px;transition:all .15s}
.bk-recon-item:hover{background:#f5f7ff;border-color:#a5b4fc}
.bk-recon-item.selected{background:#ede9fe;border-color:#4f46e5;color:#4f46e5}
/* Cash denomination counter */
.bk-denom-grid{display:grid;gap:8px}
.bk-denom-row{display:grid;grid-template-columns:80px 1fr 120px 100px;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;background:#fff;border:1px solid #f0f2f5}
.bk-denom-note{font-size:13px;font-weight:700;color:#374151}
.bk-denom-ctrl{display:flex;align-items:center;gap:8px}
.bk-denom-btn{width:28px;height:28px;border-radius:8px;border:1.5px solid #dde1e9;background:#fff;cursor:pointer;font-size:16px;font-weight:700;color:#374151;display:flex;align-items:center;justify-content:center;transition:all .15s}
.bk-denom-btn:hover{border-color:#4f46e5;color:#4f46e5;background:#f5f3ff}
.bk-denom-inp{width:52px;border:1.5px solid #dde1e9;border-radius:8px;padding:4px 8px;font-size:13px;font-weight:600;text-align:center;outline:none}
.bk-denom-inp:focus{border-color:#4f46e5}
.bk-denom-sub{font-size:12px;color:#868e96;font-style:italic}
.bk-denom-tot{font-size:13px;font-weight:700;color:#1a1d23;text-align:right}
/* Balance panel (book vs bank) */
.bk-bal-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
.bk-bal-card{border-radius:12px;padding:18px;text-align:center}
.bk-bal-card.book{background:#eff6ff;border:1.5px solid #bfdbfe}
.bk-bal-card.bank{background:#f0fdf4;border:1.5px solid #bbf7d0}
.bk-bal-lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;opacity:.7}
.bk-bal-amt{font-size:26px;font-weight:800;color:#1a1d23}
.bk-bal-diff{font-size:13px;font-weight:600;margin-top:6px}
/* Cash hero cards */
.bk-cash-hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
.bk-cash-card{border-radius:14px;padding:20px;color:#fff}
.bk-cash-card.green{background:linear-gradient(135deg,#059669,#10b981)}
.bk-cash-card.blue{background:linear-gradient(135deg,#2563eb,#3b82f6)}
.bk-cash-card.red{background:linear-gradient(135deg,#dc2626,#ef4444)}
.bk-cash-lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;opacity:.8;margin-bottom:6px}
.bk-cash-val{font-size:24px;font-weight:800}
.bk-cash-sub{font-size:11px;opacity:.7;margin-top:4px}
@media(max-width:900px){.bk-recon-cols{grid-template-columns:1fr}.bk-acct-grid{grid-template-columns:1fr}.bk-bal-grid{grid-template-columns:1fr}.bk-cash-hero{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.bk-drawer-panel{width:100vw;max-width:100vw}.bk-cat-grid{grid-template-columns:repeat(3,1fr)}.bk-denom-row{grid-template-columns:70px 1fr 100px 80px}}
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
      { path: "/customers", component: Customers, name: "customers" },
      { path: "/quotes", component: Quotes, name: "quotes" },
      { path: "/sales-orders", component: SalesOrders, name: "sales-orders" },
      { path: "/recurring", component: RecurringInvoices, name: "recurring" },
      { path: "/credit-notes", component: CreditNotes, name: "credit-notes" },
      { path: "/payments-received", component: PaymentsReceived, name: "payments-received" },
      { path: "/eway-bills", component: EwayBills, name: "eway-bills" },
      { path: "/invoices", component: Invoices, name: "invoices" },
      { path: "/invoices/:name", component: InvoiceDetail, name: "invoice-detail" },
      { path: "/template-editor", component: TemplateEditor, name: "template-editor" },
      { path: "/vendors", component: Vendors, name: "vendors" },
      { path: "/purchase-orders", component: PurchaseOrders, name: "purchase-orders" },
      { path: "/purchases", component: Purchases, name: "purchases" },
      { path: "/debit-notes", component: DebitNotes, name: "debit-notes" },
      { path: "/payments", component: Payments, name: "payments" },
      { path: "/banking",                   redirect: "/banking/accounts" },
      { path: "/banking/accounts",          component: BankAccounts,      name: "bank-accounts"      },
      { path: "/banking/transactions",      component: BankTransactions,  name: "bank-transactions"  },
      { path: "/banking/reconciliation",    component: BankReconciliation,name: "bank-reconciliation"},
      { path: "/banking/cheques",           component: ChequeManagement,  name: "cheque-management"  },
      { path: "/banking/cash",              component: CashManagement,    name: "cash-management"    },
      { path: "/accounts", component: Accounts, name: "accounts" },
      { path: "/reports", component: Reports, name: "reports" },
      { path: "/reports/trial-balance", component: Reports, name: "trial-balance", props: { defaultTab: "tb" } },
      { path: "/reports/ar-aging", component: Reports, name: "ar-aging", props: { defaultTab: "aging" } },
      { path: "/accounting/chart-of-accounts", component: ChartOfAccounts, name: "chart-of-accounts" },
      { path: "/accounting/journal-entries", component: JournalEntries, name: "journal-entries" },
      { path: "/accounting/opening-balances", component: OpeningBalances, name: "opening-balances" },
      { path: "/accounting/cost-centers", component: CostCenters, name: "cost-centers" },
      { path: "/accounting/fiscal-years", component: FiscalYears, name: "fiscal-years" },
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
    } catch { }

    return "";
  }

  bootstrapCsrf().then(() => {
    createApp(App).use(router).component("SearchableSelect", SearchableSelect).mount("#books-app");
  });

})();
