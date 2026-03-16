<template>
  <div class="page-reports">

    <!-- Report selector tabs -->
    <div class="report-tabs">
      <button
        v-for="r in reports"
        :key="r.key"
        class="report-tab"
        :class="{ active: activeReport === r.key }"
        @click="activeReport = r.key"
      >
        <span v-html="r.icon"></span>
        {{ r.label }}
      </button>
    </div>

    <!-- Date range picker -->
    <div class="books-card date-range-bar">
      <label class="dr-label">From</label>
      <input type="date" v-model="fromDate" class="dr-input" />
      <label class="dr-label">To</label>
      <input type="date" v-model="toDate" class="dr-input" />
      <button class="books-btn books-btn-primary" @click="runReport">Run Report</button>
    </div>

    <!-- P&L -->
    <div v-if="activeReport === 'pl'" class="books-card report-card">
      <div class="books-card-title">Profit & Loss</div>
      <template v-if="plLoading"><div class="loading-shimmer" style="height:120px;border-radius:8px"></div></template>
      <template v-else-if="pl">
        <div class="pl-row income">
          <span>Total Income</span>
          <span class="mono green">{{ fmt(pl.total_income) }}</span>
        </div>
        <div class="pl-row expense">
          <span>Total Expense</span>
          <span class="mono red">{{ fmt(pl.total_expense) }}</span>
        </div>
        <div class="pl-divider"></div>
        <div class="pl-row net" :class="pl.net_profit >= 0 ? 'profit' : 'loss'">
          <span>Net Profit</span>
          <span class="mono">{{ fmt(pl.net_profit) }}</span>
        </div>
      </template>
      <div v-else class="empty-msg">Run the report to see results.</div>
    </div>

    <!-- Balance sheet -->
    <div v-if="activeReport === 'bs'" class="books-card report-card">
      <div class="books-card-title">Balance Sheet</div>
      <template v-if="bsLoading"><div class="loading-shimmer" style="height:120px;border-radius:8px"></div></template>
      <template v-else-if="bs">
        <div class="bs-grid">
          <div class="bs-block assets">
            <div class="bs-section-title">Assets</div>
            <div class="bs-amount">{{ fmt(bs.total_assets) }}</div>
          </div>
          <div class="bs-block liabilities">
            <div class="bs-section-title">Liabilities</div>
            <div class="bs-amount">{{ fmt(bs.total_liabilities) }}</div>
          </div>
          <div class="bs-block equity">
            <div class="bs-section-title">Equity</div>
            <div class="bs-amount">{{ fmt(bs.total_equity) }}</div>
          </div>
        </div>
      </template>
      <div v-else class="empty-msg">Run the report to see results.</div>
    </div>

    <!-- Cash flow -->
    <div v-if="activeReport === 'cf'" class="books-card report-card">
      <div class="books-card-title">Cash Flow</div>
      <template v-if="cfLoading"><div class="loading-shimmer" style="height:120px;border-radius:8px"></div></template>
      <template v-else-if="cf">
        <div class="cf-rows">
          <div class="cf-row"><span>Operating Activities</span><span class="mono" :class="cf.operating >= 0 ? 'green':'red'">{{ fmt(cf.operating) }}</span></div>
          <div class="cf-row"><span>Investing Activities</span><span class="mono" :class="cf.investing >= 0 ? 'green':'red'">{{ fmt(cf.investing) }}</span></div>
          <div class="cf-row"><span>Financing Activities</span><span class="mono" :class="cf.financing >= 0 ? 'green':'red'">{{ fmt(cf.financing) }}</span></div>
          <div class="pl-divider"></div>
          <div class="cf-row net"><span>Net Change</span><span class="mono" :class="cf.net_change >= 0 ? 'green':'red'">{{ fmt(cf.net_change) }}</span></div>
        </div>
      </template>
      <div v-else class="empty-msg">Run the report to see results.</div>
    </div>

    <!-- GST Summary -->
    <div v-if="activeReport === 'gst'" class="books-card report-card">
      <div class="books-card-title">GST Summary</div>
      <template v-if="gstLoading"><div class="loading-shimmer" style="height:80px;border-radius:8px"></div></template>
      <template v-else-if="gst?.length">
        <table class="books-table">
          <thead><tr><th>Tax Type</th><th class="ta-r">Invoice Count</th><th class="ta-r">Total Tax</th></tr></thead>
          <tbody>
            <tr v-for="g in gst" :key="g.tax_type">
              <td><span class="badge badge-blue">{{ g.tax_type }}</span></td>
              <td class="ta-r mono-sm">{{ g.invoice_count }}</td>
              <td class="ta-r mono-sm green">{{ fmt(g.total_tax) }}</td>
            </tr>
          </tbody>
        </table>
      </template>
      <div v-else class="empty-msg">Run the report to see results.</div>
    </div>

  </div>
