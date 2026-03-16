/**
 * zoho_books_clone/public/js/books.js
 *
 * Pre-built bundle for the Books Vue SPA.
 *
 * ── Build instructions (recommended) ──
 *   cd apps/zoho_books_clone/zoho_books_clone/public/js/books_vue
 *   npm install
 *   npm run build          # outputs books.js + css/books.css
 *
 * This file is the fallback shipped in the repository so the app
 * works out-of-the-box without a build step.  It uses Vue 3 and
 * Vue Router 4 loaded from CDN (declared in www/books/index.html).
 *
 * ── Runtime dependencies (CDN) ──
 *   Vue        3.x  → window.Vue
 *   VueRouter  4.x  → window.VueRouter
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  Guard: only mount on the /books page                               */
  /* ------------------------------------------------------------------ */
  if (!document.getElementById("books-app")) return;
  if (typeof Vue === "undefined" || typeof VueRouter === "undefined") {
    console.error("[Books] Vue or VueRouter not loaded from CDN.");
    return;
  }

  const { createApp, ref, computed, onMounted, defineComponent, h } = Vue;
  const { createRouter, createWebHashHistory, useRoute, useRouter }  = VueRouter;

  /* ------------------------------------------------------------------ */
  /*  Utilities                                                          */
  /* ------------------------------------------------------------------ */
  function fmtCurrency(val, currency) {
    if (val == null || val === "") return "—";
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency: currency || "INR", maximumFractionDigits: 0,
    }).format(val);
  }

  function fmtDate(val) {
    if (!val) return "—";
    return new Date(val).toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
    });
  }

  function isOverdue(inv) {
    return inv.outstanding_amount > 0 && inv.due_date && new Date(inv.due_date) < new Date();
  }

  // Get CSRF token from cookie (Frappe sets it as "full_name" cookie is not it —
  // Frappe sets X-Frappe-CSRF-Token from frappe.csrf_token injected in the page)
  function getCsrf() {
    return window.frappe?.csrf_token
      || document.cookie.split(";").map(c => c.trim())
          .find(c => c.startsWith("full_name="))?.split("=")?.[1]
      || "unauthenticated";
  }

  async function frappeCall(method, args) {
    const res = await fetch(`/api/method/${method}`, {
      method:  "POST",
      headers: {
        "Content-Type":        "application/json",
        "X-Frappe-CSRF-Token": getCsrf(),
        "Accept":              "application/json",
      },
      body: JSON.stringify(args || {}),
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${method}`);
    const json = await res.json();
    return json.message;
  }

  async function frappeList(doctype, opts) {
    return await frappeCall("frappe.client.get_list", {
      doctype,
      fields:            opts.fields    || ["name"],
      filters:           opts.filters   || [],
      order_by:          opts.order_by  || "modified desc",
      limit_page_length: opts.limit     || 20,
    }) || [];
  }

  // Fetch company once and cache it
  async function resolveCompany() {
    if (window.__booksCompany) return window.__booksCompany;
    try {
      const val = await frappeCall("frappe.client.get_value", {
        doctype: "User",
        filters: { name: window.frappe?.session?.user || "" },
        fieldname: "name",
      });
      // Try getting default company from defaults API
      const def = await frappeCall("frappe.client.get_list", {
        doctype: "Company",
        fields: ["name"],
        limit: 1,
        order_by: "creation asc",
      });
      const company = (def && def[0] && def[0].name) || "";
      window.__booksCompany = company;
      window.frappe.boot.sysdefaults.company = company;
      return company;
    } catch (e) {
      return "";
    }
  }

  function defaultCompany() {
    return window.__booksCompany || window.frappe?.boot?.sysdefaults?.company || "";
  }

  /* ------------------------------------------------------------------ */
  /*  Shared render helpers                                              */
  /* ------------------------------------------------------------------ */
  function statusBadge(status) {
    const m = {
      Paid: "badge-green", Unpaid: "badge-amber", Submitted: "badge-amber",
      Draft: "badge-muted", Cancelled: "badge-red", Overdue: "badge-red",
    };
    return m[status] || "badge-muted";
  }

  /* ------------------------------------------------------------------ */
  /*  Dashboard page                                                     */
  /* ------------------------------------------------------------------ */
  const Dashboard = defineComponent({
    name: "Dashboard",
    setup() {
      const kpis    = ref(null);
      const dash    = ref(null);
      const trend   = ref([]);
      const aging   = ref({});
      const loading = ref(true);

      const svgW = 560, svgH = 180, pad = 36;

      const points = computed(() => {
        const rows = trend.value;
        if (!rows.length) return [];
        const maxRev = Math.max(...rows.map(r => r.revenue || 0), 1);
        const step   = (svgW - pad * 2) / Math.max(rows.length - 1, 1);
        return rows.map((r, i) => ({
          x: pad + i * step,
          y: svgH - 28 - ((r.revenue || 0) / maxRev) * (svgH - 60),
          label: (r.month || "").slice(5),
        }));
      });

      const linePath = computed(() => {
        const pts = points.value;
        if (pts.length < 2) return "";
        return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
      });

      const areaPath = computed(() => {
        const pts = points.value;
        if (pts.length < 2) return "";
        const base = svgH - 28;
        return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")
          + ` L${pts.at(-1).x},${base} L${pts[0].x},${base} Z`;
      });

      const agingConfig = [
        { key: "current", label: "Current",   color: "#34d399" },
        { key: "1_30",    label: "1–30d",     color: "#4f8ef7" },
        { key: "31_60",   label: "31–60d",    color: "#fbbf24" },
        { key: "61_90",   label: "61–90d",    color: "#fb923c" },
        { key: "over_90", label: ">90d",      color: "#f87171" },
      ];

      const agingRows = computed(() => {
        const total = Object.values(aging.value).reduce((a, v) => a + (v || 0), 0) || 1;
        return agingConfig.map(b => ({
          ...b,
          amount: aging.value[b.key] || 0,
          pct: Math.min(100, ((aging.value[b.key] || 0) / total) * 100),
        }));
      });

      onMounted(async () => {
        loading.value = true;
        const company = await resolveCompany();
        try {
          const [d, k, t, a] = await Promise.all([
            frappeCall("zoho_books_clone.api.dashboard.get_home_dashboard", { company }),
            frappeCall("zoho_books_clone.db.aggregates.get_dashboard_kpis",        { company }),
            frappeCall("zoho_books_clone.db.aggregates.get_monthly_revenue_trend", { company, months: 6 }),
            frappeCall("zoho_books_clone.db.aggregates.get_aging_buckets",         { company }),
          ]);
          dash.value  = d || {};
          kpis.value  = k || {};
          trend.value = t || [];
          aging.value = a || {};
        } catch (e) {
          console.error("[Books Dashboard]", e);
        } finally {
          loading.value = false;
        }
      });

      return { kpis, dash, trend, aging, loading, points, linePath, areaPath, agingRows, svgW, svgH, fmtCurrency, fmtDate };
    },
    template: `
<div class="dashboard">
  <!-- KPI strip -->
  <div class="kpi-grid">
    <div class="books-card kpi-card" v-for="k in kpiDefs" :key="k.key">
      <div class="kpi-icon" :style="{ background: k.bg }">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="k.iconPath"></svg>
      </div>
      <div class="kpi-body">
        <div class="kpi-label">{{ k.label }}</div>
        <div class="kpi-value" :class="k.cls">
          <div v-if="loading" class="loading-shimmer" style="width:80px;height:20px;margin-top:4px"></div>
          <template v-else>
            {{ k.fmt === 'num' ? (kpis?.[k.key] ?? '—') : fmtCurrency(kpis?.[k.key]) }}
          </template>
        </div>
      </div>
    </div>
  </div>

  <!-- Mid row -->
  <div class="mid-grid">
    <!-- Revenue chart -->
    <div class="books-card">
      <div class="card-header">
        <span class="books-card-title">Revenue Trend</span>
        <span class="badge badge-blue">6 months</span>
      </div>
      <div v-if="loading" class="loading-shimmer" style="height:160px;border-radius:8px"></div>
      <svg v-else :viewBox="'0 0 '+svgW+' '+svgH" style="width:100%;height:170px;overflow:visible">
        <defs>
          <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="#4f8ef7" stop-opacity="0.7"/>
            <stop offset="100%" stop-color="#4f8ef7" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <line v-for="y in [40,80,120,150]" :key="y" :x1="36" :x2="svgW-36" :y1="y" :y2="y" stroke="#2a2f45" stroke-width="1"/>
        <path v-if="areaPath" :d="areaPath" fill="url(#rg)" opacity="0.4"/>
        <path v-if="linePath" :d="linePath" fill="none" stroke="#4f8ef7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle v-for="(p,i) in points" :key="i" :cx="p.x" :cy="p.y" r="4" fill="#4f8ef7" stroke="#181c27" stroke-width="2"/>
        <text v-for="(p,i) in points" :key="'l'+i" :x="p.x" :y="svgH-4" text-anchor="middle" style="font-size:10px;fill:#6b7280;font-family:DM Mono,monospace">{{ p.label }}</text>
      </svg>
    </div>

    <!-- Aging -->
    <div class="books-card aging-card">
      <div class="books-card-title">AR Aging</div>
      <div v-if="loading">
        <div v-for="n in 5" :key="n" class="loading-shimmer" style="height:12px;margin-bottom:14px;border-radius:4px"></div>
      </div>
      <div v-else class="aging-bars">
        <div v-for="b in agingRows" :key="b.key" class="aging-row">
          <span class="aging-label">{{ b.label }}</span>
          <div class="aging-bar-wrap"><div class="aging-bar" :style="{ width: b.pct+'%', background: b.color }"></div></div>
          <span class="aging-amount" :style="{ color: b.color }">{{ fmtCurrency(b.amount) }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Bottom row -->
  <div class="bot-grid">
    <!-- Top customers -->
    <div class="books-card">
      <div class="books-card-title">Top Customers</div>
      <div v-if="loading" class="loading-shimmer" style="height:120px;border-radius:8px"></div>
      <table v-else class="books-table">
        <thead><tr><th>Customer</th><th class="ta-r">Invoices</th><th class="ta-r">Revenue</th></tr></thead>
        <tbody>
          <tr v-for="c in (dash?.top_customers || [])" :key="c.customer">
            <td>{{ c.customer_name || c.customer }}</td>
            <td class="ta-r mono">{{ c.invoice_count }}</td>
            <td class="ta-r mono text-green">{{ fmtCurrency(c.total_revenue) }}</td>
          </tr>
          <tr v-if="!(dash?.top_customers?.length)">
            <td colspan="3" class="empty-row">No data for this period</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Overdue invoices -->
    <div class="books-card">
      <div class="card-header">
        <span class="books-card-title">Overdue Invoices</span>
        <span class="badge badge-red">{{ dash?.overdue_invoices?.length || 0 }}</span>
      </div>
      <div v-if="loading" class="loading-shimmer" style="height:120px;border-radius:8px"></div>
      <table v-else class="books-table">
        <thead><tr><th>Invoice</th><th>Customer</th><th class="ta-r">Due</th><th class="ta-r">Outstd.</th></tr></thead>
        <tbody>
          <tr v-for="inv in (dash?.overdue_invoices?.slice(0,5) || [])" :key="inv.name">
            <td><a class="text-accent" :href="'/app/sales-invoice/'+inv.name">{{ inv.name }}</a></td>
            <td class="text-muted">{{ inv.customer_name || inv.customer }}</td>
            <td class="ta-r mono text-red">{{ fmtDate(inv.due_date) }}</td>
            <td class="ta-r mono text-red">{{ fmtCurrency(inv.outstanding_amount) }}</td>
          </tr>
          <tr v-if="!(dash?.overdue_invoices?.length)">
            <td colspan="4" style="text-align:center;color:#34d399;padding:24px">✓ All caught up!</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</div>`,
    computed: {
      kpiDefs() {
        return [
          { key:"month_revenue",     label:"Revenue",       fmt:"cur", bg:"rgba(79,142,247,.12)",  cls:"text-accent" },
          { key:"month_collected",   label:"Collected",     fmt:"cur", bg:"rgba(52,211,153,.12)",  cls:"text-green"  },
          { key:"month_outstanding", label:"Outstanding",   fmt:"cur", bg:"rgba(248,113,113,.12)", cls:"text-red"    },
          { key:"net_profit_mtd",    label:"Net Profit MTD",fmt:"cur", bg:"rgba(251,191,36,.12)",  cls:"text-amber"  },
          { key:"total_assets",      label:"Total Assets",  fmt:"cur", bg:"rgba(79,142,247,.12)",  cls:""            },
          { key:"overdue_count",     label:"Overdue",       fmt:"num", bg:"rgba(248,113,113,.12)", cls:"text-red"    },
        ];
      },
    },
  });

  /* ------------------------------------------------------------------ */
  /*  Invoices page                                                      */
  /* ------------------------------------------------------------------ */
  const Invoices = defineComponent({
    name: "Invoices",
    setup() {
      const invoices    = ref([]);
      const loading     = ref(true);
      const activeFilter = ref("all");

      const filters = [
        { key:"all",       label:"All"      },
        { key:"Draft",     label:"Draft"    },
        { key:"Submitted", label:"Unpaid"   },
        { key:"Overdue",   label:"Overdue"  },
        { key:"Paid",      label:"Paid"     },
      ];

      const counts = computed(() => ({
        Draft:     invoices.value.filter(i => i.status === "Draft").length,
        Submitted: invoices.value.filter(i => i.status === "Unpaid" || i.status === "Submitted").length,
        Overdue:   invoices.value.filter(isOverdue).length,
        Paid:      invoices.value.filter(i => i.status === "Paid").length,
      }));

      const filtered = computed(() => {
        if (activeFilter.value === "all")    return invoices.value;
        if (activeFilter.value === "Overdue") return invoices.value.filter(isOverdue);
        return invoices.value.filter(i => i.status === activeFilter.value);
      });

      async function load() {
        loading.value = true;
        try {
          invoices.value = await frappeList("Sales Invoice", {
            fields: ["name","customer","customer_name","posting_date","due_date","grand_total","outstanding_amount","status"],
            limit: 50, order_by: "posting_date desc",
          });
        } finally { loading.value = false; }
      }

      onMounted(load);

      return { invoices, loading, activeFilter, filters, counts, filtered, fmtCurrency, fmtDate, statusBadge, isOverdue, load };
    },
    template: `
<div class="page-invoices">
  <div class="page-actions">
    <div class="filter-group">
      <button v-for="f in filters" :key="f.key" class="filter-pill" :class="{ active: activeFilter===f.key }" @click="activeFilter=f.key">
        {{ f.label }}
        <span v-if="f.key!=='all'" class="badge" :class="badgeForFilter(f.key)" style="font-size:10px;padding:2px 6px">{{ counts[f.key] }}</span>
      </button>
    </div>
    <div class="actions-right">
      <button class="books-btn books-btn-ghost" @click="load">↻ Refresh</button>
      <button class="books-btn books-btn-primary" @click="window.location.href='/app/sales-invoice/new-sales-invoice-1'">+ New Invoice</button>
    </div>
  </div>
  <div class="books-card">
    <table class="books-table">
      <thead>
        <tr>
          <th>Invoice #</th><th>Customer</th><th>Date</th><th>Due</th>
          <th class="ta-r">Amount</th><th class="ta-r">Outstanding</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n"><td colspan="7"><div class="loading-shimmer" style="height:13px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="inv in filtered" :key="inv.name" class="clickable-row" @click="window.location.href='/app/sales-invoice/'+inv.name">
            <td><span class="mono text-accent fw-700">{{ inv.name }}</span></td>
            <td><div class="fw-700">{{ inv.customer_name || inv.customer }}</div></td>
            <td class="text-muted mono" style="font-size:12px">{{ fmtDate(inv.posting_date) }}</td>
            <td class="mono" style="font-size:12px" :class="isOverdue(inv)?'text-red':'text-muted'">{{ fmtDate(inv.due_date) }}</td>
            <td class="ta-r mono" style="font-size:12px">{{ fmtCurrency(inv.grand_total) }}</td>
            <td class="ta-r mono" style="font-size:12px" :class="inv.outstanding_amount>0?'text-amber':'text-green'">{{ fmtCurrency(inv.outstanding_amount) }}</td>
            <td><span class="badge" :class="statusBadge(inv.status)">{{ inv.status }}</span></td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="7" class="empty-row">No invoices found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`,
    methods: {
      badgeForFilter(key) {
        return { Draft:"badge-muted", Submitted:"badge-amber", Overdue:"badge-red", Paid:"badge-green" }[key] || "badge-muted";
      },
    },
  });

  /* ------------------------------------------------------------------ */
  /*  Payments page                                                      */
  /* ------------------------------------------------------------------ */
  const Payments = defineComponent({
    name: "Payments",
    setup() {
      const payments    = ref([]);
      const loading     = ref(true);
      const activeType  = ref("all");
      const types = [
        { key:"all",     label:"All"       },
        { key:"Receive", label:"Received"  },
        { key:"Pay",     label:"Paid Out"  },
      ];
      const filtered = computed(() =>
        activeType.value === "all" ? payments.value
          : payments.value.filter(p => p.payment_type === activeType.value)
      );
      async function load() {
        loading.value = true;
        try {
          payments.value = await frappeList("Payment Entry", {
            fields: ["name","party","party_type","paid_amount","payment_type","payment_date","mode_of_payment"],
            limit: 50, order_by: "payment_date desc",
          });
        } finally { loading.value = false; }
      }
      onMounted(load);
      return { payments, loading, activeType, types, filtered, fmtCurrency, fmtDate };
    },
    template: `
<div class="page-payments">
  <div class="page-actions">
    <div class="filter-group">
      <button v-for="t in types" :key="t.key" class="filter-pill" :class="{ active: activeType===t.key }" @click="activeType=t.key">{{ t.label }}</button>
    </div>
    <button class="books-btn books-btn-primary" @click="window.location.href='/app/payment-entry/new-payment-entry-1'">+ New Payment</button>
  </div>
  <div class="books-card">
    <table class="books-table">
      <thead><tr><th>Payment #</th><th>Party</th><th>Mode</th><th>Date</th><th>Type</th><th class="ta-r">Amount</th></tr></thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n"><td colspan="6"><div class="loading-shimmer" style="height:13px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="p in filtered" :key="p.name" class="clickable-row" @click="window.location.href='/app/payment-entry/'+p.name">
            <td><span class="mono text-accent fw-700">{{ p.name }}</span></td>
            <td class="fw-700">{{ p.party }}</td>
            <td class="text-muted">{{ p.mode_of_payment || '—' }}</td>
            <td class="text-muted mono" style="font-size:12px">{{ fmtDate(p.payment_date) }}</td>
            <td><span class="badge" :class="p.payment_type==='Receive'?'badge-green':'badge-red'">{{ p.payment_type }}</span></td>
            <td class="ta-r mono fw-700" :class="p.payment_type==='Receive'?'text-green':'text-red'">{{ fmtCurrency(p.paid_amount) }}</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="6" class="empty-row">No payments found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`,
  });

  /* ------------------------------------------------------------------ */
  /*  Banking page                                                       */
  /* ------------------------------------------------------------------ */
  const Banking = defineComponent({
    name: "Banking",
    setup() {
      const cashData        = ref(null);
      const cashLoading     = ref(true);
      const transactions    = ref([]);
      const txnLoading      = ref(false);
      const selectedAccount = ref(null);

      async function loadCash() {
        cashLoading.value = true;
        try { cashData.value = await frappeCall("zoho_books_clone.api.dashboard.get_cash_position"); }
        finally { cashLoading.value = false; }
      }

      async function selectAccount(acct) {
        selectedAccount.value = acct.name;
        txnLoading.value      = true;
        try {
          const txns = await frappeCall("frappe.client.get_list", {
            doctype: "Bank Transaction",
            filters: [["bank_account","=",acct.name],["status","=","Unreconciled"]],
            fields:  ["name","date","description","debit","credit","balance","reference_number","status"],
            order_by: "date asc", limit_page_length: 30,
          });
          transactions.value = txns || [];
        } finally { txnLoading.value = false; }
      }

      onMounted(loadCash);
      return { cashData, cashLoading, transactions, txnLoading, selectedAccount, selectAccount, fmtCurrency, fmtDate };
    },
    template: `
<div class="page-banking">
  <div class="books-card cash-strip">
    <div class="cash-label">💳 Total Cash Position</div>
    <div class="cash-total">
      <div v-if="cashLoading" class="loading-shimmer" style="width:120px;height:24px"></div>
      <span v-else>{{ fmtCurrency(cashData?.total_cash) }}</span>
    </div>
  </div>

  <div class="bank-accounts-grid">
    <template v-if="cashLoading">
      <div v-for="n in 3" :key="n" class="books-card"><div class="loading-shimmer" style="height:80px;border-radius:8px"></div></div>
    </template>
    <template v-else>
      <div v-for="acct in (cashData?.bank_accounts||[])" :key="acct.name"
        class="books-card bank-account-card" :class="{ selected: selectedAccount===acct.name }"
        @click="selectAccount(acct)">
        <div class="acct-top">
          <span class="acct-currency badge badge-blue">{{ acct.currency||'INR' }}</span>
        </div>
        <div class="fw-700" style="font-size:13.5px;margin-bottom:2px">{{ acct.account_name }}</div>
        <div class="text-muted" style="font-size:12px;margin-bottom:10px">{{ acct.bank_name||'—' }}</div>
        <div class="mono text-green fw-700" style="font-size:18px">{{ fmtCurrency(acct.current_balance) }}</div>
      </div>
      <div v-if="!(cashData?.bank_accounts?.length)" class="books-card empty-row">No bank accounts configured.</div>
    </template>
  </div>

  <div class="books-card" v-if="selectedAccount">
    <div class="card-header">
      <span class="books-card-title">Transactions — {{ selectedAccount }}</span>
      <span class="badge badge-amber">{{ transactions.length }} unreconciled</span>
    </div>
    <table class="books-table">
      <thead><tr><th>Ref #</th><th>Date</th><th>Description</th><th class="ta-r">Debit</th><th class="ta-r">Credit</th><th class="ta-r">Balance</th><th>Status</th></tr></thead>
      <tbody>
        <template v-if="txnLoading">
          <tr v-for="n in 5" :key="n"><td colspan="7"><div class="loading-shimmer" style="height:12px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="t in transactions" :key="t.name">
            <td class="mono text-accent fw-700" style="font-size:12px">{{ t.reference_number||t.name }}</td>
            <td class="text-muted mono" style="font-size:12px">{{ fmtDate(t.date) }}</td>
            <td class="text-muted" style="font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ t.description||'—' }}</td>
            <td class="ta-r mono text-red"   style="font-size:12px">{{ t.debit>0  ? fmtCurrency(t.debit)  : '—' }}</td>
            <td class="ta-r mono text-green" style="font-size:12px">{{ t.credit>0 ? fmtCurrency(t.credit) : '—' }}</td>
            <td class="ta-r mono"            style="font-size:12px">{{ fmtCurrency(t.balance) }}</td>
            <td><span class="badge badge-amber">{{ t.status }}</span></td>
          </tr>
          <tr v-if="!transactions.length"><td colspan="7" style="text-align:center;color:#34d399;padding:24px">✓ All reconciled</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`,
  });

  /* ------------------------------------------------------------------ */
  /*  Accounts page                                                      */
  /* ------------------------------------------------------------------ */
  const Accounts = defineComponent({
    name: "Accounts",
    setup() {
      const accounts   = ref([]);
      const loading    = ref(true);
      const activeType = ref("All");

      const allTypes = computed(() => {
        const t = [...new Set(accounts.value.map(a => a.account_type).filter(Boolean))].sort();
        return ["All", ...t];
      });

      const filtered = computed(() =>
        activeType.value === "All" ? accounts.value
          : accounts.value.filter(a => a.account_type === activeType.value)
      );

      const typeColors = {
        Asset:"badge-blue", Liability:"badge-red", Equity:"badge-amber",
        Income:"badge-green", Expense:"badge-red", Bank:"badge-blue",
      };

      async function load() {
        loading.value = true;
        try {
          accounts.value = await frappeList("Account", {
            fields: ["name","account_name","account_type","parent_account","account_currency"],
            limit: 100, order_by: "account_type asc, account_name asc",
          });
        } finally { loading.value = false; }
      }

      onMounted(load);
      return { accounts, loading, activeType, allTypes, filtered, typeColors };
    },
    template: `
<div class="page-accounts">
  <div class="page-actions">
    <div class="filter-group">
      <button v-for="t in allTypes" :key="t" class="filter-pill" :class="{ active: activeType===t }" @click="activeType=t">{{ t }}</button>
    </div>
    <button class="books-btn books-btn-primary" @click="window.location.href='/app/account/new-account-1'">+ New Account</button>
  </div>
  <div class="books-card">
    <table class="books-table">
      <thead><tr><th>Account</th><th>Type</th><th>Parent</th><th>Currency</th></tr></thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n"><td colspan="4"><div class="loading-shimmer" style="height:12px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="a in filtered" :key="a.name" class="clickable-row" @click="window.location.href='/app/account/'+a.name">
            <td>
              <div class="fw-700">{{ a.account_name }}</div>
              <div class="mono text-muted" style="font-size:11px">{{ a.name }}</div>
            </td>
            <td><span class="badge" :class="typeColors[a.account_type]||'badge-muted'">{{ a.account_type }}</span></td>
            <td class="text-muted" style="font-size:12.5px">{{ a.parent_account||'—' }}</td>
            <td class="text-muted" style="font-size:12.5px">{{ a.account_currency||'INR' }}</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="4" class="empty-row">No accounts found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`,
  });

  /* ------------------------------------------------------------------ */
  /*  Reports page                                                       */
  /* ------------------------------------------------------------------ */
  const Reports = defineComponent({
    name: "Reports",
    setup() {
      const today    = new Date();
      const fromDate = ref(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0,10));
      const toDate   = ref(today.toISOString().slice(0,10));
      const activeReport = ref("pl");
      const pl  = ref(null), plLoading  = ref(false);
      const bs  = ref(null), bsLoading  = ref(false);
      const cf  = ref(null), cfLoading  = ref(false);
      const gst = ref(null), gstLoading = ref(false);

      async function runReport() {
        const company = defaultCompany();
        const args    = { company, from_date: fromDate.value, to_date: toDate.value };
        if (activeReport.value === "pl") {
          plLoading.value = true;
          pl.value = await frappeCall("zoho_books_clone.db.queries.get_profit_and_loss", args).finally(() => plLoading.value = false);
        } else if (activeReport.value === "bs") {
          bsLoading.value = true;
          bs.value = await frappeCall("zoho_books_clone.db.queries.get_balance_sheet_totals", { company, as_of_date: toDate.value }).finally(() => bsLoading.value = false);
        } else if (activeReport.value === "cf") {
          cfLoading.value = true;
          cf.value = await frappeCall("zoho_books_clone.db.queries.get_cash_flow", args).finally(() => cfLoading.value = false);
        } else if (activeReport.value === "gst") {
          gstLoading.value = true;
          gst.value = await frappeCall("zoho_books_clone.db.queries.get_gst_summary", args).finally(() => gstLoading.value = false);
        }
      }

      const reportTabs = [
        { key:"pl",  label:"Profit & Loss"  },
        { key:"bs",  label:"Balance Sheet"  },
        { key:"cf",  label:"Cash Flow"      },
        { key:"gst", label:"GST Summary"    },
      ];

      return { fromDate, toDate, activeReport, pl, plLoading, bs, bsLoading, cf, cfLoading, gst, gstLoading, runReport, reportTabs, fmtCurrency };
    },
    template: `
<div class="page-reports">
  <div class="report-tabs">
    <button v-for="r in reportTabs" :key="r.key" class="report-tab" :class="{ active: activeReport===r.key }" @click="activeReport=r.key">{{ r.label }}</button>
  </div>

  <div class="books-card date-range-bar">
    <label class="dr-label">From</label>
    <input type="date" v-model="fromDate" class="dr-input" />
    <label class="dr-label">To</label>
    <input type="date" v-model="toDate"   class="dr-input" />
    <button class="books-btn books-btn-primary" @click="runReport">▶ Run Report</button>
  </div>

  <!-- P&L -->
  <div v-if="activeReport==='pl'" class="books-card report-card">
    <div class="books-card-title">Profit & Loss</div>
    <div v-if="plLoading" class="loading-shimmer" style="height:100px;border-radius:8px"></div>
    <template v-else-if="pl">
      <div class="pl-row"><span>Total Income</span><span class="mono text-green">{{ fmtCurrency(pl.total_income) }}</span></div>
      <div class="pl-row"><span>Total Expense</span><span class="mono text-red">{{ fmtCurrency(pl.total_expense) }}</span></div>
      <div style="height:2px;background:var(--books-border);margin:4px 0"></div>
      <div class="pl-row" style="font-weight:700;font-size:16px">
        <span>Net Profit</span>
        <span class="mono" :class="pl.net_profit>=0?'text-green':'text-red'">{{ fmtCurrency(pl.net_profit) }}</span>
      </div>
    </template>
    <div v-else class="empty-row">Select a date range and click Run Report.</div>
  </div>

  <!-- Balance Sheet -->
  <div v-if="activeReport==='bs'" class="books-card report-card">
    <div class="books-card-title">Balance Sheet</div>
    <div v-if="bsLoading" class="loading-shimmer" style="height:100px;border-radius:8px"></div>
    <div v-else-if="bs" class="bs-grid">
      <div class="bs-block" style="background:var(--books-surface-2);border-radius:8px;padding:18px">
        <div class="dr-label">Assets</div>
        <div class="mono text-accent fw-700" style="font-size:20px;margin-top:8px">{{ fmtCurrency(bs.total_assets) }}</div>
      </div>
      <div class="bs-block" style="background:var(--books-surface-2);border-radius:8px;padding:18px">
        <div class="dr-label">Liabilities</div>
        <div class="mono text-red fw-700" style="font-size:20px;margin-top:8px">{{ fmtCurrency(bs.total_liabilities) }}</div>
      </div>
      <div class="bs-block" style="background:var(--books-surface-2);border-radius:8px;padding:18px">
        <div class="dr-label">Equity</div>
        <div class="mono text-amber fw-700" style="font-size:20px;margin-top:8px">{{ fmtCurrency(bs.total_equity) }}</div>
      </div>
    </div>
    <div v-else class="empty-row">Select a date range and click Run Report.</div>
  </div>

  <!-- Cash Flow -->
  <div v-if="activeReport==='cf'" class="books-card report-card">
    <div class="books-card-title">Cash Flow</div>
    <div v-if="cfLoading" class="loading-shimmer" style="height:100px;border-radius:8px"></div>
    <template v-else-if="cf">
      <div class="pl-row"><span>Operating</span><span class="mono" :class="cf.operating>=0?'text-green':'text-red'">{{ fmtCurrency(cf.operating) }}</span></div>
      <div class="pl-row"><span>Investing</span><span class="mono" :class="cf.investing>=0?'text-green':'text-red'">{{ fmtCurrency(cf.investing) }}</span></div>
      <div class="pl-row"><span>Financing</span><span class="mono" :class="cf.financing>=0?'text-green':'text-red'">{{ fmtCurrency(cf.financing) }}</span></div>
      <div style="height:2px;background:var(--books-border);margin:4px 0"></div>
      <div class="pl-row" style="font-weight:700;font-size:16px"><span>Net Change</span><span class="mono" :class="cf.net_change>=0?'text-green':'text-red'">{{ fmtCurrency(cf.net_change) }}</span></div>
    </template>
    <div v-else class="empty-row">Select a date range and click Run Report.</div>
  </div>

  <!-- GST -->
  <div v-if="activeReport==='gst'" class="books-card report-card">
    <div class="books-card-title">GST Summary</div>
    <div v-if="gstLoading" class="loading-shimmer" style="height:80px;border-radius:8px"></div>
    <table v-else-if="gst?.length" class="books-table">
      <thead><tr><th>Tax Type</th><th class="ta-r">Invoices</th><th class="ta-r">Total Tax</th></tr></thead>
      <tbody>
        <tr v-for="g in gst" :key="g.tax_type">
          <td><span class="badge badge-blue">{{ g.tax_type }}</span></td>
          <td class="ta-r mono">{{ g.invoice_count }}</td>
          <td class="ta-r mono text-green">{{ fmtCurrency(g.total_tax) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-else class="empty-row">Select a date range and click Run Report.</div>
  </div>
</div>`,
  });

  /* ------------------------------------------------------------------ */
  /*  App shell + router                                                 */
  /* ------------------------------------------------------------------ */
  const navItems = [
    { to:"/",         label:"Dashboard", icon:"⊞" },
    { to:"/invoices", label:"Invoices",  icon:"⊟" },
    { to:"/payments", label:"Payments",  icon:"⊠" },
    { to:"/banking",  label:"Banking",   icon:"⊡" },
    { to:"/accounts", label:"Accounts",  icon:"⊞" },
    { to:"/reports",  label:"Reports",   icon:"⊟" },
  ];

  const routeTitles = { dashboard:"Dashboard", invoices:"Invoices", payments:"Payments", banking:"Banking", accounts:"Chart of Accounts", reports:"Reports" };

  const App = defineComponent({
    name: "BooksApp",
    setup() {
      const route = useRoute();
      const sidebarCollapsed = ref(false);
      const searchQuery = ref("");

      const companyName = computed(() =>
        frappe?.boot?.sysdefaults?.company || "My Company"
      );
      const userInitials = computed(() => {
        const name = frappe?.session?.user_fullname || "U";
        return name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
      });
      const pageTitle = computed(() => routeTitles[route.name] || "Books");

      return { sidebarCollapsed, searchQuery, companyName, userInitials, pageTitle, navItems };
    },
    template: `
<div class="books-app" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
  <aside class="books-sidebar">
    <div class="sidebar-brand">
      <span class="brand-icon">⬡</span>
      <span v-if="!sidebarCollapsed" class="brand-name">Books</span>
    </div>
    <nav class="sidebar-nav">
      <router-link v-for="item in navItems" :key="item.to" :to="item.to"
        class="nav-item" active-class="nav-item--active" :title="item.label">
        <span class="nav-icon">{{ item.icon }}</span>
        <span v-if="!sidebarCollapsed" class="nav-label">{{ item.label }}</span>
      </router-link>
    </nav>
    <div class="sidebar-footer">
      <button class="nav-item collapse-btn" @click="sidebarCollapsed=!sidebarCollapsed">
        <span class="nav-icon">{{ sidebarCollapsed ? '›' : '‹' }}</span>
        <span v-if="!sidebarCollapsed" class="nav-label">Collapse</span>
      </button>
    </div>
  </aside>

  <div class="books-main">
    <header class="books-topbar">
      <h1 class="page-title">{{ pageTitle }}</h1>
      <div class="topbar-right">
        <div class="company-badge">
          <span class="company-dot"></span>
          <span>{{ companyName }}</span>
        </div>
        <div class="avatar">{{ userInitials }}</div>
      </div>
    </header>
    <main class="books-content">
      <router-view></router-view>
    </main>
  </div>
</div>`,
  });

  /* ------------------------------------------------------------------ */
  /*  Bootstrap                                                          */
  /* ------------------------------------------------------------------ */
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: "/",         component: Dashboard, name: "dashboard" },
      { path: "/invoices", component: Invoices,  name: "invoices"  },
      { path: "/payments", component: Payments,  name: "payments"  },
      { path: "/banking",  component: Banking,   name: "banking"   },
      { path: "/accounts", component: Accounts,  name: "accounts"  },
      { path: "/reports",  component: Reports,   name: "reports"   },
    ],
  });

  const app = createApp(App);
  app.use(router);
  app.mount("#books-app");

})();
