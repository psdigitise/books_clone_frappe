(function(){
"use strict";
if(!document.getElementById("books-app"))return;
if(typeof Vue==="undefined"||typeof VueRouter==="undefined"){
  console.error("[Books] Vue/VueRouter not loaded");return;
}

const{createApp,ref,computed,onMounted,reactive,watch,defineComponent}=Vue;
const{createRouter,createWebHashHistory,useRoute,useRouter}=VueRouter;

/* Expose URL helpers globally immediately so templates can use them */
window.docUrl=function(dt,name){return"/app/"+dt.toLowerCase().replace(/ /g,"-")+"/"+encodeURIComponent(name);};
window.newDocUrl=function(dt){return"/app/"+dt.toLowerCase().replace(/ /g,"-")+"/new";};
window.flt=function(v){return parseFloat(v)||0;};

/* ─── Config ─────────────────────────────────────────────────── */
// Frappe v15 new-doc URL pattern
function newDocUrl(doctype){
  return "/app/"+doctype.toLowerCase().replace(/ /g,"-")+"/new";
}
function docUrl(doctype,name){
  return "/app/"+doctype.toLowerCase().replace(/ /g,"-")+"/"+encodeURIComponent(name);
}
function openDoc(doctype,name){window.open(docUrl(doctype,name),"_blank");}
function openNew(doctype){window.open(newDocUrl(doctype),"_blank");}

/* ─── Helpers ────────────────────────────────────────────────── */
function fmt(v,c){
  if(v==null||v==="")return"—";
  try{return new Intl.NumberFormat("en-IN",{style:"currency",currency:c||"INR",maximumFractionDigits:2}).format(v);}
  catch{return"₹"+Number(v).toLocaleString("en-IN");}
}
function fmtDate(v){
  if(!v)return"—";
  try{return new Date(v).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});}
  catch{return v;}
}
function fmtShort(v){
  if(!v)return"—";
  try{return new Date(v).toLocaleDateString("en-IN",{day:"2-digit",month:"short"});}
  catch{return v;}
}
function isOverdue(inv){return flt(inv.outstanding_amount)>0&&inv.due_date&&new Date(inv.due_date)<new Date();}
function csrf(){return window.frappe?.csrf_token||"";}
function co(){return window.__booksCompany||window.frappe?.boot?.sysdefaults?.company||"";}
function flt(v){return parseFloat(v)||0;}
function today(){return new Date().toISOString().slice(0,10);}

/* ─── API ────────────────────────────────────────────────────── */
/* ─── API helpers ─────────────────────────────────────────────
   GET  → read operations  (no CSRF needed in Frappe)
   POST → write operations (CSRF required)
──────────────────────────────────────────────────────────── */

function _parseResponse(json,status){
  if(json.exc||json.exc_type){
    const match=(json.exc||"").match(/frappe\.exceptions\.\w+: (.+)/);
    throw new Error(match?match[1]:(json.exc_type||json.message||"Server error "+status));
  }
  return json.message;
}

/* GET — safe for all read-only Frappe methods, no CSRF required */
async function apiGET(method,params){
  const qs=new URLSearchParams();
  for(const[k,v]of Object.entries(params||{})){
    qs.append(k,typeof v==="string"?v:JSON.stringify(v));
  }
  const r=await fetch("/api/method/"+method+"?"+qs.toString(),{
    method:"GET",credentials:"same-origin",
    headers:{"Accept":"application/json"}
  });
  let json;
  try{json=await r.json();}catch{throw new Error("Non-JSON response ("+r.status+")");}
  return _parseResponse(json,r.status);
}

/* Refresh CSRF token from session endpoint (GET — no CSRF needed) */
async function refreshCsrfToken(){
  try{
    const r=await fetch("/api/method/zoho_books_clone.api.session.get_books_session",{
      method:"GET",credentials:"same-origin",headers:{"Accept":"application/json"}
    });
    const data=await r.json();
    const token=data?.message?.csrf_token;
    if(token&&token!=="None")window.frappe.csrf_token=token;
  }catch{}
}

/* POST — for write operations; always re-fetches CSRF token first */
async function apiPOST(method,args){
  // Always refresh the token before posting — prevents stale token errors
  await refreshCsrfToken();
  const csrfToken=window.frappe?.csrf_token||getCsrfFromCookie()||"";
  const body=new URLSearchParams();
  if(csrfToken)body.append("csrf_token",csrfToken);
  for(const[k,v]of Object.entries(args||{})){
    body.append(k,typeof v==="string"?v:JSON.stringify(v));
  }
  const r=await fetch("/api/method/"+method,{
    method:"POST",credentials:"same-origin",
    headers:{
      "Content-Type":"application/x-www-form-urlencoded",
      "X-Frappe-CSRF-Token":csrfToken||"",
      "Accept":"application/json"
    },
    body:body.toString()
  });
  let json;
  try{json=await r.json();}catch{throw new Error("Non-JSON response ("+r.status+")");}
  return _parseResponse(json,r.status);
}

/* Legacy alias — kept so any direct api() calls still work (uses GET) */
async function api(method,args){return await apiGET(method,args);}

/* ── Public helpers ── */
async function apiGet(doctype,name){
  return await apiGET("frappe.client.get",{doctype,name});
}

async function apiSave(doc){
  // Use our custom GET endpoint — no CSRF token needed
  return await apiGET("zoho_books_clone.api.docs.save_doc",{doc:JSON.stringify(doc)});
}

async function apiSubmit(doctype,name){
  // Use our custom GET endpoint — no CSRF token needed
  return await apiGET("zoho_books_clone.api.docs.submit_doc",{doctype,name});
}

async function apiList(dt,opts){
  return await apiGET("frappe.client.get_list",{
    doctype:dt,
    fields:JSON.stringify(opts.fields||["name"]),
    filters:JSON.stringify(opts.filters||[]),
    order_by:opts.order||"modified desc",
    limit_page_length:opts.limit||50
  })||[];
}

async function apiLinkValues(doctype,txt,filters){
  const f=filters?[...filters,["name","like","%"+txt+"%"]]:[["name","like","%"+txt+"%"]];
  return await apiGET("frappe.client.get_list",{
    doctype,fields:JSON.stringify(["name"]),
    filters:JSON.stringify(f),
    limit_page_length:10
  })||[];
}

async function resolveCompany(){
  if(window.__booksCompany)return window.__booksCompany;
  try{
    const r=await apiGET("frappe.client.get_value",{
      doctype:"Books Settings",
      filters:JSON.stringify({name:"Books Settings"}),
      fieldname:JSON.stringify(["default_company"])
    });
    const c=r?.default_company||"";
    window.__booksCompany=c;
    if(window.frappe?.boot?.sysdefaults)window.frappe.boot.sysdefaults.company=c;
    return c;
  }catch{return window.__booksCompany||"";}
}

/* ─── Toast ──────────────────────────────────────────────────── */
function toast(msg,type="success"){
  const el=document.createElement("div");
  const bg=type==="error"?"#C92A2A":type==="warning"?"#E67700":"#2F9E44";
  el.style.cssText=`position:fixed;top:20px;right:20px;z-index:99999;
    background:${bg};color:#fff;padding:12px 20px;border-radius:8px;
    font-size:13px;font-weight:500;font-family:'DM Sans',sans-serif;
    box-shadow:0 4px 20px rgba(0,0,0,.2);max-width:360px;line-height:1.4;
    animation:toastIn .2s ease`;
  el.textContent=msg;
  const style=document.createElement("style");
  style.textContent="@keyframes toastIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}";
  document.head.appendChild(style);
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),3500);
}

