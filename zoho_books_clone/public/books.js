(function () {
  "use strict";

  if (!document.getElementById("books-app")) return;
  if (typeof Vue === "undefined" || typeof VueRouter === "undefined") {
    console.error("[Books] Vue or VueRouter not loaded.");
    return;
  }

  const { createApp, ref, computed, onMounted, defineComponent } = Vue;
  const { createRouter, createWebHashHistory, useRoute } = VueRouter;

  /* ── Utils ── */
  function fmt(val, cur) {
    if (val == null || val === "") return "—";
    return new Intl.NumberFormat("en-IN", { style:"currency", currency: cur||"INR", maximumFractionDigits:0 }).format(val);
  }
  function fmtDate(val) {
    if (!val) return "—";
    return new Date(val).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
  }
  function isOverdue(inv) {
    return inv.outstanding_amount > 0 && inv.due_date && new Date(inv.due_date) < new Date();
  }
  function getCsrf() { return window.frappe?.csrf_token || ""; }

  async function api(method, args) {
    const r = await fetch("/api/method/" + method, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type":"application/json", "X-Frappe-CSRF-Token": getCsrf(), "Accept":"application/json" },
      body: JSON.stringify(args || {})
    });
    if (!r.ok) throw new Error(r.status + " " + method);
    return (await r.json()).message;
  }

  async function apiList(doctype, opts) {
    return await api("frappe.client.get_list", {
      doctype, fields: opts.fields||["name"], filters: opts.filters||[],
      order_by: opts.order||"modified desc", limit_page_length: opts.limit||50
    }) || [];
  }

  function company() { return window.__booksCompany || window.frappe?.boot?.sysdefaults?.company || ""; }

  async function resolveCompany() {
    if (window.__booksCompany) return window.__booksCompany;
    try {
      const rows = await apiList("Company", { fields:["name"], limit:1 });
      const c = rows?.[0]?.name || "";
      window.__booksCompany = c;
      if (window.frappe?.boot?.sysdefaults) window.frappe.boot.sysdefaults.company = c;
      return c;
    } catch { return ""; }
  }

  /* ── SVG Icons ── */
  const ICONS = {
    grid:    '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" rx="1"/>',
    doc:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    pay:     '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
    bank:    '<path d="M3 22h18M6 18v-7m4 7v-7m4 7v-7m4 7v-7M3 7l9-5 9 5H3z"/>',
    accts:   '<path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM12 14v-4M8 14v-2M16 14v-3"/>',
    reports: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    chevL:   '<polyline points="15 18 9 12 15 6"/>',
    chevR:   '<polyline points="9 18 15 12 9 6"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    plus:    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    search:  '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
    dollar:  '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    check:   '<polyline points="20 6 9 17 4 12"/>',
    alert:   '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    trend:   '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    bag:     '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
    warn:    '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  };
  function icon(k, size) {
    size = size || 16;
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]||''}</svg>`;
  }

  function statusBadge(s) {
    return { Paid:"b-badge-green", Unpaid:"b-badge-amber", Submitted:"b-badge-amber",
             Draft:"b-badge-muted", Cancelled:"b-badge-red" }[s] || "b-badge-muted";
  }

  /* ================================================================
     DASHBOARD
  ================================================================ */
  const Dashboard = defineComponent({ name:"Dashboard",
    setup() {
      const kpis=ref(null), dash=ref(null), trend=ref([]), aging=ref({});
      const loading=ref(true);
      const SVG_W=580, SVG_H=180, PAD=40;

      const points = computed(() => {
        const rows = trend.value; if (!rows.length) return [];
        const max = Math.max(...rows.map(r=>r.revenue||0), 1);
        const step = (SVG_W - PAD*2) / Math.max(rows.length-1, 1);
        return rows.map((r,i) => ({
          x: PAD + i*step,
          y: SVG_H - 26 - ((r.revenue||0)/max)*(SVG_H-56),
          lbl: (r.month||"").slice(5)
        }));
      });
      const linePath = computed(() => {
        const p=points.value; if (p.length<2) return "";
        return p.map((pt,i)=>`${i===0?"M":"L"}${pt.x},${pt.y}`).join(" ");
      });
      const areaPath = computed(() => {
        const p=points.value; if (p.length<2) return "";
        const base = SVG_H-26;
        return p.map((pt,i)=>`${i===0?"M":"L"}${pt.x},${pt.y}`).join(" ")
          + ` L${p.at(-1).x},${base} L${p[0].x},${base} Z`;
      });

      const agingCfg = [
        {k:"current",lbl:"Current",  c:"var(--green)"},
        {k:"1_30",   lbl:"1-30d",   c:"var(--accent)"},
        {k:"31_60",  lbl:"31-60d",  c:"var(--amber)"},
        {k:"61_90",  lbl:"61-90d",  c:"#f97316"},
        {k:"over_90",lbl:">90d",    c:"var(--red)"},
      ];
      const agingRows = computed(() => {
        const a = aging.value || {};
        const total = Object.values(a).reduce((s,v)=>s+(v||0),0)||1;
        return agingCfg.map(b=>({...b, amt:a[b.k]||0, pct:Math.min(100,((a[b.k]||0)/total)*100)}));
      });

      const kpiDefs = [
        {k:"month_revenue",    lbl:"Revenue",    icon:"dollar", bg:"var(--accent-dim)",  c:"var(--accent)"},
        {k:"month_collected",  lbl:"Collected",  icon:"check",  bg:"var(--green-dim)",   c:"var(--green)"},
        {k:"month_outstanding",lbl:"Outstanding",icon:"alert",  bg:"var(--amber-dim)",   c:"var(--amber)"},
        {k:"net_profit_mtd",   lbl:"Net Profit", icon:"trend",  bg:"var(--purple-dim)",  c:"var(--purple)"},
        {k:"total_assets",     lbl:"Assets",     icon:"bag",    bg:"var(--accent-dim)",  c:"var(--accent)"},
        {k:"overdue_count",    lbl:"Overdue",    icon:"warn",   bg:"var(--red-dim)",     c:"var(--red)"},
      ];

      onMounted(async()=>{
        loading.value=true;
        const co = await resolveCompany();
        try {
          const [d,k,t,a] = await Promise.all([
            api("zoho_books_clone.api.dashboard.get_home_dashboard",{company:co}),
            api("zoho_books_clone.db.aggregates.get_dashboard_kpis",{company:co}),
            api("zoho_books_clone.db.aggregates.get_monthly_revenue_trend",{company:co,months:6}),
            api("zoho_books_clone.db.aggregates.get_aging_buckets",{company:co}),
          ]);
          dash.value=d||{}; kpis.value=k||{}; trend.value=t||[]; aging.value=a||{};
        } catch(e){ console.error("[Books Dashboard]",e); }
        finally { loading.value=false; }
      });

      return {kpis,dash,trend,aging,loading,points,linePath,areaPath,agingRows,kpiDefs,SVG_W,SVG_H,PAD,fmt,fmtDate,icon};
    },
    template:`
<div class="b-page" style="display:flex;flex-direction:column;gap:16px">

  <!-- KPIs -->
  <div class="b-kpi-grid">
    <div v-for="k in kpiDefs" :key="k.k" class="b-kpi" :style="{'--kpi-bg':k.bg,'--kpi-color':k.c}">
      <div class="b-kpi-top">
        <div class="b-kpi-icon" v-html="icon(k.icon,16)"></div>
      </div>
      <div class="b-kpi-label">{{k.lbl}}</div>
      <div class="b-kpi-value">
        <div v-if="loading" class="b-shimmer" style="height:22px;width:80px"></div>
        <template v-else>{{fmt(kpis?.[k.k])}}</template>
      </div>
    </div>
  </div>

  <!-- Mid row -->
  <div class="b-mid-grid">
    <!-- Revenue chart -->
    <div class="b-card">
      <div class="b-card-header">
        <span class="b-section-label">Revenue Trend</span>
        <span class="b-badge b-badge-blue">6 months</span>
      </div>
      <div v-if="loading" class="b-shimmer" style="height:160px"></div>
      <svg v-else class="b-chart-svg" :viewBox="'0 0 '+SVG_W+' '+SVG_H" style="height:168px;overflow:visible">
        <defs>
          <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.4"/>
            <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <line v-for="y in [40,80,120,150]" :key="y" :x1="PAD" :x2="SVG_W-PAD" :y1="y" :y2="y" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
        <path v-if="areaPath" :d="areaPath" fill="url(#rg)"/>
        <path v-if="linePath" :d="linePath" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle v-for="(p,i) in points" :key="i" :cx="p.x" :cy="p.y" r="4" fill="#3b82f6" stroke="var(--surface)" stroke-width="2" class="b-chart-dot"/>
        <text v-for="(p,i) in points" :key="'l'+i" :x="p.x" :y="SVG_H-4" text-anchor="middle" style="font-size:10px;fill:var(--text-3);font-family:Geist Mono,monospace">{{p.lbl}}</text>
      </svg>
    </div>

    <!-- AR Aging -->
    <div class="b-card">
      <div class="b-card-header"><span class="b-section-label">AR Aging</span></div>
      <div v-if="loading">
        <div v-for="n in 5" :key="n" class="b-shimmer" style="height:12px;margin-bottom:14px"></div>
      </div>
      <div v-else class="b-aging-rows">
        <div v-for="b in agingRows" :key="b.k" class="b-aging-row">
          <span class="b-aging-lbl">{{b.lbl}}</span>
          <div class="b-aging-track"><div class="b-aging-fill" :style="{width:b.pct+'%',background:b.c}"></div></div>
          <span class="b-aging-amt" :style="{color:b.c}">{{fmt(b.amt)}}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Bottom row -->
  <div class="b-bot-grid">
    <!-- Top customers -->
    <div class="b-card">
      <div class="b-card-header"><span class="b-section-label">Top Customers</span></div>
      <div v-if="loading" class="b-shimmer" style="height:120px"></div>
      <table v-else class="b-table">
        <thead><tr><th>Customer</th><th class="ta-r">Invoices</th><th class="ta-r">Revenue</th></tr></thead>
        <tbody>
          <tr v-for="c in (dash?.top_customers||[])" :key="c.customer">
            <td class="fw-600">{{c.customer_name||c.customer}}</td>
            <td class="ta-r mono">{{c.invoice_count}}</td>
            <td class="ta-r mono c-green">{{fmt(c.total_revenue)}}</td>
          </tr>
          <tr v-if="!(dash?.top_customers?.length)"><td colspan="3" class="b-empty">No data for this period</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Overdue -->
    <div class="b-card">
      <div class="b-card-header">
        <span class="b-section-label">Overdue Invoices</span>
        <span class="b-badge b-badge-red">{{dash?.overdue_invoices?.length||0}}</span>
      </div>
      <div v-if="loading" class="b-shimmer" style="height:120px"></div>
      <table v-else class="b-table">
        <thead><tr><th>Invoice</th><th>Customer</th><th class="ta-r">Due</th><th class="ta-r">Outstd.</th></tr></thead>
        <tbody>
          <tr v-for="inv in (dash?.overdue_invoices?.slice(0,5)||[])" :key="inv.name">
            <td><a class="c-accent mono" :href="'/app/sales-invoice/'+inv.name">{{inv.name}}</a></td>
            <td class="c-muted">{{inv.customer_name||inv.customer}}</td>
            <td class="ta-r mono c-red">{{fmtDate(inv.due_date)}}</td>
            <td class="ta-r mono c-red">{{fmt(inv.outstanding_amount)}}</td>
          </tr>
          <tr v-if="!(dash?.overdue_invoices?.length)">
            <td colspan="4" style="text-align:center;padding:24px;color:var(--green)">✓ All caught up!</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</div>`
  });

  /* ================================================================
     INVOICES
  ================================================================ */
  const Invoices = defineComponent({ name:"Invoices",
    setup() {
      const list=ref([]), loading=ref(true), active=ref("all");
      const filters=[
        {k:"all",lbl:"All"},{k:"Draft",lbl:"Draft"},{k:"Submitted",lbl:"Unpaid"},
        {k:"Overdue",lbl:"Overdue"},{k:"Paid",lbl:"Paid"}
      ];
      const counts=computed(()=>({
        Draft:    list.value.filter(i=>i.status==="Draft").length,
        Submitted:list.value.filter(i=>i.status==="Unpaid"||i.status==="Submitted").length,
        Overdue:  list.value.filter(isOverdue).length,
        Paid:     list.value.filter(i=>i.status==="Paid").length,
      }));
      const filtered=computed(()=>{
        if(active.value==="all") return list.value;
        if(active.value==="Overdue") return list.value.filter(isOverdue);
        return list.value.filter(i=>i.status===active.value);
      });
      async function load(){
        loading.value=true;
        try{ list.value=await apiList("Sales Invoice",{
          fields:["name","customer","customer_name","posting_date","due_date","grand_total","outstanding_amount","status"],
          order:"posting_date desc"
        });}finally{loading.value=false;}
      }
      onMounted(load);
      return {list,loading,active,filters,counts,filtered,fmt,fmtDate,isOverdue,statusBadge,load};
    },
    methods:{
      pillBadge(k){return{Draft:"b-badge-muted",Submitted:"b-badge-amber",Overdue:"b-badge-red",Paid:"b-badge-green"}[k]||"b-badge-muted";},
    },
    template:`
<div class="b-page">
  <div class="b-action-bar">
    <div class="b-filter-row">
      <button v-for="f in filters" :key="f.k" class="b-pill" :class="{active:active===f.k}" @click="active=f.k">
        {{f.lbl}}
        <span v-if="f.k!=='all'" class="b-badge" :class="pillBadge(f.k)" style="margin-left:4px;font-size:10px;padding:1px 5px">{{counts[f.k]}}</span>
      </button>
    </div>
    <div class="b-action-right">
      <button class="b-btn b-btn-ghost" @click="load">↻ Refresh</button>
      <button class="b-btn b-btn-primary" @click="window.location.href='/app/sales-invoice/new-sales-invoice-1'">+ New Invoice</button>
    </div>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Invoice #</th><th>Customer</th><th>Date</th><th>Due</th><th class="ta-r">Amount</th><th class="ta-r">Outstanding</th><th>Status</th></tr></thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n"><td colspan="7" style="padding:12px"><div class="b-shimmer" style="height:13px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="inv in filtered" :key="inv.name" class="clickable" @click="window.location.href='/app/sales-invoice/'+inv.name">
            <td><span class="mono c-accent fw-600">{{inv.name}}</span></td>
            <td><span class="fw-600">{{inv.customer_name||inv.customer}}</span></td>
            <td class="c-muted mono" style="font-size:12px">{{fmtDate(inv.posting_date)}}</td>
            <td class="mono" style="font-size:12px" :class="isOverdue(inv)?'c-red':'c-muted'">{{fmtDate(inv.due_date)}}</td>
            <td class="ta-r mono" style="font-size:12px">{{fmt(inv.grand_total)}}</td>
            <td class="ta-r mono fw-600" style="font-size:12px" :class="inv.outstanding_amount>0?'c-amber':'c-green'">{{fmt(inv.outstanding_amount)}}</td>
            <td><span class="b-badge" :class="statusBadge(inv.status)">{{inv.status}}</span></td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="7" class="b-empty">No invoices found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`
  });

  /* ================================================================
     PAYMENTS
  ================================================================ */
  const Payments = defineComponent({ name:"Payments",
    setup(){
      const list=ref([]),loading=ref(true),active=ref("all");
      const types=[{k:"all",lbl:"All"},{k:"Receive",lbl:"Received"},{k:"Pay",lbl:"Paid Out"}];
      const filtered=computed(()=>active.value==="all"?list.value:list.value.filter(p=>p.payment_type===active.value));
      async function load(){
        loading.value=true;
        try{list.value=await apiList("Payment Entry",{
          fields:["name","party","party_type","paid_amount","payment_type","payment_date","mode_of_payment"],
          order:"payment_date desc"
        });}finally{loading.value=false;}
      }
      onMounted(load);
      return{list,loading,active,types,filtered,fmt,fmtDate};
    },
    template:`
<div class="b-page">
  <div class="b-action-bar">
    <div class="b-filter-row">
      <button v-for="t in types" :key="t.k" class="b-pill" :class="{active:active===t.k}" @click="active=t.k">{{t.lbl}}</button>
    </div>
    <button class="b-btn b-btn-primary" @click="window.location.href='/app/payment-entry/new-payment-entry-1'">+ New Payment</button>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Payment #</th><th>Party</th><th>Mode</th><th>Date</th><th>Type</th><th class="ta-r">Amount</th></tr></thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n"><td colspan="6" style="padding:12px"><div class="b-shimmer" style="height:13px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="p in filtered" :key="p.name" class="clickable" @click="window.location.href='/app/payment-entry/'+p.name">
            <td><span class="mono c-accent fw-600">{{p.name}}</span></td>
            <td class="fw-600">{{p.party}}</td>
            <td class="c-muted">{{p.mode_of_payment||'—'}}</td>
            <td class="c-muted mono" style="font-size:12px">{{fmtDate(p.payment_date)}}</td>
            <td><span class="b-badge" :class="p.payment_type==='Receive'?'b-badge-green':'b-badge-red'">{{p.payment_type}}</span></td>
            <td class="ta-r mono fw-600" :class="p.payment_type==='Receive'?'c-green':'c-red'">{{fmt(p.paid_amount)}}</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="6" class="b-empty">No payments found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`
  });

  /* ================================================================
     BANKING
  ================================================================ */
  const Banking = defineComponent({ name:"Banking",
    setup(){
      const cash=ref(null),cashLoad=ref(true),txns=ref([]),txnLoad=ref(false),selected=ref(null);
      async function loadCash(){cashLoad.value=true;try{cash.value=await api("zoho_books_clone.api.dashboard.get_cash_position");}finally{cashLoad.value=false;}}
      async function selectAcct(a){
        selected.value=a.name; txnLoad.value=true;
        try{txns.value=await apiList("Bank Transaction",{
          fields:["name","date","description","debit","credit","balance","reference_number","status"],
          filters:[["bank_account","=",a.name],["status","=","Unreconciled"]],
          order:"date asc",limit:30
        });}finally{txnLoad.value=false;}
      }
      onMounted(loadCash);
      return{cash,cashLoad,txns,txnLoad,selected,selectAcct,fmt,fmtDate};
    },
    template:`
<div class="b-page" style="display:flex;flex-direction:column;gap:16px">
  <div class="b-card b-cash-strip">
    <div>
      <div class="b-section-label" style="margin-bottom:6px">Total Cash Position</div>
      <div v-if="cashLoad" class="b-shimmer" style="width:140px;height:28px"></div>
      <div v-else class="b-cash-total">{{fmt(cash?.total_cash)}}</div>
    </div>
    <div class="b-badge b-badge-green" style="font-size:12px">Live</div>
  </div>
  <div class="b-bank-grid">
    <template v-if="cashLoad">
      <div v-for="n in 3" :key="n" class="b-bank-card"><div class="b-shimmer" style="height:80px"></div></div>
    </template>
    <template v-else>
      <div v-for="a in (cash?.bank_accounts||[])" :key="a.name" class="b-bank-card" :class="{selected:selected===a.name}" @click="selectAcct(a)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span class="b-badge b-badge-blue">{{a.currency||'INR'}}</span>
          <span class="b-section-label">{{a.bank_name||''}}</span>
        </div>
        <div class="fw-600" style="font-size:14px">{{a.account_name}}</div>
        <div class="b-bank-balance">{{fmt(a.current_balance)}}</div>
      </div>
      <div v-if="!(cash?.bank_accounts?.length)" class="b-bank-card b-empty">No bank accounts</div>
    </template>
  </div>
  <div v-if="selected" class="b-card" style="padding:0;overflow:hidden">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border)">
      <span class="b-section-label">{{selected}} — Transactions</span>
      <span class="b-badge b-badge-amber">{{txns.length}} unreconciled</span>
    </div>
    <table class="b-table">
      <thead><tr><th>Ref #</th><th>Date</th><th>Description</th><th class="ta-r">Debit</th><th class="ta-r">Credit</th><th class="ta-r">Balance</th><th>Status</th></tr></thead>
      <tbody>
        <template v-if="txnLoad">
          <tr v-for="n in 5" :key="n"><td colspan="7" style="padding:12px"><div class="b-shimmer" style="height:12px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="t in txns" :key="t.name">
            <td class="mono c-accent fw-600" style="font-size:12px">{{t.reference_number||t.name}}</td>
            <td class="c-muted mono" style="font-size:12px">{{fmtDate(t.date)}}</td>
            <td class="c-muted" style="font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{t.description||'—'}}</td>
            <td class="ta-r mono c-red" style="font-size:12px">{{t.debit>0?fmt(t.debit):'—'}}</td>
            <td class="ta-r mono c-green" style="font-size:12px">{{t.credit>0?fmt(t.credit):'—'}}</td>
            <td class="ta-r mono" style="font-size:12px">{{fmt(t.balance)}}</td>
            <td><span class="b-badge b-badge-amber">{{t.status}}</span></td>
          </tr>
          <tr v-if="!txns.length"><td colspan="7" style="text-align:center;padding:24px;color:var(--green)">✓ All reconciled</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`
  });

  /* ================================================================
     ACCOUNTS
  ================================================================ */
  const Accounts = defineComponent({ name:"Accounts",
    setup(){
      const list=ref([]),loading=ref(true),active=ref("All");
      const types=computed(()=>["All",...new Set(list.value.map(a=>a.account_type).filter(Boolean))].sort((a,b)=>a==="All"?-1:a.localeCompare(b)));
      const filtered=computed(()=>active.value==="All"?list.value:list.value.filter(a=>a.account_type===active.value));
      const TC={Asset:"b-badge-blue",Liability:"b-badge-red",Equity:"b-badge-amber",Income:"b-badge-green",Expense:"b-badge-red",Bank:"b-badge-blue"};
      async function load(){
        loading.value=true;
        try{list.value=await apiList("Account",{
          fields:["name","account_name","account_type","parent_account","account_currency"],
          limit:100,order:"account_type asc, account_name asc"
        });}finally{loading.value=false;}
      }
      onMounted(load);
      return{list,loading,active,types,filtered,TC};
    },
    template:`
