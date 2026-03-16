(function(){
"use strict";
if(!document.getElementById("books-app"))return;
if(typeof Vue==="undefined"||typeof VueRouter==="undefined"){console.error("[Books] Vue/Router not loaded");return;}

const{createApp,ref,computed,onMounted,defineComponent}=Vue;
const{createRouter,createWebHashHistory,useRoute}=VueRouter;

/* ── Helpers ── */
function fmt(v,c){
  if(v==null||v==="")return"—";
  return new Intl.NumberFormat("en-IN",{style:"currency",currency:c||"INR",maximumFractionDigits:0}).format(v);
}
function fmtDate(v){
  if(!v)return"—";
  return new Date(v).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});
}
function fmtShort(v){
  if(!v)return"—";
  return new Date(v).toLocaleDateString("en-IN",{day:"2-digit",month:"short"});
}
function isOverdue(inv){return inv.outstanding_amount>0&&inv.due_date&&new Date(inv.due_date)<new Date();}
function csrf(){return window.frappe?.csrf_token||"";}
function co(){return window.__booksCompany||window.frappe?.boot?.sysdefaults?.company||"";}

async function api(method,args){
  const r=await fetch("/api/method/"+method,{
    method:"POST",credentials:"same-origin",
    headers:{"Content-Type":"application/json","X-Frappe-CSRF-Token":csrf(),"Accept":"application/json"},
    body:JSON.stringify(args||{})
  });
  if(!r.ok)throw new Error(r.status+" "+method);
  return(await r.json()).message;
}
async function apiList(dt,opts){
  return await api("frappe.client.get_list",{
    doctype:dt,fields:opts.fields||["name"],
    filters:opts.filters||[],
    order_by:opts.order||"modified desc",
    limit_page_length:opts.limit||50
  })||[];
}
async function resolveCompany(){
  if(window.__booksCompany)return window.__booksCompany;
  try{
    const rows=await apiList("Company",{fields:["name"],limit:1,order:"creation asc"});
    const c=rows?.[0]?.name||"";
    window.__booksCompany=c;
    if(window.frappe?.boot?.sysdefaults)window.frappe.boot.sysdefaults.company=c;
    return c;
  }catch{return"";}
}

/* ── SVG icon helper ── */
const IC={
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  pay:'<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
  bank:'<path d="M3 22h18M6 18v-7m4 7v-7m4 7v-7m4 7v-7M3 7l9-5 9 5H3z"/>',
  accts:'<path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM12 14v-4M8 14v-2M16 14v-3"/>',
  chart:'<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  trend:'<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  purchase:'<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  chevL:'<polyline points="15 18 9 12 15 6"/>',
  chevR:'<polyline points="9 18 15 12 9 6"/>',
  plus:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  refresh:'<polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/><polyline points="1 20 1 14 7 14"/>',
  user:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
};
function icon(k,s){s=s||16;return`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[k]||""}</svg>`;}

function statusBadge(s){
  return{Paid:"b-badge-green",Unpaid:"b-badge-amber",Submitted:"b-badge-amber",
    Draft:"b-badge-muted","Partly Paid":"b-badge-amber",Cancelled:"b-badge-red",Overdue:"b-badge-red"}[s]||"b-badge-muted";
}