/* ─── SVG Icons ──────────────────────────────────────────────── */
const IC={
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  pay:'<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
  bank:'<path d="M3 22h18M6 18v-7m4 7v-7m4 7v-7m4 7v-7M3 7l9-5 9 5H3z"/>',
  accts:'<path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM12 14v-4M8 14v-2M16 14v-3"/>',
  chart:'<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  trend:'<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  purchase:'<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  plus:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  refresh:'<polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  trash:'<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>',
  check:'<polyline points="20 6 9 17 4 12"/>',
  x:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  edit:'<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  print:'<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  check:'<polyline points="20 6 9 17 4 12"/>',
  'arrow-left':'<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  ext:'<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
};
function icon(k,s){s=s||16;return`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[k]||""}</svg>`;}

function statusBadge(s){
  return{Paid:"b-badge-green","Partly Paid":"b-badge-amber",Submitted:"b-badge-amber",
    Draft:"b-badge-muted",Cancelled:"b-badge-red",Overdue:"b-badge-red",
    Receive:"b-badge-green",Pay:"b-badge-red",Unreconciled:"b-badge-amber",
    Reconciled:"b-badge-green"}[s]||"b-badge-muted";
}

/* ═══════════════════════════════════════════════════════════════
   INLINE NEW INVOICE MODAL
   Opens a fully functional form inside the Books UI.
   Saves to Frappe via API then redirects to the saved doc.
═══════════════════════════════════════════════════════════════ */
const InvoiceModal=defineComponent({name:"InvoiceModal",
  props:{show:Boolean,doctype:{type:String,default:"Sales Invoice"}},
  emits:["close","saved"],
  setup(props,{emit}){
    const saving=ref(false);
    const company=ref(co());
    const customers=ref([]);
    const accounts_ar=ref([]);
    const accounts_income=ref([]);
    const taxTemplates=ref([]);

    const form=reactive({
      naming_series:"INV-.YYYY.-.#####",
      customer:"",customer_name:"",
      posting_date:today(),due_date:today(),
      company:co(),currency:"INR",
      debit_to:"",income_account:"",
      items:[{item_name:"",description:"",qty:1,rate:0,amount:0}],
      taxes:[],
      notes:"",
      net_total:0,total_tax:0,grand_total:0,
    });

    const isSI=computed(()=>props.doctype==="Sales Invoice");

    // Recalculate totals whenever items or taxes change
    function recalc(){
      form.items.forEach(i=>{i.amount=Math.round(flt(i.qty)*flt(i.rate)*100)/100;});
      const net=form.items.reduce((s,i)=>s+flt(i.amount),0);
      form.taxes.forEach(t=>{t.tax_amount=flt(t.rate)>0?Math.round(net*flt(t.rate)/100*100)/100:0;});
      const tax=form.taxes.reduce((s,t)=>s+flt(t.tax_amount),0);
      form.net_total=Math.round(net*100)/100;
      form.total_tax=Math.round(tax*100)/100;
      form.grand_total=Math.round((net+tax)*100)/100;
    }

    function addItem(){form.items.push({item_name:"",description:"",qty:1,rate:0,amount:0});}
    function removeItem(i){if(form.items.length>1){form.items.splice(i,1);recalc();}}
    function addTax(){form.taxes.push({tax_type:"CGST",description:"CGST",rate:9,tax_amount:0,account_head:""});}
    function removeTax(i){form.taxes.splice(i,1);recalc();}

    // When customer is selected, fetch their name
    async function onCustomer(){
      if(!form.customer)return;
      try{
        const r=await apiGET("frappe.client.get_value",{
          doctype:"Customer",filters:{name:form.customer},
          fieldname:["default_currency"]
        });
        form.customer_name=form.customer; // name IS the display name for custom Customer
        if(r?.default_currency)form.currency=r.default_currency;
      }catch{}
    }

    async function loadDefaults(){
      const c=await resolveCompany();
      form.company=c;
      // Query AR accounts exactly like Frappe desk does: account_type=Receivable, is_group=0
      try{
        const ar=await apiList("Account",{fields:["name"],filters:[["account_type","=","Receivable"],["is_group","=",0]],limit:50});
        accounts_ar.value=ar;
        if(ar.length&&!form.debit_to)form.debit_to=ar[0].name;
      }catch(e){console.warn("AR accounts failed:",e.message);}
      // Income accounts
      try{
        const inc=await apiList("Account",{fields:["name"],filters:[["account_type","in",["Income Account","Income"]],["is_group","=",0]],limit:50});
        accounts_income.value=inc;
        if(inc.length&&!form.income_account)form.income_account=inc[0].name;
      }catch(e){console.warn("Income accounts failed:",e.message);}
      // Load customers
      try{
        customers.value=await apiList("Customer",{fields:["name"],limit:50,order:"name asc"});
      }catch{}
    }

    onMounted(loadDefaults);
    watch(()=>props.show,v=>{if(v)loadDefaults();});

    async function applyTaxTemplate(tplName){}  // Tax templates not available

    async function save(andSubmit){
      if(!form.customer){toast("Please select a Customer","error");return;}
      if(!form.items[0].item_name&&!form.items[0].rate){toast("Please add at least one item","error");return;}
      if(!form.debit_to){toast("Please set the Accounts Receivable (Debit To) account","error");return;}
      if(!form.income_account){toast("Please set the Income Account","error");return;}

      recalc();
      saving.value=true;

      const doc={
        doctype:props.doctype,
        naming_series:form.naming_series,
        customer:form.customer,
        posting_date:form.posting_date,
        due_date:form.due_date||form.posting_date,
        company:form.company,
        currency:form.currency||"INR",
        debit_to:form.debit_to,
        income_account:form.income_account,
        notes:form.notes,
        items:form.items.filter(i=>i.item_name||flt(i.rate)).map((i,idx)=>({
          doctype:"Sales Invoice Item",
          item_name:i.item_name||"Item "+(idx+1),
          description:i.description||i.item_name,
          qty:flt(i.qty)||1,
          rate:flt(i.rate),
          amount:flt(i.amount),
        })),
        taxes:form.taxes.map(t=>({
          doctype:"Tax Line",
          tax_type:t.tax_type,
          description:t.description||t.tax_type,
          rate:flt(t.rate),
          tax_amount:flt(t.tax_amount),
          account_head:t.account_head||"",
        })),
      };

      try{
        const saved=await apiSave(doc);
        if(andSubmit){
          await apiSubmit(props.doctype,saved.name);
          toast("Invoice "+saved.name+" submitted!");
        } else {
          toast("Invoice "+saved.name+" saved as Draft");
        }
        emit("saved",saved.name);
        emit("close");
        // Navigate to the saved doc in Frappe desk
        setTimeout(()=>window.open(docUrl(props.doctype,saved.name),"_blank"),300);
      }catch(e){
        toast(e.message||"Could not save invoice","error");
      }finally{saving.value=false;}
    }

    function onPostingDateChange(){
      if(!form.due_date||form.due_date<form.posting_date)
        form.due_date=form.posting_date;
    }
    return{form,saving,customers,accounts_ar,accounts_income,taxTemplates,isSI,
           recalc,addItem,removeItem,addTax,removeTax,onCustomer,applyTaxTemplate,save,fmt,flt,icon,toast,onPostingDateChange};
  },
  template:`
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
   PURCHASE BILL MODAL — same structure, different fields
═══════════════════════════════════════════════════════════════ */
const PurchaseModal=defineComponent({name:"PurchaseModal",
  props:{show:Boolean},
  emits:["close","saved"],
  setup(props,{emit}){
    const saving=ref(false);
    const suppliers=ref([]),accounts_ap=ref([]),accounts_exp=ref([]);

    const form=reactive({
      naming_series:"PINV-.YYYY.-.#####",
      supplier:"",supplier_name:"",
      posting_date:today(),due_date:today(),
      bill_no:"",
      company:co(),currency:"INR",
      credit_to:"",expense_account:"",
      items:[{item_name:"",qty:1,rate:0,amount:0}],
      taxes:[],
      net_total:0,total_tax:0,grand_total:0,
    });

    function recalc(){
      form.items.forEach(i=>{i.amount=Math.round(flt(i.qty)*flt(i.rate)*100)/100;});
      const net=form.items.reduce((s,i)=>s+flt(i.amount),0);
      form.taxes.forEach(t=>{t.tax_amount=flt(t.rate)>0?Math.round(net*flt(t.rate)/100*100)/100:0;});
      const tax=form.taxes.reduce((s,t)=>s+flt(t.tax_amount),0);
      form.net_total=Math.round(net*100)/100;
      form.total_tax=Math.round(tax*100)/100;
      form.grand_total=Math.round((net+tax)*100)/100;
    }

    function addItem(){form.items.push({item_name:"",qty:1,rate:0,amount:0});}
    function removeItem(i){if(form.items.length>1){form.items.splice(i,1);recalc();}}

    async function loadDefaults(){
      const c=await resolveCompany();form.company=c;
      try{
        const ap=await apiList("Account",{fields:["name"],filters:[["account_type","=","Payable"],["is_group","=",0]],limit:50});
        accounts_ap.value=ap;
        if(ap.length&&!form.credit_to)form.credit_to=ap[0].name;
      }catch(e){console.warn("AP accounts failed:",e.message);}
      try{
        const exp=await apiList("Account",{fields:["name"],filters:[["account_type","in",["Expense Account","Expense","Cost of Goods Sold"]],["is_group","=",0]],limit:50});
        accounts_exp.value=exp;
        if(exp.length&&!form.expense_account)form.expense_account=exp[0].name;
      }catch(e){console.warn("Expense accounts failed:",e.message);}
      try{suppliers.value=await apiList("Supplier",{fields:["name"],limit:50,order:"name asc"});}catch{}
    }

    onMounted(loadDefaults);
    watch(()=>props.show,v=>{if(v)loadDefaults();});

    async function onSupplier(){
      if(!form.supplier)return;
      try{
        const r=await apiGET("frappe.client.get_value",{doctype:"Supplier",filters:JSON.stringify({name:form.supplier}),fieldname:JSON.stringify(["default_currency"])});
        form.supplier_name=form.supplier;
        if(r.default_currency)form.currency=r.default_currency;
      }catch{}
    }

    async function save(andSubmit){
      if(!form.supplier){toast("Please select a Supplier","error");return;}
      if(!form.items[0].item_name&&!form.items[0].rate){toast("Please add at least one item","error");return;}
      if(!form.credit_to){toast("Please set the Accounts Payable (Credit To) account","error");return;}
      if(!form.expense_account){toast("Please set the Expense Account","error");return;}
      recalc();saving.value=true;
      const doc={
        doctype:"Purchase Invoice",
        naming_series:form.naming_series,
        supplier:form.supplier,
        posting_date:form.posting_date,due_date:form.due_date||form.posting_date,
        bill_no:form.bill_no,
        company:form.company,currency:form.currency||"INR",
        credit_to:form.credit_to,expense_account:form.expense_account,
        items:form.items.filter(i=>i.item_name||flt(i.rate)).map((i,idx)=>({
          doctype:"Purchase Invoice Item",
          item_name:i.item_name||"Item "+(idx+1),
          qty:flt(i.qty)||1,rate:flt(i.rate),amount:flt(i.amount),
        })),
        taxes:form.taxes.map(t=>({doctype:"Tax Line",tax_type:t.tax_type,description:t.description||t.tax_type,rate:flt(t.rate),tax_amount:flt(t.tax_amount),account_head:t.account_head||""})),
      };
      try{
        const saved=await apiSave(doc);
        if(andSubmit){await apiSubmit("Purchase Invoice",saved.name);toast("Bill "+saved.name+" submitted!");}
        else{toast("Bill "+saved.name+" saved as Draft");}
        emit("saved",saved.name);emit("close");
        setTimeout(()=>window.open(docUrl("Purchase Invoice",saved.name),"_blank"),300);
      }catch(e){toast(e.message||"Could not save bill","error");}
      finally{saving.value=false;}
    }

    return{form,saving,suppliers,accounts_ap,accounts_exp,recalc,addItem,removeItem,onSupplier,save,fmt,flt,icon};
  },
  template:`
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
const PaymentModal=defineComponent({name:"PaymentModal",
  props:{show:Boolean},
  emits:["close","saved"],
  setup(props,{emit}){
    const saving=ref(false);
    const accounts_bank=ref([]),accounts_ar=ref([]),accounts_ap=ref([]);
    const invoices=ref([]);

    const form=reactive({
      naming_series:"PAY-.YYYY.-.#####",
      payment_type:"Receive",party_type:"Customer",party:"",party_name:"",
      payment_date:today(),paid_amount:0,currency:"INR",
      mode_of_payment:"Bank Transfer",reference_no:"",
      paid_from:"",paid_to:"",company:co(),
      remarks:"",
    });

    const customers=ref([]),suppliers=ref([]);
    const paymentModes=ref([{name:"Bank Transfer"},{name:"Cash"},{name:"Cheque"},{name:"NEFT"},{name:"RTGS"},{name:"UPI"}]);

    async function loadDefaults(){
      const c=await resolveCompany();form.company=c;
      // Load Mode of Payment from standard Frappe doctype
      try{
        const modes=await apiList("Mode of Payment",{fields:["name"],limit:50,order:"name asc"});
        if(modes.length)paymentModes.value=modes;
      }catch{/* fallback to hardcoded defaults above */}
      try{
        const bank=await apiList("Account",{fields:["name"],filters:[["account_type","in",["Bank","Cash"]],["is_group","=",0]],limit:50});
        accounts_bank.value=bank;
      }catch(e){console.warn("Bank accounts failed:",e.message);}
      try{
        const ar=await apiList("Account",{fields:["name"],filters:[["account_type","=","Receivable"],["is_group","=",0]],limit:50});
        accounts_ar.value=ar;
      }catch(e){console.warn("AR accounts failed:",e.message);}
      try{
        const ap=await apiList("Account",{fields:["name"],filters:[["account_type","=","Payable"],["is_group","=",0]],limit:50});
        accounts_ap.value=ap;
      }catch(e){console.warn("AP accounts failed:",e.message);}
      try{customers.value=await apiList("Customer",{fields:["name"],limit:50,order:"name asc"});}catch{}
      try{suppliers.value=await apiList("Supplier",{fields:["name"],limit:50,order:"name asc"});}catch{}
      _autoFillAccounts();
    }

    function _autoFillAccounts(){
      if(form.payment_type==="Receive"){
        if(accounts_ar.value.length&&!form.paid_from)form.paid_from=accounts_ar.value[0].name;
        if(accounts_bank.value.length&&!form.paid_to)form.paid_to=accounts_bank.value[0].name;
      }else{
        if(accounts_bank.value.length&&!form.paid_from)form.paid_from=accounts_bank.value[0].name;
        if(accounts_ap.value.length&&!form.paid_to)form.paid_to=accounts_ap.value[0].name;
      }
    }

    watch(()=>form.payment_type,()=>{
      form.party_type=form.payment_type==="Receive"?"Customer":"Supplier";
      form.party="";form.party_name="";
      form.paid_from="";form.paid_to="";
      invoices.value=[];
      _autoFillAccounts();
    });
    watch(()=>props.show,v=>{if(v)loadDefaults();});
    onMounted(loadDefaults);

    const partyList=computed(()=>form.party_type==="Customer"?customers.value:suppliers.value);

    async function onParty(){
      if(!form.party)return;
      try{
        const nameField="name"; // custom doctypes use name as display name
        const r=await apiGET("frappe.client.get_value",{doctype:form.party_type,filters:JSON.stringify({name:form.party}),fieldname:JSON.stringify([nameField])});
        form.party_name=form.party; // name is display name
      }catch{}
      // Load outstanding invoices
      try{
        invoices.value=await apiGET("zoho_books_clone.payments.utils.get_outstanding_invoices",{party_type:form.party_type,party:form.party});
        if(invoices.value.length){
          form.paid_amount=invoices.value.reduce((s,i)=>s+flt(i.outstanding_amount),0);
          form.remarks="Payment against "+(invoices.value.length===1?invoices.value[0].name:invoices.value.length+" invoices");
        }
      }catch{}
    }

    async function save(){
      if(!form.party){toast("Please select a party","error");return;}
      if(!flt(form.paid_amount)){toast("Please enter payment amount","error");return;}
      if(!form.paid_from){toast("Please select the Paid From account","error");return;}
      if(!form.paid_to){toast("Please select the Paid To account","error");return;}
      saving.value=true;
      try{
        let peName;
        if(invoices.value.length){
          // Use backend utility which handles GL + invoice outstanding update
          const method=form.payment_type==="Receive"?"zoho_books_clone.payments.utils.make_payment_entry_from_invoice":"zoho_books_clone.payments.utils.make_payment_entry_from_purchase_invoice";
          peName=await apiGET(method,{
            source_name:invoices.value[0].name,
            paid_amount:form.paid_amount,
            payment_date:form.payment_date,
            mode_of_payment:form.mode_of_payment,
            reference_no:form.reference_no,
            paid_to:form.payment_type==="Receive"?form.paid_to:undefined,
            paid_from:form.payment_type==="Pay"?form.paid_from:undefined,
          });
        }else{
          // Standalone payment without invoice link
          const doc={
            doctype:"Payment Entry",
            naming_series:form.naming_series,
            payment_type:form.payment_type,
            payment_date:form.payment_date,
            party_type:form.party_type,
            party:form.party,party_name:form.party_name,
            paid_from:form.paid_from,paid_to:form.paid_to,
            paid_amount:flt(form.paid_amount),
            currency:form.currency,
            mode_of_payment:form.mode_of_payment,
            reference_no:form.reference_no,
            company:form.company,
            remarks:form.remarks,
          };
          const saved=await apiSave(doc);
          await apiSubmit("Payment Entry",saved.name);
          peName=saved.name;
        }
        toast("Payment "+peName+" recorded!");
        emit("saved",peName);emit("close");
        setTimeout(()=>window.open(docUrl("Payment Entry",peName),"_blank"),300);
      }catch(e){toast(e.message||"Could not save payment","error");}
      finally{saving.value=false;}
    }

    return{form,saving,customers,suppliers,accounts_bank,accounts_ar,accounts_ap,invoices,partyList,onParty,save,fmt,flt,icon,paymentModes};
  },
  template:`
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
const InvoiceDetail = {
  setup(){
    const route=useRoute();
    const router=useRouter();
    const inv=ref(null);
    const loading=ref(true);
    const error=ref(null);
    const saving=ref(false);
    const submitting=ref(false);
    const printing=ref(false);

    const name=computed(()=>route.params.name);

    async function load(){
      loading.value=true; error.value=null;
      try{
        inv.value=await apiGet("Sales Invoice",name.value);
      }catch(e){error.value=e.message;}
      finally{loading.value=false;}
    }

    async function submitInvoice(){
      if(!confirm("Submit this invoice? This cannot be undone."))return;
      submitting.value=true;
      try{
        await apiSubmit("Sales Invoice",name.value);
        toast("Invoice submitted successfully!","success");
        await load();
      }catch(e){toast("Submit failed: "+e.message,"error");}
      finally{submitting.value=false;}
    }

    async function printInvoice(){
      printing.value=true;
      try{
        window.open("/printview?doctype=Sales+Invoice&name="+encodeURIComponent(name.value)+"&trigger_print=1","_blank");
      }catch(e){toast("Print failed: "+e.message,"error");}
      finally{printing.value=false;}
    }

    onMounted(load);
    watch(()=>route.params.name,load);

    const statusColor=computed(()=>{
      const s=inv.value?.status;
      if(s==="Paid")return"b-badge-green";
      if(s==="Submitted"||s==="Partly Paid")return"b-badge-blue";
      if(s==="Overdue")return"b-badge-red";
      if(s==="Cancelled")return"b-badge-muted";
      return"b-badge-amber";
    });

    const isPaid=computed(()=>inv.value?.status==="Paid");
    const isSubmitted=computed(()=>["Submitted","Partly Paid","Overdue","Paid"].includes(inv.value?.status));
    const isDraft=computed(()=>inv.value?.status==="Draft"||inv.value?.docstatus===0);
    const paidPct=computed(()=>{
      if(!inv.value)return 0;
      const g=flt(inv.value.grand_total);
      const o=flt(inv.value.outstanding_amount);
      if(!g)return 0;
      return Math.round((g-o)/g*100);
    });

    return{inv,loading,error,saving,submitting,printing,name,
           statusColor,isPaid,isSubmitted,isDraft,paidPct,
           load,submitInvoice,printInvoice,
           fmt,fmtDate,flt,icon,toast,router};
  },
  template:`
<div class="b-page" style="max-width:960px;margin:0 auto">

  <!-- Loading -->
  <template v-if="loading">
    <div style="display:flex;align-items:center;gap:12px;padding:8px 0">
      <div class="b-shimmer" style="width:200px;height:28px;border-radius:6px"></div>
      <div class="b-shimmer" style="width:80px;height:24px;border-radius:20px"></div>
    </div>
    <div class="b-card"><div class="b-shimmer" style="height:180px"></div></div>
    <div class="b-card"><div class="b-shimmer" style="height:220px"></div></div>
  </template>

  <!-- Error -->
  <div v-else-if="error" class="b-card b-card-body" style="text-align:center;padding:60px 20px">
    <div v-html="icon('file',40)" style="color:var(--text-4);margin-bottom:16px;opacity:.4"></div>
    <div style="font-size:16px;font-weight:600;color:var(--text-2);margin-bottom:8px">Failed to load invoice</div>
    <div style="font-size:13px;color:var(--text-3);margin-bottom:20px">{{error}}</div>
    <button class="b-btn b-btn-primary" @click="load">Retry</button>
  </div>

  <template v-else-if="inv">

    <!-- Header Bar -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button class="b-btn b-btn-ghost" @click="router.push('/invoices')" style="padding:6px 10px;font-size:12px;display:flex;align-items:center;gap:6px">
          <span v-html="icon('arrow-left',13)"></span> Back
        </button>
        <div>
          <div style="font-size:20px;font-weight:800;color:var(--text);letter-spacing:-.3px">{{inv.name}}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">Sales Invoice</div>
        </div>
        <span class="b-badge" :class="statusColor" style="font-size:12px;padding:4px 10px">{{inv.status||'Draft'}}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="b-btn b-btn-ghost" @click="printInvoice" :disabled="printing" style="display:flex;align-items:center;gap:6px;font-size:13px">
          <span v-html="icon('print',13)"></span> Print
        </button>
        <button v-if="isDraft" class="b-btn b-btn-primary" @click="submitInvoice" :disabled="submitting" style="display:flex;align-items:center;gap:6px;font-size:13px">
          <span v-if="submitting" v-html="icon('refresh',13)" style="animation:spin 1s linear infinite"></span>
          <span v-else v-html="icon('check',13)"></span>
          {{submitting?'Submitting...':'Submit'}}
        </button>
      </div>
    </div>

    <!-- Summary Cards Row -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
      <div class="b-card b-card-body" style="padding:16px 20px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">Grand Total</div>
        <div style="font-size:22px;font-weight:800;color:var(--text);font-family:var(--mono)">{{fmt(inv.grand_total)}}</div>
      </div>
      <div class="b-card b-card-body" style="padding:16px 20px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">Outstanding</div>
        <div style="font-size:22px;font-weight:800;font-family:var(--mono)" :style="{color:flt(inv.outstanding_amount)>0?'var(--amber-text)':'var(--green-text)'}">{{fmt(inv.outstanding_amount)}}</div>
      </div>
      <div class="b-card b-card-body" style="padding:16px 20px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">Due Date</div>
        <div style="font-size:18px;font-weight:700;color:var(--text)">{{fmtDate(inv.due_date)}}</div>
        <div v-if="inv.due_date&&flt(inv.outstanding_amount)>0&&new Date(inv.due_date)<new Date()" style="font-size:11px;color:var(--red-text);margin-top:2px;font-weight:600">● Overdue</div>
      </div>
      <div class="b-card b-card-body" style="padding:16px 20px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px">Payment Progress</div>
        <div style="height:6px;background:var(--surface-2);border-radius:4px;overflow:hidden;margin-bottom:6px">
          <div :style="{width:paidPct+'%',height:'100%',background:'var(--green-text)',borderRadius:'4px',transition:'width .6s ease'}"></div>
        </div>
        <div style="font-size:12px;color:var(--text-3);font-weight:600">{{paidPct}}% paid</div>
      </div>
    </div>

    <!-- Main Info + Customer -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">

      <!-- Invoice Details -->
      <div class="b-card">
        <div class="b-card-head"><span class="b-card-title">Invoice Details</span></div>
        <div class="b-card-body" style="display:flex;flex-direction:column;gap:14px">
          <div class="inv-detail-row">
            <span class="inv-detail-label">Invoice No.</span>
            <span class="inv-detail-value mono fw-700" style="color:var(--accent)">{{inv.name}}</span>
          </div>
          <div class="inv-detail-row" v-if="inv.invoice_number">
            <span class="inv-detail-label">Invoice Number</span>
            <span class="inv-detail-value">{{inv.invoice_number}}</span>
          </div>
          <div class="inv-detail-row">
            <span class="inv-detail-label">Invoice Date</span>
            <span class="inv-detail-value">{{fmtDate(inv.posting_date)}}</span>
          </div>
          <div class="inv-detail-row">
            <span class="inv-detail-label">Due Date</span>
            <span class="inv-detail-value">{{fmtDate(inv.due_date)}}</span>
          </div>
          <div class="inv-detail-row">
            <span class="inv-detail-label">Status</span>
            <span class="b-badge" :class="statusColor">{{inv.status||'Draft'}}</span>
          </div>
          <div class="inv-detail-row" v-if="inv.currency">
            <span class="inv-detail-label">Currency</span>
            <span class="inv-detail-value">{{inv.currency}}</span>
          </div>
          <div class="inv-detail-row" v-if="inv.company">
            <span class="inv-detail-label">Company</span>
            <span class="inv-detail-value">{{inv.company}}</span>
          </div>
          <div class="inv-detail-row" v-if="inv.fiscal_year">
            <span class="inv-detail-label">Fiscal Year</span>
            <span class="inv-detail-value">{{inv.fiscal_year}}</span>
          </div>
        </div>
      </div>

      <!-- Customer & Accounts -->
      <div class="b-card">
        <div class="b-card-head"><span class="b-card-title">Customer & Accounts</span></div>
        <div class="b-card-body" style="display:flex;flex-direction:column;gap:14px">
          <div style="display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--border)">
            <div style="width:44px;height:44px;border-radius:12px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:var(--accent)">
              {{(inv.customer_name||inv.customer||'?')[0].toUpperCase()}}
            </div>
            <div>
              <div style="font-weight:700;font-size:15px;color:var(--text)">{{inv.customer_name||inv.customer}}</div>
              <div style="font-size:12px;color:var(--text-3)">{{inv.customer}}</div>
            </div>
          </div>
          <div class="inv-detail-row" v-if="inv.debit_to">
            <span class="inv-detail-label">AR Account</span>
            <span class="inv-detail-value">{{inv.debit_to}}</span>
          </div>
          <div class="inv-detail-row" v-if="inv.income_account">
            <span class="inv-detail-label">Income Account</span>
            <span class="inv-detail-value">{{inv.income_account}}</span>
          </div>
          <div class="inv-detail-row" v-if="inv.payment_terms">
            <span class="inv-detail-label">Payment Terms</span>
            <span class="inv-detail-value">{{inv.payment_terms}}</span>
          </div>
          <div class="inv-detail-row" v-if="inv.cost_center">
            <span class="inv-detail-label">Cost Center</span>
            <span class="inv-detail-value">{{inv.cost_center}}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Items Table -->
    <div class="b-card">
      <div class="b-card-head">
        <span class="b-card-title">Items</span>
        <span class="b-badge b-badge-muted">{{(inv.items||[]).length}} item{{(inv.items||[]).length===1?'':'s'}}</span>
      </div>
      <div style="overflow-x:auto">
        <table class="b-table" style="min-width:600px">
          <thead>
            <tr>
              <th style="width:4%;text-align:center;color:var(--text-3)">#</th>
              <th style="width:24%">Item</th>
              <th style="width:26%">Description</th>
              <th style="width:8%;text-align:center">Qty</th>
              <th style="width:8%;text-align:center">UOM</th>
              <th style="width:15%;text-align:right">Rate</th>
              <th style="width:15%;text-align:right">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item,i) in (inv.items||[])" :key="i">
              <td style="text-align:center;color:var(--text-4);font-size:12px">{{i+1}}</td>
              <td>
                <div style="font-weight:600;color:var(--text)">{{item.item_name||item.item_code||'—'}}</div>
                <div v-if="item.hsn_code" style="font-size:11px;color:var(--text-3)">HSN: {{item.hsn_code}}</div>
              </td>
              <td style="color:var(--text-2);font-size:13px;max-width:200px">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{item.description||'—'}}</div>
              </td>
              <td style="text-align:center;font-family:var(--mono);font-weight:600">{{flt(item.qty)}}</td>
              <td style="text-align:center;color:var(--text-3);font-size:12px">{{item.uom||'—'}}</td>
              <td style="text-align:right;font-family:var(--mono)">{{fmt(item.rate)}}</td>
              <td style="text-align:right;font-family:var(--mono);font-weight:700;color:var(--text)">{{fmt(item.amount)}}</td>
            </tr>
            <tr v-if="!(inv.items||[]).length">
              <td colspan="7" style="text-align:center;padding:32px;color:var(--text-3)">No items</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Taxes + Totals Row -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">

      <!-- Taxes -->
      <div class="b-card" v-if="(inv.taxes||[]).length">
        <div class="b-card-head"><span class="b-card-title">Taxes & Charges</span></div>
        <div style="overflow-x:auto">
          <table class="b-table">
            <thead><tr><th>Tax Type</th><th>Description</th><th style="text-align:right">Rate %</th><th style="text-align:right">Tax Amount</th></tr></thead>
            <tbody>
              <tr v-for="(tax,i) in (inv.taxes||[])" :key="i">
                <td style="font-weight:600">{{tax.tax_type||'—'}}</td>
                <td style="color:var(--text-2);font-size:13px">{{tax.description||tax.tax_type||'—'}}</td>
                <td style="text-align:right;font-family:var(--mono)">{{flt(tax.rate)}}%</td>
                <td style="text-align:right;font-family:var(--mono);font-weight:600">{{fmt(tax.tax_amount)}}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-else></div>

      <!-- Totals -->
      <div class="b-card b-card-body">
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:1px solid var(--border)">
            <span style="color:var(--text-2);font-size:14px">Net Total</span>
            <span style="font-family:var(--mono);font-weight:600">{{fmt(inv.net_total)}}</span>
          </div>
          <div v-for="tax in (inv.taxes||[])" :key="tax.tax_type" style="display:flex;justify-content:space-between;align-items:center">
            <span style="color:var(--text-2);font-size:13px">{{tax.tax_type}} ({{flt(tax.rate)}}%)</span>
            <span style="font-family:var(--mono);font-size:13px">{{fmt(tax.tax_amount)}}</span>
          </div>
          <div v-if="flt(inv.total_tax)" style="display:flex;justify-content:space-between;align-items:center">
            <span style="color:var(--text-2);font-size:14px">Total Tax</span>
            <span style="font-family:var(--mono);font-weight:600">{{fmt(inv.total_tax)}}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--accent-soft);border-radius:var(--radius-sm);margin-top:4px">
            <span style="font-weight:800;font-size:15px;color:var(--accent-text)">Grand Total</span>
            <span style="font-family:var(--mono);font-weight:800;font-size:18px;color:var(--accent)">{{fmt(inv.grand_total)}}</span>
          </div>
          <div v-if="flt(inv.outstanding_amount)" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--border);margin-top:4px">
            <span style="color:var(--amber-text);font-weight:600;font-size:13px">Outstanding</span>
            <span style="font-family:var(--mono);font-weight:700;color:var(--amber-text)">{{fmt(inv.outstanding_amount)}}</span>
          </div>
          <div v-else style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--border);margin-top:4px">
            <span style="color:var(--green-text);font-weight:600;font-size:13px">✓ Fully Paid</span>
            <span style="font-family:var(--mono);font-weight:700;color:var(--green-text)">{{fmt(0)}}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Notes & Terms -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" v-if="inv.notes||inv.terms">
      <div class="b-card b-card-body" v-if="inv.notes">
        <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:10px">Notes</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.6;white-space:pre-wrap">{{inv.notes}}</div>
      </div>
      <div class="b-card b-card-body" v-if="inv.terms">
        <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:10px">Terms & Conditions</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.6;white-space:pre-wrap">{{inv.terms}}</div>
      </div>
    </div>

  </template>
