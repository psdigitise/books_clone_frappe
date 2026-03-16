<template>
  <div class="page-invoices">
    <div class="page-actions">
      <div class="filter-group">
        <button
          v-for="f in filters"
          :key="f.key"
          class="filter-pill"
          :class="{ active: activeFilter === f.key }"
          @click="setFilter(f.key)"
        >{{ f.label }}
          <span v-if="f.key !== 'all'" class="pill-count badge"
            :class="badgeClass(f.key)">{{ counts[f.key] }}</span>
        </button>
      </div>
      <div class="actions-right">
        <button class="books-btn books-btn-ghost" @click="refresh">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Refresh
        </button>
        <button class="books-btn books-btn-primary" @click="newInvoice">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Invoice
        </button>
      </div>
    </div>

    <div class="books-card">
      <table class="books-table">
        <thead>
          <tr>
            <th>Invoice #</th>
            <th>Customer</th>
            <th>Date</th>
            <th>Due Date</th>
            <th class="ta-r">Amount</th>
            <th class="ta-r">Outstanding</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading">
            <tr v-for="n in 8" :key="n">
              <td colspan="7"><div class="loading-shimmer" style="height:13px"></div></td>
            </tr>
          </template>
          <template v-else>
            <tr v-for="inv in filtered" :key="inv.name" @click="openInvoice(inv.name)" class="clickable-row">
              <td><span class="inv-num">{{ inv.name }}</span></td>
              <td>
                <div class="cust-name">{{ inv.customer_name || inv.customer }}</div>
              </td>
              <td class="text-muted mono-sm">{{ fmtDate(inv.posting_date) }}</td>
              <td class="mono-sm" :class="isOverdue(inv) ? 'red' : 'text-muted'">{{ fmtDate(inv.due_date) }}</td>
              <td class="ta-r mono-sm">{{ fmt(inv.grand_total) }}</td>
              <td class="ta-r mono-sm" :class="inv.outstanding_amount > 0 ? 'amber' : 'green'">
                {{ fmt(inv.outstanding_amount) }}
              </td>
              <td><span class="badge" :class="statusBadge(inv.status)">{{ inv.status }}</span></td>
            </tr>
            <tr v-if="!filtered.length">
              <td colspan="7" class="empty-row">No invoices found</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useFrappeList, formatCurrency, formatDate } from "../composables/useFrappe.js";
const fmt     = formatCurrency;
const fmtDate = formatDate;

const { list: invoices, loading, fetch } = useFrappeList("Sales Invoice", {
  fields: ["name","customer","customer_name","posting_date","due_date","grand_total","outstanding_amount","status","currency"],
  limit: 50,
  order_by: "posting_date desc",
});

const activeFilter = ref("all");

const filters = [
  { key: "all",      label: "All"      },
  { key: "Draft",    label: "Draft"    },
  { key: "Submitted",label: "Unpaid"   },
  { key: "Overdue",  label: "Overdue"  },
  { key: "Paid",     label: "Paid"     },
];

const counts = computed(() => ({
  Draft:     invoices.value.filter(i => i.status === "Draft").length,
  Submitted: invoices.value.filter(i => i.status === "Unpaid" || i.status === "Submitted").length,
  Overdue:   invoices.value.filter(i => isOverdue(i)).length,
  Paid:      invoices.value.filter(i => i.status === "Paid").length,
}));

const filtered = computed(() => {
  if (activeFilter.value === "all")    return invoices.value;
  if (activeFilter.value === "Overdue") return invoices.value.filter(isOverdue);
  return invoices.value.filter(i => i.status === activeFilter.value);
});

function isOverdue(inv) {
  return inv.outstanding_amount > 0 && inv.due_date && new Date(inv.due_date) < new Date();
}

function statusBadge(status) {
  const m = { Paid: "badge-green", Unpaid: "badge-amber", Submitted: "badge-amber",
               Draft: "badge-muted", Cancelled: "badge-red", Overdue: "badge-red" };
  return m[status] || "badge-muted";
}

function badgeClass(key) {
  return { Draft:"badge-muted", Submitted:"badge-amber", Overdue:"badge-red", Paid:"badge-green" }[key] || "badge-muted";
}

function setFilter(k) { activeFilter.value = k; }
function refresh()     { fetch(); }
function newInvoice()  { frappe.new_doc("Sales Invoice"); }
function openInvoice(name) { frappe.set_route("Form", "Sales Invoice", name); }

onMounted(fetch);
</script>

<style scoped>
.page-invoices { display: flex; flex-direction: column; gap: 16px; }
.page-actions  { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.filter-group  { display: flex; gap: 6px; flex-wrap: wrap; }
.actions-right { display: flex; gap: 8px; }
.filter-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: 20px; font-size: 12.5px; font-weight: 600;
  border: 1px solid var(--books-border); background: var(--books-surface);
  color: var(--books-muted); cursor: pointer; transition: all .15s;
  font-family: var(--font-body);
}
.filter-pill:hover { border-color: var(--books-accent); color: var(--books-text); }
.filter-pill.active { background: var(--books-accent-soft); border-color: var(--books-accent); color: var(--books-accent); }
.pill-count { font-size: 10px; padding: 2px 6px; }

.inv-num  { font-family: var(--font-display); font-size: 12.5px; color: var(--books-accent); font-weight: 600; }
.cust-name{ font-weight: 600; font-size: 13px; }
.text-muted{ color: var(--books-muted); }
.mono-sm  { font-family: var(--font-display); font-size: 12.5px; }
.green    { color: var(--books-green);  }
.red      { color: var(--books-red);    }
.amber    { color: var(--books-amber);  }
.ta-r     { text-align: right; }
.clickable-row { cursor: pointer; }
.clickable-row:hover td { background: var(--books-surface-2); }
.empty-row { text-align: center; color: var(--books-muted); padding: 32px !important; }
</style>