<div class="b-page">
  <div class="b-action-bar">
    <div class="b-filter-row">
      <button v-for="t in types" :key="t" class="b-pill" :class="{active:active===t}" @click="active=t">{{t}}</button>
    </div>
    <button class="b-btn b-btn-primary" @click="window.location.href='/app/account/new-account-1'">+ New Account</button>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Account</th><th>Type</th><th>Parent</th><th>Currency</th></tr></thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n"><td colspan="4" style="padding:12px"><div class="b-shimmer" style="height:12px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="a in filtered" :key="a.name" class="clickable" @click="window.location.href='/app/account/'+a.name">
            <td>
              <div class="fw-600">{{a.account_name}}</div>
              <div class="mono c-muted" style="font-size:11px">{{a.name}}</div>
            </td>
            <td><span class="b-badge" :class="TC[a.account_type]||'b-badge-muted'">{{a.account_type}}</span></td>
            <td class="c-muted" style="font-size:12.5px">{{a.parent_account||'—'}}</td>
            <td class="c-muted" style="font-size:12.5px">{{a.account_currency||'INR'}}</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="4" class="b-empty">No accounts found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`
  });

  /* ================================================================
     REPORTS
  ================================================================ */
  const Reports = defineComponent({ name:"Reports",
    setup(){
      const today=new Date();
      const from=ref(new Date(today.getFullYear(),today.getMonth(),1).toISOString().slice(0,10));
      const to=ref(today.toISOString().slice(0,10));
      const tab=ref("pl");
      const pl=ref(null),plL=ref(false),bs=ref(null),bsL=ref(false),cf=ref(null),cfL=ref(false),gst=ref(null),gstL=ref(false);
      const tabs=[{k:"pl",lbl:"Profit & Loss"},{k:"bs",lbl:"Balance Sheet"},{k:"cf",lbl:"Cash Flow"},{k:"gst",lbl:"GST Summary"}];
      async function run(){
        const co=company(), args={company:co,from_date:from.value,to_date:to.value};
        if(tab.value==="pl"){plL.value=true;pl.value=await api("zoho_books_clone.db.queries.get_profit_and_loss",args).finally(()=>plL.value=false);}
        else if(tab.value==="bs"){bsL.value=true;bs.value=await api("zoho_books_clone.db.queries.get_balance_sheet_totals",{company:co,as_of_date:to.value}).finally(()=>bsL.value=false);}
        else if(tab.value==="cf"){cfL.value=true;cf.value=await api("zoho_books_clone.db.queries.get_cash_flow",args).finally(()=>cfL.value=false);}
        else if(tab.value==="gst"){gstL.value=true;gst.value=await api("zoho_books_clone.db.queries.get_gst_summary",args).finally(()=>gstL.value=false);}
      }
      return{from,to,tab,tabs,pl,plL,bs,bsL,cf,cfL,gst,gstL,run,fmt};
    },
    template:`