</div>
`
};


const Dashboard=defineComponent({name:"Dashboard",
  components:{InvoiceModal,PurchaseModal,PaymentModal},
  setup(){
    const kpis=ref(null),dash=ref(null),aging=ref({});
    const loading=ref(true),showSI=ref(false),showPI=ref(false),showPay=ref(false);
    const agingRows=[{k:"current",lbl:"Current",color:"#2F9E44"},{k:"1_30",lbl:"1–30 days",color:"#E67700"},{k:"31_60",lbl:"31–60 days",color:"#F08C00"},{k:"61_90",lbl:"61–90 days",color:"#E8590C"},{k:"over_90",lbl:"90+ days",color:"#C92A2A"}];
    const agingMax=computed(()=>Math.max(1,...agingRows.map(r=>flt(aging.value[r.k]))));
    const kpiDefs=computed(()=>[
      {lbl:"Monthly Revenue",val:fmt(kpis.value?.month_revenue),trend:`${kpis.value?.overdue_count||0} overdue`,up:true,icon:"trend",bg:"#eff6ff",ic:"#2563eb"},
      {lbl:"Collected",val:fmt(kpis.value?.month_collected),trend:"this month",up:true,icon:"pay",bg:"#f0fdf4",ic:"#16a34a"},
      {lbl:"Outstanding",val:fmt(kpis.value?.month_outstanding),trend:kpis.value?.overdue_count+" overdue",up:false,icon:"accts",bg:"#fef2f2",ic:"#dc2626"},
      {lbl:"Net Profit (MTD)",val:fmt(kpis.value?.net_profit_mtd),trend:"month to date",up:true,icon:"chart",bg:"#f5f3ff",ic:"#7c3aed"},
    ]);
    async function load(){
      loading.value=true;
      const company=await resolveCompany();
      try{
        // get_home_dashboard returns everything in one whitelisted call
        const d=await apiGET("zoho_books_clone.api.dashboard.get_home_dashboard",{company});
        dash.value=d||{};
        // KPIs are embedded in the dashboard response
        kpis.value={
          month_revenue:     d?.month_revenue     || 0,
          month_collected:   d?.month_collected   || 0,
          month_outstanding: d?.month_outstanding || 0,
          net_profit_mtd:    d?.net_profit_mtd    || 0,
          total_assets:      d?.total_assets      || 0,
          overdue_count:     d?.overdue_count      || (d?.overdue_invoices?.length || 0),
        };
        // Aging buckets from the dashboard response
        aging.value=d?.aging_buckets || {};
      }catch(e){console.error("[Dashboard]",e);}
      finally{loading.value=false;}
    }
    onMounted(load);
    return{kpis,dash,aging,loading,kpiDefs,agingRows,agingMax,showSI,showPI,showPay,load,fmt,fmtDate,fmtShort,isOverdue,statusBadge,icon,openDoc};
  },
  template:`
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