/* ================================================================
   DASHBOARD
================================================================ */
const Dashboard=defineComponent({name:"Dashboard",
  setup(){
    const kpis=ref(null),dash=ref(null),aging=ref({});
    const loading=ref(true);

    const agingRows=[
      {k:"current",lbl:"Current"},
      {k:"1_30",   lbl:"1–30 days"},
      {k:"31_60",  lbl:"31–60 days"},
      {k:"61_90",  lbl:"61–90 days"},
      {k:"over_90",lbl:"90+ days"},
    ];

    const kpiDefs=computed(()=>[
      {
        lbl:"Monthly Revenue",
        val:fmt(kpis.value?.month_revenue),
        trend:"+12.4% vs last month",up:true,
        icon:"trend",bg:"#eff6ff",ic:"#2563eb",
        note:"vs last month"
      },{
        lbl:"Collected",
        val:fmt(kpis.value?.month_collected),
        trend:"8.1% collected rate",up:true,
        icon:"pay",bg:"#f0fdf4",ic:"#16a34a",
        note:"collected rate"
      },{
        lbl:"Outstanding",
        val:fmt(kpis.value?.month_outstanding),
        trend:`${kpis.value?.overdue_count||0} overdue invoices`,up:false,
        icon:"accts",bg:"#fef2f2",ic:"#dc2626",
        note:"overdue invoices"
      },{
        lbl:"Net Profit (MTD)",
        val:fmt(kpis.value?.net_profit_mtd),
        trend:"45.1% margin",up:true,
        icon:"chart",bg:"#f5f3ff",ic:"#7c3aed",
        note:"margin"
      },
    ]);

    onMounted(async()=>{
      loading.value=true;
      const company=await resolveCompany();
      try{
        const[d,k,a]=await Promise.all([
          api("zoho_books_clone.api.dashboard.get_home_dashboard",{company}),
          api("zoho_books_clone.db.aggregates.get_dashboard_kpis",{company}),
          api("zoho_books_clone.db.aggregates.get_aging_buckets",{company}),
        ]);
        dash.value=d||{};kpis.value=k||{};aging.value=a||{};
      }catch(e){console.error("[Dashboard]",e);}
      finally{loading.value=false;}
    });

    return{kpis,dash,aging,loading,kpiDefs,agingRows,fmt,fmtDate,fmtShort,isOverdue,statusBadge,icon};
  },
  template:`
<div class="b-page">
  <!-- KPIs -->
  <div class="b-kpi-grid">
    <div v-for="k in kpiDefs" :key="k.lbl" class="b-kpi">
      <div class="b-kpi-top">
        <div class="b-kpi-icon-wrap" :style="{background:k.bg}">
          <span :style="{color:k.ic}" v-html="icon(k.icon,20)"></span>
        </div>
      </div>
      <div class="b-kpi-label">{{k.lbl}}</div>
      <div class="b-kpi-value">
        <div v-if="loading" class="b-shimmer" style="height:26px;width:110px"></div>
        <template v-else>{{k.val}}</template>
      </div>
      <div class="b-kpi-trend" :class="k.up?'b-kpi-trend-up':'b-kpi-trend-down'">
        <span>{{k.up?'▲':'▼'}}</span>
        <span>{{k.trend}}</span>
      </div>
    </div>
  </div>

  <!-- Mid row -->
  <div class="b-mid-grid">
    <!-- Recent invoices -->
    <div class="b-card">
      <div class="b-card-head">
        <span class="b-card-title">Recent Invoices</span>
        <button class="b-btn b-btn-link" @click="window.location.href='#/invoices'">View all</button>
      </div>
      <div v-if="loading" style="padding:20px">
        <div v-for="n in 5" :key="n" class="b-shimmer" style="height:14px;margin-bottom:16px"></div>
      </div>
      <table v-else class="b-table">
        <thead><tr><th>Customer</th><th>Invoice</th><th>Date</th><th>Status</th></tr></thead>
        <tbody>
          <tr v-for="inv in (dash?.overdue_invoices?.slice(0,6)||[])" :key="inv.name"
              class="clickable" @click="window.location.href='/app/sales-invoice/'+inv.name">
            <td class="fw-600">{{inv.customer_name||inv.customer}}</td>
            <td class="mono c-accent" style="font-size:12px">{{inv.name}}</td>
            <td class="c-muted" style="font-size:12px">{{fmtShort(inv.due_date)}}</td>
            <td><span class="b-badge b-badge-red">Overdue</span></td>
          </tr>
          <tr v-if="!(dash?.overdue_invoices?.length)">
            <td colspan="4" style="text-align:center;padding:32px;color:var(--green-text);font-weight:600">✓ All caught up!</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- AR Aging -->
    <div class="b-card">
      <div class="b-card-head"><span class="b-card-title">AR Aging</span></div>
      <div class="b-card-body">
        <div v-if="loading">
          <div v-for="n in 5" :key="n" class="b-shimmer" style="height:14px;margin-bottom:16px"></div>
        </div>
        <div v-else class="b-aging-rows">
          <div v-for="r in agingRows" :key="r.k" class="b-aging-row">
            <span class="b-aging-lbl">{{r.lbl}}</span>
            <span class="b-aging-amt">{{fmt(aging[r.k])}}</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Top customers -->
  <div class="b-card">
    <div class="b-card-head">
      <span class="b-card-title">Top Customers</span>
      <span class="b-badge b-badge-blue">This month</span>
    </div>
    <div v-if="loading" style="padding:20px"><div class="b-shimmer" style="height:80px"></div></div>
    <table v-else class="b-table">
      <thead><tr><th>Customer</th><th class="ta-r">Invoices</th><th class="ta-r">Revenue</th></tr></thead>
      <tbody>
        <tr v-for="c in (dash?.top_customers||[])" :key="c.customer">
          <td class="fw-600">{{c.customer_name||c.customer}}</td>
          <td class="ta-r mono">{{c.invoice_count}}</td>
          <td class="ta-r mono fw-700 c-green">{{fmt(c.total_revenue)}}</td>
        </tr>
        <tr v-if="!(dash?.top_customers?.length)"><td colspan="3" class="b-empty">No data this period</td></tr>
      </tbody>
    </table>
  </div>
</div>`
});