<div class="b-page" style="display:flex;flex-direction:column;gap:16px">
  <div class="b-report-tabs">
    <button v-for="t in tabs" :key="t.k" class="b-rtab" :class="{active:tab===t.k}" @click="tab=t.k">{{t.lbl}}</button>
  </div>
  <div class="b-card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 20px">
    <label class="b-section-label">From</label>
    <input type="date" v-model="from" class="b-input"/>
    <label class="b-section-label">To</label>
    <input type="date" v-model="to" class="b-input"/>
    <button class="b-btn b-btn-primary" @click="run">▶ Run</button>
  </div>

  <div v-if="tab==='pl'" class="b-card">
    <div class="b-section-label" style="margin-bottom:16px">Profit & Loss</div>
    <div v-if="plL" class="b-shimmer" style="height:100px"></div>
    <template v-else-if="pl">
      <div class="b-pl-row"><span>Total Income</span><span class="mono c-green">{{fmt(pl.total_income)}}</span></div>
      <div class="b-pl-row"><span>Total Expense</span><span class="mono c-red">{{fmt(pl.total_expense)}}</span></div>
      <div class="b-pl-divider"></div>
      <div class="b-pl-row" style="font-size:16px;font-weight:700">
        <span>Net Profit</span>
        <span class="mono" :class="pl.net_profit>=0?'c-green':'c-red'">{{fmt(pl.net_profit)}}</span>
      </div>
    </template>
    <div v-else class="b-empty">Select a date range and click Run.</div>
  </div>

  <div v-if="tab==='bs'" class="b-card">
    <div class="b-section-label" style="margin-bottom:16px">Balance Sheet</div>
    <div v-if="bsL" class="b-shimmer" style="height:80px"></div>
    <div v-else-if="bs" class="b-bs-grid">
      <div class="b-bs-block"><div class="b-section-label">Assets</div><div class="b-bs-amount c-accent">{{fmt(bs.total_assets)}}</div></div>
      <div class="b-bs-block"><div class="b-section-label">Liabilities</div><div class="b-bs-amount c-red">{{fmt(bs.total_liabilities)}}</div></div>
      <div class="b-bs-block"><div class="b-section-label">Equity</div><div class="b-bs-amount c-amber">{{fmt(bs.total_equity)}}</div></div>
    </div>
    <div v-else class="b-empty">Select a date range and click Run.</div>
  </div>

  <div v-if="tab==='cf'" class="b-card">
    <div class="b-section-label" style="margin-bottom:16px">Cash Flow</div>
    <div v-if="cfL" class="b-shimmer" style="height:80px"></div>
    <template v-else-if="cf">
      <div class="b-pl-row"><span>Operating</span><span class="mono" :class="cf.operating>=0?'c-green':'c-red'">{{fmt(cf.operating)}}</span></div>
      <div class="b-pl-row"><span>Investing</span><span class="mono" :class="cf.investing>=0?'c-green':'c-red'">{{fmt(cf.investing)}}</span></div>
      <div class="b-pl-row"><span>Financing</span><span class="mono" :class="cf.financing>=0?'c-green':'c-red'">{{fmt(cf.financing)}}</span></div>
      <div class="b-pl-divider"></div>
      <div class="b-pl-row" style="font-size:16px;font-weight:700"><span>Net Change</span><span class="mono" :class="cf.net_change>=0?'c-green':'c-red'">{{fmt(cf.net_change)}}</span></div>
    </template>
    <div v-else class="b-empty">Select a date range and click Run.</div>
  </div>

  <div v-if="tab==='gst'" class="b-card" style="padding:0;overflow:hidden">
    <div style="padding:16px 20px;border-bottom:1px solid var(--border)"><span class="b-section-label">GST Summary</span></div>
    <div v-if="gstL" style="padding:16px"><div class="b-shimmer" style="height:80px"></div></div>
    <table v-else-if="gst?.length" class="b-table">
      <thead><tr><th>Tax Type</th><th class="ta-r">Invoices</th><th class="ta-r">Total Tax</th></tr></thead>
      <tbody>
        <tr v-for="g in gst" :key="g.tax_type">
          <td><span class="b-badge b-badge-blue">{{g.tax_type}}</span></td>
          <td class="ta-r mono">{{g.invoice_count}}</td>
          <td class="ta-r mono c-green">{{fmt(g.total_tax)}}</td>
        </tr>
      </tbody>
    </table>
    <div v-else class="b-empty">Select a date range and click Run.</div>
  </div>