const Invoices=defineComponent({name:"Invoices",
  components:{InvoiceModal},
  setup(){
    const list=ref([]),loading=ref(true),active=ref("all"),showNew=ref(false);
    const search=ref("");
    const filters=[{k:"all",lbl:"All"},{k:"Draft",lbl:"Draft"},{k:"Submitted",lbl:"Unpaid"},{k:"Overdue",lbl:"Overdue"},{k:"Paid",lbl:"Paid"}];
    const counts=computed(()=>({
      Draft:list.value.filter(i=>i.status==="Draft").length,
      Submitted:list.value.filter(i=>["Submitted","Partly Paid"].includes(i.status)).length,
      Overdue:list.value.filter(isOverdue).length,
      Paid:list.value.filter(i=>i.status==="Paid").length,
    }));
    const filtered=computed(()=>{
      let r=list.value;
      if(active.value==="Overdue")r=r.filter(isOverdue);
      else if(active.value!=="all")r=r.filter(i=>i.status===active.value);
      if(search.value)r=r.filter(i=>(i.name+(i.customer||"")).toLowerCase().includes(search.value.toLowerCase()));
      return r;
    });
    function pillBadge(k){return{Draft:"b-badge-muted",Submitted:"b-badge-amber",Overdue:"b-badge-red",Paid:"b-badge-green"}[k]||"b-badge-muted";}
    async function load(){
      loading.value=true;
      try{list.value=await apiList("Sales Invoice",{fields:["name","customer","posting_date","due_date","grand_total","outstanding_amount","status"],order:"posting_date desc"});}
      catch(e){console.error("Sales Invoice load failed:",e.message);toast("Failed to load invoices: "+e.message,"error");}
      finally{loading.value=false;}
    }
    onMounted(load);
    return{list,loading,active,filters,counts,filtered,search,showNew,pillBadge,load,fmt,fmtDate,isOverdue,statusBadge,icon,flt,openDoc};
  },
  template:`
<div class="b-page">
  <InvoiceModal :show="showNew" @close="showNew=false" @saved="load"/>
  <div class="b-action-bar">
    <div class="b-filter-row">
      <button v-for="f in filters" :key="f.k" class="b-pill" :class="{active:active===f.k}" @click="active=f.k">
        {{f.lbl}}<span v-if="f.k!=='all'" class="b-badge" :class="pillBadge(f.k)" style="margin-left:4px;font-size:10px;padding:1px 5px;vertical-align:middle">{{counts[f.k]}}</span>
      </button>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <div style="display:flex;align-items:center;gap:7px;background:#fff;border:1px solid #E8ECF0;border-radius:20px;padding:6px 12px">
        <span v-html="icon('search',13)" style="color:#ADB5BD"></span>
        <input v-model="search" placeholder="Search…" style="border:none;outline:none;font-size:13px;font-family:inherit;width:140px;color:#1A1D23"/>
      </div>
      <button class="b-btn b-btn-ghost" @click="load"><span v-html="icon('refresh',13)"></span> Refresh</button>
      <button class="b-btn b-btn-primary" @click="showNew=true"><span v-html="icon('plus',13)"></span> New Invoice</button>
    </div>
  </div>
  <div class="b-card" style="padding:0;overflow:hidden">
    <table class="b-table">
      <thead><tr><th>Invoice #</th><th>Customer</th><th>Date</th><th>Due Date</th><th class="ta-r">Amount</th><th class="ta-r">Outstanding</th><th>Status</th><th></th></tr></thead>
      <tbody>
        <template v-if="loading"><tr v-for="n in 8" :key="n"><td colspan="8" style="padding:14px"><div class="b-shimmer" style="height:13px"></div></td></tr></template>
        <template v-else>
          <tr v-for="inv in filtered" :key="inv.name" class="clickable">
            <td @click="$router.push('/invoices/'+inv.name)"><span class="mono c-accent fw-700" style="font-size:12px">{{inv.name}}</span></td>
            <td class="fw-600" @click="$router.push('/invoices/'+inv.name)">{{inv.customer}}</td>
            <td class="c-muted" style="font-size:12.5px" @click="$router.push('/invoices/'+inv.name)">{{fmtDate(inv.posting_date)}}</td>
            <td style="font-size:12.5px" :class="isOverdue(inv)?'c-red fw-600':'c-muted'" @click="$router.push('/invoices/'+inv.name)">{{fmtDate(inv.due_date)}}</td>
            <td class="ta-r mono fw-600" style="font-size:13px" @click="$router.push('/invoices/'+inv.name)">{{fmt(inv.grand_total)}}</td>
            <td class="ta-r mono fw-600" style="font-size:13px" :class="flt(inv.outstanding_amount)>0?'c-amber':'c-green'" @click="$router.push('/invoices/'+inv.name)">{{fmt(inv.outstanding_amount)}}</td>
            <td @click="$router.push('/invoices/'+inv.name)"><span class="b-badge" :class="statusBadge(inv.status)">{{inv.status}}</span></td>
            <td><button @click.stop="openDoc('Sales Invoice',inv.name)" style="background:none;border:none;cursor:pointer;color:#3B5BDB" v-html="icon('ext',14)" title="Open in Frappe"></button></td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="8" class="b-empty">No invoices found</td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`});

