<template>
  <div class="dashboard">

    <!-- KPI row -->
    <div class="kpi-grid">
      <div v-for="kpi in kpiCards" :key="kpi.key" class="books-card kpi-card">
        <div class="kpi-icon" :style="{ background: kpi.iconBg }">
          <span v-html="kpi.icon"></span>
        </div>
        <div class="kpi-body">
          <div class="kpi-label">{{ kpi.label }}</div>
          <div class="kpi-value" :class="kpi.valueClass">
            <template v-if="kpiLoading">
              <div class="loading-shimmer" style="width:80px;height:22px;margin-top:4px"></div>
            </template>
            <template v-else>
              {{ kpi.format === "currency" ? fmt(kpis?.[kpi.key]) : (kpis?.[kpi.key] ?? "—") }}
            </template>
          </div>
          <div v-if="kpi.sub" class="kpi-sub">{{ kpi.sub }}</div>
        </div>
      </div>
    </div>

    <!-- Middle row -->
    <div class="mid-grid">
      <!-- Revenue trend chart -->
      <div class="books-card chart-card">
        <div class="card-header">
          <span class="books-card-title">Revenue Trend</span>
          <span class="badge badge-blue">Last 6 months</span>
        </div>
        <div v-if="trendLoading" class="chart-placeholder">
          <div class="loading-shimmer" style="height:160px;border-radius:8px"></div>
        </div>
        <div v-else class="chart-wrap">
          <svg class="revenue-svg" :viewBox="`0 0 ${svgW} ${svgH}`" preserveAspectRatio="none">
            <!-- Grid lines -->
            <line v-for="y in yLines" :key="y"
              :x1="pad" :x2="svgW - pad" :y1="y" :y2="y"
              stroke="var(--books-border)" stroke-width="1"
            />
            <!-- Area fill -->
            <path v-if="areaPath" :d="areaPath"
              fill="url(#rev-grad)" opacity=".35"
            />
            <!-- Line -->
            <path v-if="linePath" :d="linePath"
              fill="none" stroke="var(--books-accent)" stroke-width="2.5"
              stroke-linecap="round" stroke-linejoin="round"
            />
            <!-- Dots -->
            <circle v-for="(pt, i) in points" :key="i"
              :cx="pt.x" :cy="pt.y" r="4"
              fill="var(--books-accent)" stroke="var(--books-surface)" stroke-width="2"
              class="chart-dot"
            />
            <!-- Labels -->
            <text v-for="(pt, i) in points" :key="'l'+i"
              :x="pt.x" :y="svgH - 4"
              text-anchor="middle" class="chart-label"
            >{{ pt.label }}</text>
            <defs>
              <linearGradient id="rev-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stop-color="var(--books-accent)" stop-opacity=".8"/>
                <stop offset="100%" stop-color="var(--books-accent)" stop-opacity="0"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
      </div>

      <!-- Aging buckets -->
      <div class="books-card aging-card">
        <div class="card-header">
          <span class="books-card-title">AR Aging</span>
        </div>
        <div v-if="agingLoading" class="aging-bars">
          <div v-for="n in 5" :key="n" class="aging-row">
            <div class="loading-shimmer" style="height:12px;width:60px"></div>
            <div class="loading-shimmer" style="height:12px;width:100px"></div>
          </div>
        </div>
        <div v-else class="aging-bars">
          <div v-for="bucket in agingRows" :key="bucket.key" class="aging-row">
            <span class="aging-label">{{ bucket.label }}</span>
            <div class="aging-bar-wrap">
              <div class="aging-bar" :style="{ width: bucket.pct + '%', background: bucket.color }"></div>
            </div>
            <span class="aging-amount" :style="{ color: bucket.color }">{{ fmt(aging?.[bucket.key]) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom row -->
    <div class="bot-grid">
      <!-- Top customers -->
      <div class="books-card">
        <div class="card-header">
          <span class="books-card-title">Top Customers</span>
          <button class="books-btn books-btn-ghost" style="font-size:11px;padding:4px 10px" @click="navTo('/invoices')">View all</button>
        </div>
        <table class="books-table" v-if="!dashLoading">
          <thead>
            <tr>
              <th>Customer</th>
              <th class="ta-r">Invoices</th>
              <th class="ta-r">Revenue</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in (dash?.top_customers || [])" :key="c.customer">
              <td>
                <div class="cust-name">{{ c.customer_name || c.customer }}</div>
                <div class="cust-sub">{{ c.customer }}</div>
              </td>
              <td class="ta-r mono">{{ c.invoice_count }}</td>
              <td class="ta-r mono green">{{ fmt(c.total_revenue) }}</td>
            </tr>
            <tr v-if="!dash?.top_customers?.length">
              <td colspan="3" style="text-align:center;color:var(--books-muted);padding:24px">No data</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="loading-shimmer" style="height:140px;border-radius:8px"></div>
      </div>

      <!-- Overdue invoices -->
      <div class="books-card">
        <div class="card-header">
          <span class="books-card-title">Overdue Invoices</span>
          <span class="badge badge-red">{{ dash?.overdue_invoices?.length || 0 }} overdue</span>
        </div>
        <table class="books-table" v-if="!dashLoading">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th class="ta-r">Due</th>
              <th class="ta-r">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="inv in (dash?.overdue_invoices?.slice(0,5) || [])" :key="inv.name">
              <td><a class="link-accent" :href="`/app/sales-invoice/${inv.name}`">{{ inv.name }}</a></td>
              <td class="text-muted">{{ inv.customer_name || inv.customer }}</td>
              <td class="ta-r mono red">{{ fmtDate(inv.due_date) }}</td>
              <td class="ta-r mono red">{{ fmt(inv.outstanding_amount) }}</td>
            </tr>
            <tr v-if="!dash?.overdue_invoices?.length">
              <td colspan="4" style="text-align:center;color:var(--books-green);padding:24px">✓ All caught up!</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="loading-shimmer" style="height:140px;border-radius:8px"></div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useFrappeCall, formatCurrency, formatDate } from "../composables/useFrappe.js";

const router = useRouter();
const fmt    = (v) => formatCurrency(v);
const fmtDate = formatDate;
const navTo  = (p) => router.push(p);

// ── API calls ──
const { data: dash,   loading: dashLoading,  execute: loadDash   } = useFrappeCall("zoho_books_clone.api.dashboard.get_home_dashboard");
const { data: kpis,   loading: kpiLoading,   execute: loadKpis   } = useFrappeCall("zoho_books_clone.db.aggregates.get_dashboard_kpis");
const { data: trend,  loading: trendLoading, execute: loadTrend  } = useFrappeCall("zoho_books_clone.db.aggregates.get_monthly_revenue_trend");
const { data: aging,  loading: agingLoading, execute: loadAging  } = useFrappeCall("zoho_books_clone.db.aggregates.get_aging_buckets");

onMounted(() => {
  loadDash();
  loadKpis();
  loadTrend();
  loadAging();
});

// ── KPI cards config ──
const kpiCards = [
  { key: "month_revenue",     label: "Month Revenue",   format: "currency", icon: iconRevenue, iconBg: "rgba(79,142,247,.12)",  valueClass: "blue"  },
  { key: "month_collected",   label: "Collected",       format: "currency", icon: iconCollect, iconBg: "rgba(52,211,153,.12)",  valueClass: "green" },
  { key: "month_outstanding", label: "Outstanding",     format: "currency", icon: iconOutstand,iconBg: "rgba(248,113,113,.12)", valueClass: "red"   },
  { key: "net_profit_mtd",    label: "Net Profit MTD",  format: "currency", icon: iconProfit,  iconBg: "rgba(251,191,36,.12)",  valueClass: "amber" },
  { key: "total_assets",      label: "Total Assets",    format: "currency", icon: iconAssets,  iconBg: "rgba(79,142,247,.12)",  valueClass: ""      },
  { key: "overdue_count",     label: "Overdue",         format: "number",   icon: iconAlert,   iconBg: "rgba(248,113,113,.12)", valueClass: "red"   },
];

// ── Revenue chart ──
const svgW = 600, svgH = 200, pad = 40;
const yLines = [40, 80, 120, 160];

const points = computed(() => {
  const rows = trend.value || [];
  if (!rows.length) return [];
  const maxRev = Math.max(...rows.map(r => r.revenue || 0), 1);
  const step   = (svgW - pad * 2) / Math.max(rows.length - 1, 1);
  return rows.map((r, i) => ({
    x: pad + i * step,
    y: svgH - 30 - ((r.revenue || 0) / maxRev) * (svgH - 70),
    label: r.month?.slice(5) || "",
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
  const base = svgH - 30;
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  return `${line} L${pts.at(-1).x},${base} L${pts[0].x},${base} Z`;
});

// ── Aging config ──
const agingRows = [
  { key: "current", label: "Current",  color: "var(--books-green)" },
  { key: "1_30",    label: "1–30 days",color: "var(--books-accent)" },
  { key: "31_60",   label: "31–60 days",color: "var(--books-amber)"},
  { key: "61_90",   label: "61–90 days",color: "#fb923c"           },
  { key: "over_90", label: ">90 days",  color: "var(--books-red)"  },
].map(b => {
  const total = Object.values(aging.value || {}).reduce((a, v) => a + (v || 0), 0) || 1;
  return { ...b, pct: Math.min(100, (((aging.value || {})[b.key] || 0) / total) * 100) };
});

// ── Icons ──
const iconRevenue  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;
const iconCollect  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
const iconOutstand = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const iconProfit   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`;
const iconAssets   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>`;
const iconAlert    = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
</script>

<style scoped>
.dashboard { display: flex; flex-direction: column; gap: 20px; }

/* KPI grid */
.kpi-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px; }
@media (max-width: 1400px) { .kpi-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 900px)  { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }

.kpi-card { display: flex; align-items: center; gap: 14px; padding: 16px 18px; }
.kpi-icon {
  width: 42px; height: 42px; border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; color: var(--books-text);
}
.kpi-label {
  font-size: 11px; color: var(--books-muted);
  font-family: var(--font-display); letter-spacing: .06em; text-transform: uppercase;
}
.kpi-value {
  font-size: 19px; font-weight: 700; margin-top: 2px;
  font-family: var(--font-display); letter-spacing: -.02em;
}
.kpi-value.green { color: var(--books-green); }
.kpi-value.red   { color: var(--books-red);   }
.kpi-value.amber { color: var(--books-amber); }
.kpi-value.blue  { color: var(--books-accent);}

/* Mid grid */
.mid-grid { display: grid; grid-template-columns: 1fr 320px; gap: 14px; }
@media (max-width: 1100px) { .mid-grid { grid-template-columns: 1fr; } }

.chart-card { }
.card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.chart-wrap  { overflow: hidden; }
.revenue-svg { width: 100%; height: 180px; display: block; overflow: visible; }
.chart-dot   { cursor: pointer; transition: r .15s; }
.chart-dot:hover { r: 6; }
.chart-label { font-size: 10px; fill: var(--books-muted); font-family: var(--font-display); }

.aging-bars  { display: flex; flex-direction: column; gap: 12px; }
.aging-row   { display: grid; grid-template-columns: 80px 1fr 80px; align-items: center; gap: 10px; }
.aging-label { font-size: 11.5px; color: var(--books-muted); }
.aging-bar-wrap { background: var(--books-surface-2); border-radius: 20px; height: 6px; overflow: hidden; }
.aging-bar   { height: 100%; border-radius: 20px; transition: width .6s ease; }
.aging-amount{ font-size: 12px; font-family: var(--font-display); text-align: right; }

/* Bottom grid */
.bot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 1000px) { .bot-grid { grid-template-columns: 1fr; } }

/* Table helpers */
.ta-r    { text-align: right; }
.mono    { font-family: var(--font-display); font-size: 12.5px; }
.green   { color: var(--books-green); }
.red     { color: var(--books-red); }
.cust-name { font-weight: 600; font-size: 13px; }
.cust-sub  { font-size: 11px; color: var(--books-muted); }
.text-muted{ color: var(--books-muted); font-size: 12.5px; }
.link-accent { color: var(--books-accent); text-decoration: none; font-weight: 600; }
.link-accent:hover { text-decoration: underline; }
.chart-placeholder{ padding: 10px 0; }
</style>