/* ================================================================
   INVOICES
================================================================ */
const Invoices=defineComponent({name:"Invoices",
  setup(){
    const list=ref([]),loading=ref(true),active=ref("all");
    const filters=[
      {k:"all",lbl:"All"},{k:"Draft",lbl:"Draft"},{k:"Submitted",lbl:"Unpaid"},
      {k:"Overdue",lbl:"Overdue"},{k:"Paid",lbl:"Paid"}
    ];
    const counts=computed(()=>({
      Draft:list.value.filter(i=>i.status==="Draft").length,
      Submitted:list.value.filter(i=>["Unpaid","Submitted"].includes(i.status)).length,
      Overdue:list.value.filter(isOverdue).length,
      Paid:list.value.filter(i=>i.status==="Paid").length,
    }));
    const filtered=computed(()=>{
      if(active.value==="all")return list.value;
      if(active.value==="Overdue")return list.value.filter(isOverdue);
      return list.value.filter(i=>i.status===active.value);
    });
    async function load(){
      loading.value=true;
      try{list.value=await apiList("Sales Invoice",{
        fields:["name","customer","customer_name","posting_date","due_date","grand_total","outstanding_amount","status"],
        order:"posting_date desc"
      });}finally{loading.value=false;}
    }
    onMounted(load);
    return{list,loading,active,filters,counts,filtered,fmt,fmtDate,isOverdue,statusBadge,load,icon};
  },
  methods:{
    pillBadge(k){return{Draft:"b-badge-muted",Submitted:"b-badge-amber",Overdue:"b-badge-red",Paid:"b-badge-green"}[k]||"b-badge-muted";}
  },
  template:`
<div class="b-page">
  <div class="b-action-bar">
    <div class="b-filter-row">
      <button v-for="f in filters" :key="f.k" class="b-pill" :class="{active:active===f.k}" @click="active=f.k">
        {{f.lbl}}
        <span v-if="f.k!=='all'" class="b-badge" :class="pillBadge(f.k)" style="margin-left:4px;font-size:10px;padding:1px 5px;vertical-align:middle">{{counts[f.k]}}</span>
      </button>
    </div>
    <div style="display:flex;gap:8px">
      <button class="b-btn b-btn-ghost" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="b-btn b-btn-primary" @click="window.location.href='/app/sales-invoice/new-sales-invoice-1'"><span v-html="icon('plus',13)"></span> New Invoice</button>
    </div>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Invoice #</th><th>Customer</th><th>Date</th><th>Due Date</th><th class="ta-r">Amount</th><th class="ta-r">Outstanding</th><th>Status</th></tr></thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n"><td colspan="7" style="padding:14px"><div class="b-shimmer" style="height:13px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="inv in filtered" :key="inv.name" class="clickable" @click="window.location.href='/app/sales-invoice/'+inv.name">
            <td><span class="mono c-accent fw-700" style="font-size:12px">{{inv.name}}</span></td>
            <td class="fw-600">{{inv.customer_name||inv.customer}}</td>
            <td class="c-muted" style="font-size:12.5px">{{fmtDate(inv.posting_date)}}</td>
            <td style="font-size:12.5px" :class="isOverdue(inv)?'c-red fw-600':'c-muted'">{{fmtDate(inv.due_date)}}</td>
            <td class="ta-r mono fw-600" style="font-size:13px">{{fmt(inv.grand_total)}}</td>
            <td class="ta-r mono fw-600" style="font-size:13px" :class="inv.outstanding_amount>0?'c-amber':'c-green'">{{fmt(inv.outstanding_amount)}}</td>
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
const Payments=defineComponent({name:"Payments",
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
    return{list,loading,active,types,filtered,fmt,fmtDate,icon};
  },
  template:`
<div class="b-page">
  <div class="b-action-bar">
    <div class="b-filter-row">
      <button v-for="t in types" :key="t.k" class="b-pill" :class="{active:active===t.k}" @click="active=t.k">{{t.lbl}}</button>
    </div>
    <button class="b-btn b-btn-primary" @click="window.location.href='/app/payment-entry/new-payment-entry-1'"><span v-html="icon('plus',13)"></span> New Payment</button>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Payment #</th><th>Party</th><th>Mode</th><th>Date</th><th>Type</th><th class="ta-r">Amount</th></tr></thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n"><td colspan="6" style="padding:14px"><div class="b-shimmer" style="height:13px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="p in filtered" :key="p.name" class="clickable" @click="window.location.href='/app/payment-entry/'+p.name">
            <td><span class="mono c-accent fw-700" style="font-size:12px">{{p.name}}</span></td>
            <td class="fw-600">{{p.party}}</td>
            <td class="c-muted">{{p.mode_of_payment||'—'}}</td>
            <td class="c-muted" style="font-size:12.5px">{{fmtDate(p.payment_date)}}</td>
            <td><span class="b-badge" :class="p.payment_type==='Receive'?'b-badge-green':'b-badge-red'">{{p.payment_type}}</span></td>
            <td class="ta-r mono fw-700" :class="p.payment_type==='Receive'?'c-green':'c-red'">{{fmt(p.paid_amount)}}</td>
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
const Banking=defineComponent({name:"Banking",
  setup(){
    const cash=ref(null),cashLoad=ref(true),txns=ref([]),txnLoad=ref(false),sel=ref(null);
    async function loadCash(){cashLoad.value=true;try{cash.value=await api("zoho_books_clone.api.dashboard.get_cash_position");}finally{cashLoad.value=false;}}
    async function pickAcct(a){
      sel.value=a.name;txnLoad.value=true;
      try{txns.value=await apiList("Bank Transaction",{
        fields:["name","date","description","debit","credit","balance","reference_number","status"],
        filters:[["bank_account","=",a.name],["status","=","Unreconciled"]],
        order:"date asc",limit:30
      });}finally{txnLoad.value=false;}
    }
    onMounted(loadCash);
    return{cash,cashLoad,txns,txnLoad,sel,pickAcct,fmt,fmtDate};
  },
  template:`
<div class="b-page">
  <div class="b-card" style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px">
    <div>
      <div style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:4px">Total Cash Position</div>
      <div v-if="cashLoad" class="b-shimmer" style="width:140px;height:28px"></div>
      <div v-else style="font-family:var(--mono);font-size:26px;font-weight:700;color:var(--green-text)">{{fmt(cash?.total_cash)}}</div>
    </div>
    <span class="b-badge b-badge-green">Live</span>
  </div>
  <div class="b-bank-grid">
    <template v-if="cashLoad">
      <div v-for="n in 3" :key="n" class="b-bank-card"><div class="b-shimmer" style="height:80px"></div></div>
    </template>
    <template v-else>
      <div v-for="a in (cash?.bank_accounts||[])" :key="a.name" class="b-bank-card" :class="{selected:sel===a.name}" @click="pickAcct(a)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="b-badge b-badge-blue" style="font-size:11px">{{a.currency||'INR'}}</span>
        </div>
        <div class="b-bank-name">{{a.account_name}}</div>
        <div class="b-bank-sub">{{a.bank_name||'Bank Account'}}</div>
        <div class="b-bank-balance">{{fmt(a.current_balance)}}</div>
      </div>
      <div v-if="!(cash?.bank_accounts?.length)" class="b-bank-card b-empty">No bank accounts configured</div>
    </template>
  </div>
  <div v-if="sel" class="b-card" style="padding:0;overflow:hidden">
    <div class="b-card-head">
      <span class="b-card-title">Transactions — {{sel}}</span>
      <span class="b-badge b-badge-amber">{{txns.length}} unreconciled</span>
    </div>
    <table class="b-table">
      <thead><tr><th>Ref #</th><th>Date</th><th>Description</th><th class="ta-r">Debit</th><th class="ta-r">Credit</th><th class="ta-r">Balance</th></tr></thead>
      <tbody>
        <template v-if="txnLoad">
          <tr v-for="n in 5" :key="n"><td colspan="6" style="padding:14px"><div class="b-shimmer" style="height:12px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="t in txns" :key="t.name">
            <td class="mono c-accent fw-600" style="font-size:12px">{{t.reference_number||t.name}}</td>
            <td class="c-muted" style="font-size:12.5px">{{fmtDate(t.date)}}</td>
            <td class="c-muted" style="font-size:12.5px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{t.description||'—'}}</td>
            <td class="ta-r mono c-red fw-600" style="font-size:12.5px">{{t.debit>0?fmt(t.debit):'—'}}</td>
            <td class="ta-r mono c-green fw-600" style="font-size:12.5px">{{t.credit>0?fmt(t.credit):'—'}}</td>
            <td class="ta-r mono fw-600" style="font-size:12.5px">{{fmt(t.balance)}}</td>
          </tr>
          <tr v-if="!txns.length"><td colspan="6" style="text-align:center;padding:28px;color:var(--green-text);font-weight:600">✓ All reconciled</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`
});

/* ================================================================
   ACCOUNTS
================================================================ */
const Accounts=defineComponent({name:"Accounts",
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
    return{list,loading,active,types,filtered,TC,icon};
  },
  template:`
<div class="b-page">
  <div class="b-action-bar">
    <div class="b-filter-row">
      <button v-for="t in types" :key="t" class="b-pill" :class="{active:active===t}" @click="active=t">{{t}}</button>
    </div>
    <button class="b-btn b-btn-primary" @click="window.location.href='/app/account/new-account-1'"><span v-html="icon('plus',13)"></span> New Account</button>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Account Name</th><th>Type</th><th>Parent</th><th>Currency</th></tr></thead>
      <tbody>
        <template v-if="loading">
          <tr v-for="n in 8" :key="n"><td colspan="4" style="padding:14px"><div class="b-shimmer" style="height:12px"></div></td></tr>
        </template>
        <template v-else>
          <tr v-for="a in filtered" :key="a.name" class="clickable" @click="window.location.href='/app/account/'+a.name">
            <td>
              <div class="fw-700">{{a.account_name}}</div>
              <div class="mono c-muted" style="font-size:11.5px">{{a.name}}</div>
            </td>
            <td><span class="b-badge" :class="TC[a.account_type]||'b-badge-muted'">{{a.account_type}}</span></td>
            <td class="c-muted" style="font-size:13px">{{a.parent_account||'—'}}</td>
            <td class="c-muted" style="font-size:13px">{{a.account_currency||'INR'}}</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="4" class="b-empty">No accounts found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`
});

/* ================================================================
   REPORTS (P&L + Balance Sheet)
================================================================ */
const Reports=defineComponent({name:"Reports",
  setup(){
    const today=new Date();
    const from=ref(new Date(today.getFullYear(),today.getMonth(),1).toISOString().slice(0,10));
    const to=ref(today.toISOString().slice(0,10));
    const tab=ref("pl");
    const pl=ref(null),plL=ref(false),bs=ref(null),bsL=ref(false),cf=ref(null),cfL=ref(false),gst=ref(null),gstL=ref(false);
    const tabs=[{k:"pl",lbl:"P & L"},{k:"bs",lbl:"Balance Sheet"},{k:"cf",lbl:"Cash Flow"},{k:"gst",lbl:"GST"}];
    async function run(){
      const c=co(),args={company:c,from_date:from.value,to_date:to.value};
      if(tab.value==="pl"){plL.value=true;pl.value=await api("zoho_books_clone.db.queries.get_profit_and_loss",args).finally(()=>plL.value=false);}
      else if(tab.value==="bs"){bsL.value=true;bs.value=await api("zoho_books_clone.db.queries.get_balance_sheet_totals",{company:c,as_of_date:to.value}).finally(()=>bsL.value=false);}
      else if(tab.value==="cf"){cfL.value=true;cf.value=await api("zoho_books_clone.db.queries.get_cash_flow",args).finally(()=>cfL.value=false);}
      else{gstL.value=true;gst.value=await api("zoho_books_clone.db.queries.get_gst_summary",args).finally(()=>gstL.value=false);}
    }
    return{from,to,tab,tabs,pl,plL,bs,bsL,cf,cfL,gst,gstL,run,fmt};
  },
  template:`
<div class="b-page">
  <div class="b-report-tabs">
    <button v-for="t in tabs" :key="t.k" class="b-rtab" :class="{active:tab===t.k}" @click="tab=t.k">{{t.lbl}}</button>
  </div>
  <div class="b-card" style="display:flex;align-items:center;gap:12px;padding:14px 20px;flex-wrap:wrap">
    <label style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3)">From</label>
    <input type="date" v-model="from" class="b-input"/>
    <label style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3)">To</label>
    <input type="date" v-model="to" class="b-input"/>
    <button class="b-btn b-btn-primary" @click="run">▶ Run Report</button>
  </div>
  <div v-if="tab==='pl'" class="b-card b-card-body">
    <div style="font-size:16px;font-weight:700;margin-bottom:16px">Profit & Loss</div>
    <div v-if="plL" class="b-shimmer" style="height:80px"></div>
    <template v-else-if="pl">
      <div class="b-pl-row"><span>Total Income</span><span class="mono fw-700 c-green">{{fmt(pl.total_income)}}</span></div>
      <div class="b-pl-row"><span>Total Expense</span><span class="mono fw-700 c-red">{{fmt(pl.total_expense)}}</span></div>
      <div class="b-pl-row b-pl-net"><span>Net Profit</span><span class="mono fw-700" :class="pl.net_profit>=0?'c-green':'c-red'">{{fmt(pl.net_profit)}}</span></div>
    </template>
    <div v-else class="b-empty">Select a period and click Run Report.</div>
  </div>
  <div v-if="tab==='bs'" class="b-card b-card-body">
    <div style="font-size:16px;font-weight:700;margin-bottom:16px">Balance Sheet</div>
    <div v-if="bsL" class="b-shimmer" style="height:80px"></div>
    <div v-else-if="bs" class="b-bs-grid">
      <div class="b-bs-block"><div class="b-bs-lbl">Assets</div><div class="b-bs-amt c-accent">{{fmt(bs.total_assets)}}</div></div>
      <div class="b-bs-block"><div class="b-bs-lbl">Liabilities</div><div class="b-bs-amt c-red">{{fmt(bs.total_liabilities)}}</div></div>
      <div class="b-bs-block"><div class="b-bs-lbl">Equity</div><div class="b-bs-amt c-amber">{{fmt(bs.total_equity)}}</div></div>
    </div>
    <div v-else class="b-empty">Select a period and click Run Report.</div>
  </div>
  <div v-if="tab==='cf'" class="b-card b-card-body">
    <div style="font-size:16px;font-weight:700;margin-bottom:16px">Cash Flow</div>
    <div v-if="cfL" class="b-shimmer" style="height:80px"></div>
    <template v-else-if="cf">
      <div class="b-pl-row"><span>Operating</span><span class="mono fw-700" :class="cf.operating>=0?'c-green':'c-red'">{{fmt(cf.operating)}}</span></div>
      <div class="b-pl-row"><span>Investing</span><span class="mono fw-700" :class="cf.investing>=0?'c-green':'c-red'">{{fmt(cf.investing)}}</span></div>
      <div class="b-pl-row"><span>Financing</span><span class="mono fw-700" :class="cf.financing>=0?'c-green':'c-red'">{{fmt(cf.financing)}}</span></div>
      <div class="b-pl-row b-pl-net"><span>Net Change</span><span class="mono fw-700" :class="cf.net_change>=0?'c-green':'c-red'">{{fmt(cf.net_change)}}</span></div>
    </template>
    <div v-else class="b-empty">Select a period and click Run Report.</div>
  </div>
  <div v-if="tab==='gst'" class="b-card" style="padding:0;overflow:hidden">
    <div class="b-card-head"><span class="b-card-title">GST Summary</span></div>
    <div v-if="gstL" style="padding:20px"><div class="b-shimmer" style="height:60px"></div></div>
    <table v-else-if="gst?.length" class="b-table">
      <thead><tr><th>Tax Type</th><th class="ta-r">Invoice Count</th><th class="ta-r">Total Tax</th></tr></thead>
      <tbody>
        <tr v-for="g in gst" :key="g.tax_type">
          <td><span class="b-badge b-badge-blue">{{g.tax_type}}</span></td>
          <td class="ta-r mono fw-600">{{g.invoice_count}}</td>
          <td class="ta-r mono fw-700 c-green">{{fmt(g.total_tax)}}</td>
        </tr>
      </tbody>
    </table>
    <div v-else class="b-empty">Select a period and click Run Report.</div>
  </div>
</div>`
});

/* ================================================================
   APP SHELL
================================================================ */
const NAV=[
  {section:"MAIN",items:[
    {to:"/",      lbl:"Dashboard",    icon:"grid"},
  ]},
  {section:"INVOICING",items:[
    {to:"/invoices",lbl:"Sales Invoices",icon:"file",badge:"overdue"},
    {to:"/purchases",lbl:"Purchase Bills",icon:"purchase"},
    {to:"/payments", lbl:"Payments",     icon:"pay"},
  ]},
  {section:"REPORTS",items:[
    {to:"/reports",  lbl:"P & L",        icon:"trend"},
    {to:"/accounts", lbl:"Balance Sheet",icon:"chart"},
  ]},
  {section:"",items:[
    {to:"/banking",  lbl:"Banking",      icon:"bank"},
  ]},
];

const TITLES={dashboard:"Dashboard",invoices:"Sales Invoices",payments:"Payments",banking:"Banking",accounts:"Chart of Accounts",reports:"Reports",purchases:"Purchase Bills"};

const App=defineComponent({name:"BooksApp",
  setup(){
    const route=useRoute();
    const collapsed=ref(false);
    const cname=computed(()=>window.__booksCompany||window.frappe?.boot?.sysdefaults?.company||"My Company");
    const initials=computed(()=>{const n=window.frappe?.session?.user_fullname||"Admin";return n.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();});
    const fullname=computed(()=>window.frappe?.session?.user_fullname||"Administrator");
    const title=computed(()=>TITLES[route.name]||"Books");
    return{collapsed,cname,initials,fullname,title,NAV,icon};
  },
  template:`
<div id="books-root" :class="{collapsed}">
  <!-- Sidebar -->
  <aside class="b-sidebar">
    <div class="b-brand">
      <div class="b-brand-icon">B</div>
      <div class="b-brand-info">
        <div class="b-brand-name">Books</div>
        <div class="b-brand-sub">Accounting</div>
      </div>
    </div>

    <nav class="b-nav">
      <template v-for="group in NAV" :key="group.section">
        <div v-if="group.section" class="b-nav-section">{{group.section}}</div>
        <router-link v-for="n in group.items" :key="n.to" :to="n.to" custom v-slot="{navigate,isActive}">
          <div class="b-nav-item" :class="{active:isActive}" @click="navigate">
            <span class="b-nav-icon" v-html="icon(n.icon,16)"></span>
            <span class="b-nav-label">{{n.lbl}}</span>
          </div>
        </router-link>
      </template>
    </nav>

    <div class="b-sidebar-footer">
      <div class="b-user-row">
        <div class="b-user-avatar">{{initials}}</div>
        <div class="b-user-info">
          <div class="b-user-name">{{fullname}}</div>
          <div class="b-user-role">Books Admin</div>
        </div>
      </div>
    </div>
  </aside>

  <!-- Right panel -->
  <div class="b-right">
    <header class="b-topbar">
      <span class="b-page-title">{{title}}</span>
      <div class="b-topbar-right">
        <div class="b-search">
          <span class="b-search-ico" v-html="icon('search',14)"></span>
          <input placeholder="Search invoices, c…"/>
        </div>
        <div class="b-topbar-avatar">{{initials}}</div>
      </div>
    </header>
    <main class="b-main">
      <router-view></router-view>
    </main>
  </div>
</div>`
});

/* ── Boot ── */
const router=createRouter({
  history:createWebHashHistory(),
  routes:[
    {path:"/",         component:Dashboard, name:"dashboard"},
    {path:"/invoices", component:Invoices,  name:"invoices"},
    {path:"/purchases",component:Invoices,  name:"purchases"},
    {path:"/payments", component:Payments,  name:"payments"},
    {path:"/banking",  component:Banking,   name:"banking"},
    {path:"/accounts", component:Accounts,  name:"accounts"},
    {path:"/reports",  component:Reports,   name:"reports"},
  ]
});

function waitReady(cb,n){
  n=n||0;
  if(window.frappe?.csrf_token||n>40){cb();return;}
  setTimeout(()=>waitReady(cb,n+1),100);
}
waitReady(()=>createApp(App).use(router).mount("#books-app"));

})();