</template>

<script setup>
import { ref } from "vue";
import { useFrappeCall, formatCurrency } from "../composables/useFrappe.js";

const fmt = formatCurrency;

// Default date range: current month
const today    = new Date();
const fromDate = ref(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0,10));
const toDate   = ref(today.toISOString().slice(0,10));
const activeReport = ref("pl");

const { data: pl,  loading: plLoading,  execute: loadPl  } = useFrappeCall("zoho_books_clone.db.queries.get_profit_and_loss");
const { data: bs,  loading: bsLoading,  execute: loadBs  } = useFrappeCall("zoho_books_clone.db.queries.get_balance_sheet_totals");
const { data: cf,  loading: cfLoading,  execute: loadCf  } = useFrappeCall("zoho_books_clone.db.queries.get_cash_flow");
const { data: gst, loading: gstLoading, execute: loadGst } = useFrappeCall("zoho_books_clone.db.queries.get_gst_summary");

async function runReport() {
  const company = frappe?.boot?.sysdefaults?.company || "";
  const args = { company, from_date: fromDate.value, to_date: toDate.value };
  if (activeReport.value === "pl")  await loadPl(args);
  if (activeReport.value === "bs")  await loadBs({ company, as_of_date: toDate.value });
  if (activeReport.value === "cf")  await loadCf(args);
  if (activeReport.value === "gst") await loadGst(args);
}

const reports = [
  { key: "pl",  label: "Profit & Loss",  icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>` },
  { key: "bs",  label: "Balance Sheet",  icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="8" y1="3" x2="8" y2="21"/></svg>` },
  { key: "cf",  label: "Cash Flow",      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>` },
  { key: "gst", label: "GST Summary",    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` },
];
</script>

<style scoped>
.page-reports { display: flex; flex-direction: column; gap: 16px; }
.report-tabs  { display: flex; gap: 8px; flex-wrap: wrap; }
.report-tab {
  display: flex; align-items: center; gap: 7px;
  padding: 8px 16px; border-radius: var(--radius-sm);
  border: 1px solid var(--books-border); background: var(--books-surface);
  color: var(--books-muted); cursor: pointer; font-size: 13px; font-weight: 600;
  transition: all .15s; font-family: var(--font-body);
}
.report-tab:hover { border-color: var(--books-accent); color: var(--books-text); }
.report-tab.active { background: var(--books-accent-soft); border-color: var(--books-accent); color: var(--books-accent); }

.date-range-bar {
  display: flex; align-items: center; gap: 12px; padding: 14px 20px; flex-wrap: wrap;
}
.dr-label { font-size: 12px; font-family: var(--font-display); color: var(--books-muted); letter-spacing: .06em; }
.dr-input {
  background: var(--books-surface-2); border: 1px solid var(--books-border);
  border-radius: var(--radius-sm); padding: 6px 10px; color: var(--books-text);
  font-size: 12.5px; font-family: var(--font-display); outline: none;
}
.dr-input:focus { border-color: var(--books-accent); }

.report-card { }
.pl-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 0; border-bottom: 1px solid var(--books-border);
  font-size: 14px;
}
.pl-row.net { border-bottom: none; font-size: 16px; font-weight: 700; margin-top: 4px; }
.pl-row.profit .mono { color: var(--books-green); }
.pl-row.loss   .mono { color: var(--books-red);   }
.pl-divider { height: 2px; background: var(--books-border); margin: 4px 0; }

.bs-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
@media (max-width: 700px) { .bs-grid { grid-template-columns: 1fr; } }
.bs-block { background: var(--books-surface-2); border-radius: var(--radius-sm); padding: 18px; }
.bs-section-title { font-family: var(--font-display); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--books-muted); margin-bottom: 10px; }
.assets .bs-amount    { color: var(--books-accent); font-family: var(--font-display); font-size: 20px; font-weight: 700; }
.liabilities .bs-amount { color: var(--books-red);    font-family: var(--font-display); font-size: 20px; font-weight: 700; }
.equity .bs-amount    { color: var(--books-amber);  font-family: var(--font-display); font-size: 20px; font-weight: 700; }

.cf-rows { display: flex; flex-direction: column; gap: 0; }
.cf-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--books-border); font-size: 14px; }
.cf-row.net { border-bottom: none; font-weight: 700; font-size: 15px; margin-top: 4px; }

.mono     { font-family: var(--font-display); }
.mono-sm  { font-family: var(--font-display); font-size: 12.5px; }
.green    { color: var(--books-green); }
.red      { color: var(--books-red);   }
.ta-r     { text-align: right; }
.empty-msg { text-align: center; padding: 32px; color: var(--books-muted); font-size: 13px; }
</style>