</div>`
  });

  /* ================================================================
     APP SHELL
  ================================================================ */
  const NAV = [
    {to:"/",      lbl:"Dashboard", icon:"grid"},
    {to:"/invoices",lbl:"Invoices", icon:"doc"},
    {to:"/payments",lbl:"Payments", icon:"pay"},
    {to:"/banking", lbl:"Banking",  icon:"bank"},
    {to:"/accounts",lbl:"Accounts", icon:"accts"},
    {to:"/reports", lbl:"Reports",  icon:"reports"},
  ];
  const TITLES = {dashboard:"Dashboard",invoices:"Invoices",payments:"Payments",banking:"Banking",accounts:"Chart of Accounts",reports:"Reports"};

  const App = defineComponent({ name:"BooksApp",
    setup(){
      const route=useRoute();
      const collapsed=ref(false);
      const co=computed(()=>window.__booksCompany||window.frappe?.boot?.sysdefaults?.company||"My Company");
      const initials=computed(()=>{const n=window.frappe?.session?.user_fullname||"U";return n.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();});
      const title=computed(()=>TITLES[route.name]||"Books");
      return{collapsed,co,initials,title,NAV,icon};
    },
    template:`
<div id="books-root" :class="{collapsed}">
  <!-- Sidebar -->
  <aside class="b-sidebar">
    <div class="b-brand">
      <div class="b-brand-icon">📒</div>
      <span class="b-brand-text">Books</span>
    </div>
    <nav class="b-nav">
      <router-link v-for="n in NAV" :key="n.to" :to="n.to" custom v-slot="{navigate,isActive}">
        <div class="b-nav-item" :class="{active:isActive}" @click="navigate">
          <span class="b-nav-icon" v-html="icon(n.icon,16)"></span>
          <span class="b-nav-label">{{n.lbl}}</span>
        </div>
      </router-link>
    </nav>
    <div class="b-sidebar-footer">
      <button class="b-collapse-btn" @click="collapsed=!collapsed">
        <span v-html="icon(collapsed?'chevR':'chevL',14)"></span>
        <span>Collapse</span>
      </button>
    </div>
  </aside>

  <!-- Topbar -->
  <header class="b-topbar">
    <span class="b-page-title">{{title}}</span>
    <div class="b-topbar-right">
      <div class="b-company"><span class="b-company-dot"></span><span>{{co}}</span></div>
      <div class="b-avatar" :title="'Logged in as '+co">{{initials}}</div>
    </div>
  </header>

  <!-- Content -->
  <main class="b-main">
    <router-view></router-view>
  </main>
</div>`
  });

  /* ── Boot ── */
  function waitReady(cb,n){
    n=n||0;
    if(window.frappe?.csrf_token||n>40){cb();return;}
    setTimeout(()=>waitReady(cb,n+1),100);
  }

  const router=createRouter({
    history:createWebHashHistory(),
    routes:[
      {path:"/",        component:Dashboard, name:"dashboard"},
      {path:"/invoices",component:Invoices,  name:"invoices"},
      {path:"/payments",component:Payments,  name:"payments"},
      {path:"/banking", component:Banking,   name:"banking"},
      {path:"/accounts",component:Accounts,  name:"accounts"},
      {path:"/reports", component:Reports,   name:"reports"},
    ]
  });

  waitReady(()=>{
    createApp(App).use(router).mount("#books-app");
  });

})();