const Purchases=defineComponent({name:"Purchases",
  components:{PurchaseModal},
  setup(){
    const list=ref([]),loading=ref(true),showNew=ref(false);
    async function load(){
      loading.value=true;
      try{list.value=await apiList("Purchase Invoice",{fields:["name","supplier","posting_date","due_date","grand_total","outstanding_amount","status"],order:"posting_date desc"});}
      catch(e){console.error("Purchase Invoice load failed:",e.message);toast("Failed to load bills: "+e.message,"error");}
      finally{loading.value=false;}
    }
    onMounted(load);
    return{list,loading,showNew,load,fmt,fmtDate,statusBadge,icon,flt,openDoc};
  },
  template:`
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

const Payments=defineComponent({name:"Payments",
  components:{PaymentModal},
  setup(){
    const list=ref([]),loading=ref(true),active=ref("all"),showNew=ref(false);
    const types=[{k:"all",lbl:"All"},{k:"Receive",lbl:"Received"},{k:"Pay",lbl:"Paid Out"}];
    const filtered=computed(()=>active.value==="all"?list.value:list.value.filter(p=>p.payment_type===active.value));
    async function load(){
      loading.value=true;
      try{list.value=await apiList("Payment Entry",{fields:["name","party","party_type","paid_amount","payment_type","payment_date","mode_of_payment"],order:"payment_date desc"});}
      catch(e){console.error("Payment Entry load failed:",e.message);toast("Failed to load payments: "+e.message,"error");}
      finally{loading.value=false;}
    }
    onMounted(load);
    return{list,loading,active,types,filtered,showNew,load,fmt,fmtDate,icon,statusBadge,openDoc};
  },
  template:`
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

const Banking=defineComponent({name:"Banking",
  setup(){
    const cash=ref(null),cashLoad=ref(true),txns=ref([]),txnLoad=ref(false),sel=ref(null);
    async function loadCash(){cashLoad.value=true;try{cash.value=await apiGET("zoho_books_clone.api.dashboard.get_cash_position");}finally{cashLoad.value=false;}}
    async function pickAcct(a){
      sel.value=a.name;txnLoad.value=true;
      try{txns.value=await apiList("Bank Transaction",{fields:["name","date","description","debit","credit","balance","reference_number","status"],filters:[["bank_account","=",a.name]],order:"date desc",limit:30});}
      finally{txnLoad.value=false;}
    }
    onMounted(loadCash);
    return{cash,cashLoad,txns,txnLoad,sel,pickAcct,fmt,fmtDate,icon,statusBadge,flt};
  },
  template:`
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

const Accounts=defineComponent({name:"Accounts",
  setup(){
    const list=ref([]),loading=ref(true),active=ref("All");
    const types=computed(()=>["All",...new Set(list.value.map(a=>a.account_type).filter(Boolean))]);
    const filtered=computed(()=>active.value==="All"?list.value:list.value.filter(a=>a.account_type===active.value));
    const TC={Asset:"b-badge-blue",Liability:"b-badge-red",Equity:"b-badge-amber",Income:"b-badge-green",Expense:"b-badge-red",Bank:"b-badge-blue",Cash:"b-badge-green",Receivable:"b-badge-blue",Payable:"b-badge-red",Tax:"b-badge-amber"};
    async function load(){
      loading.value=true;
      try{list.value=await apiList("Account",{fields:["name","account_name","account_type","parent_account","is_group"],limit:100,order:"account_type asc, account_name asc"});}
      finally{loading.value=false;}
    }
    onMounted(load);
    return{list,loading,active,types,filtered,TC,load,fmt,icon,openDoc,openNew};
  },
  template:`
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

const Reports=defineComponent({name:"Reports",
  setup(){
    const today_str=new Date().toISOString().slice(0,10);
    const from=ref(new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString().slice(0,10));
    const to=ref(today_str);
    const tab=ref("pl"),running=ref(false);
    const pl=ref(null),bs=ref(null),cf=ref(null),gst=ref(null);
    const tabs=[{k:"pl",lbl:"P & L"},{k:"bs",lbl:"Balance Sheet"},{k:"cf",lbl:"Cash Flow"},{k:"gst",lbl:"GST Summary"}];
    async function run(){
      running.value=true;
      const c=co(),args={company:c,from_date:from.value,to_date:to.value};
      try{
        if(tab.value==="pl")pl.value=await apiGET("zoho_books_clone.db.queries.get_profit_and_loss",args);
        else if(tab.value==="bs")bs.value=await apiGET("zoho_books_clone.db.queries.get_balance_sheet_totals",{company:c,as_of_date:to.value});
        else if(tab.value==="cf")cf.value=await apiGET("zoho_books_clone.db.queries.get_cash_flow",args);
        else gst.value=await apiGET("zoho_books_clone.db.queries.get_gst_summary",args);
      }catch(e){toast(e.message,"error");}
      finally{running.value=false;}
    }
    return{from,to,tab,tabs,pl,bs,cf,gst,running,run,fmt,icon,flt};
  },
  template:`
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
const NAV=[
  {section:"MAIN",items:[{to:"/",lbl:"Dashboard",icon:"grid"}]},
  {section:"INVOICING",items:[{to:"/invoices",lbl:"Sales Invoices",icon:"file"},{to:"/purchases",lbl:"Purchase Bills",icon:"purchase"},{to:"/payments",lbl:"Payments",icon:"pay"}]},
  {section:"REPORTS",items:[{to:"/reports",lbl:"P & L",icon:"trend"},{to:"/accounts",lbl:"Balance Sheet",icon:"chart"}]},
  {section:"",items:[{to:"/banking",lbl:"Banking",icon:"bank"}]},
];
const TITLES={dashboard:"Dashboard",invoices:"Sales Invoices",purchases:"Purchase Bills",payments:"Payments",banking:"Banking",accounts:"Chart of Accounts",reports:"Reports"};

const App=defineComponent({name:"BooksApp",
  setup(){
    const route=useRoute();
    const cname=computed(()=>window.__booksCompany||"My Company");
    const initials=computed(()=>{const n=window.frappe?.session?.user_fullname||"Admin";return n.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();});
    const fullname=computed(()=>window.frappe?.session?.user_fullname||"Administrator");
    const title=computed(()=>TITLES[route.name]||"Books");
    const collapsed=ref(false);
    return{cname,initials,fullname,title,NAV,icon,collapsed};
  },
  template:`
<div :class="{'books-root':true, collapsed:collapsed}">
  <aside class="b-sidebar">
    <div class="b-brand">
      <div class="b-brand-icon">B</div>
      <div class="b-brand-info"><div class="b-brand-name">Books</div><div class="b-brand-sub">Accounting</div></div>
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
      <button class="b-collapse-btn" @click="collapsed=!collapsed">
        <span v-html="icon(collapsed?'chevR':'chevL',14)"></span>
        <span class="b-nav-label">Collapse</span>
      </button>
      <div class="b-user-row" style="margin-top:6px">
        <div class="b-user-avatar">{{initials}}</div>
        <div class="b-user-info"><div class="b-user-name">{{fullname}}</div><div class="b-user-role">Books Admin</div></div>
      </div>
    </div>
  </aside>
  <div class="b-right">
    <header class="b-topbar">
      <span class="b-page-title">{{title}}</span>
      <div class="b-topbar-right">
        <div class="b-search"><span class="b-search-ico" v-html="icon('search',14)"></span><input placeholder="Search invoices, c…"/></div>
        <div class="b-topbar-avatar">{{initials}}</div>
      </div>
    </header>
    <main class="b-main"><router-view></router-view></main>
  </div>
</div>`});

/* ── CSS for modal inputs (injected once) ── */
const modalCSS=`
.mi-label{display:block;font-size:11.5px;font-weight:600;color:#495057;margin-bottom:4px;letter-spacing:.1px}
.mi-input{width:100%;border:1px solid #CDD5E0;border-radius:6px;padding:8px 10px;font-size:13.5px;
  font-family:inherit;color:#1A1D23;background:#fff;outline:none;transition:.15s;appearance:none}
.mi-input:focus{border-color:#3B5BDB;box-shadow:0 0 0 3px rgba(59,91,219,.1)}
.mi-th{padding:9px 12px;text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.5px;
  text-transform:uppercase;color:#868E96;border-bottom:1px solid #E8ECF0;white-space:nowrap}
.mi-td{padding:8px 12px;border-bottom:1px solid #F1F3F5;vertical-align:middle}
.mi-cell-input{border:none;outline:none;background:transparent;font-family:inherit;font-size:13.5px;
  color:#1A1D23;width:100%;padding:3px 6px;border-radius:4px;transition:.12s}
.mi-cell-input:focus{background:#EEF2FF;box-shadow:0 0 0 2px rgba(59,91,219,.2)}
.b-quick-actions{display:flex;gap:10px;margin-bottom:16px}
.inv-detail-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)}
.inv-detail-row:last-child{border-bottom:none}
.inv-detail-label{font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em}
.inv-detail-value{font-size:13px;color:var(--text);font-weight:500;text-align:right}
@keyframes spin{to{transform:rotate(360deg)}}
`;

if(!document.getElementById("books-modal-css")){
  const s=document.createElement("style");s.id="books-modal-css";s.textContent=modalCSS;
  document.head.appendChild(s);
}

/* ── Boot ── */
const router=createRouter({
  history:createWebHashHistory(),
  routes:[
    {path:"/",        component:Dashboard,name:"dashboard"},
    {path:"/invoices",component:Invoices, name:"invoices"},
    {path:"/invoices/:name",component:InvoiceDetail,name:"invoice-detail"},
    {path:"/purchases",component:Purchases,name:"purchases"},
    {path:"/payments",component:Payments, name:"payments"},
    {path:"/banking", component:Banking,  name:"banking"},
    {path:"/accounts",component:Accounts, name:"accounts"},
    {path:"/reports", component:Reports,  name:"reports"},
  ]
});

function getCsrfFromCookie(){
  const m=document.cookie.split(";").map(c=>c.trim()).find(c=>c.startsWith("csrf_token="));
  return m?decodeURIComponent(m.split("=").slice(1).join("=")):"";
}

async function bootstrapCsrf(){
  if(!window.frappe)window.frappe={session:{},boot:{sysdefaults:{company:""}}};

  // Step 1: Try GET /api/method/zoho_books_clone.api.session.get_books_session
  // This is a GET so no CSRF needed — and it returns the token for future POSTs
  try{
    const r=await fetch("/api/method/zoho_books_clone.api.session.get_books_session",{
      method:"GET",credentials:"same-origin",
      headers:{"Accept":"application/json"}
    });
    if(!r.ok){
      // Not logged in — redirect to login
      window.location.href="/login?redirect-to=/books";
      return "";
    }
    const data=await r.json();
    const msg=data.message||{};
    if(msg.csrf_token&&msg.csrf_token!=="None"){
      window.frappe.csrf_token=msg.csrf_token;
    }
    if(msg.user)window.frappe.session.user=msg.user;
    if(msg.company){
      window.__booksCompany=msg.company;
      window.frappe.boot.sysdefaults.company=msg.company;
    }
    if(window.frappe.csrf_token&&window.frappe.csrf_token!=="None"){
      return window.frappe.csrf_token;
    }
  }catch(e){console.warn("[Books] Session fetch failed:",e.message);}

  // Step 2: Cookie fallback
  const fromCookie=getCsrfFromCookie();
  if(fromCookie&&fromCookie!=="None"){
    window.frappe.csrf_token=fromCookie;
    return fromCookie;
  }

  console.error("[Books] No CSRF token available — POSTs will fail");
  return "";
}

bootstrapCsrf().then(()=>{
  createApp(App).use(router).mount("#books-app");
});

})();
