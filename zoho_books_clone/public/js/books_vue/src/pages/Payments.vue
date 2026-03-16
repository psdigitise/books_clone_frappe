<template>
  <div class="page-payments">
    <div class="page-actions">
      <div class="filter-group">
        <button
          v-for="t in types"
          :key="t.key"
          class="filter-pill"
          :class="{ active: activeType === t.key }"
          @click="activeType = t.key"
        >{{ t.label }}</button>
      </div>
      <button class="books-btn books-btn-primary" @click="newPayment">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Payment
      </button>
    </div>

    <div class="books-card">
      <table class="books-table">
        <thead>
          <tr>
            <th>Payment #</th>
            <th>Party</th>
            <th>Mode</th>
            <th>Date</th>
            <th>Type</th>
            <th class="ta-r">Amount</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading">
            <tr v-for="n in 8" :key="n">
              <td colspan="6"><div class="loading-shimmer" style="height:13px"></div></td>
            </tr>
          </template>
          <template v-else>
            <tr v-for="p in filtered" :key="p.name" @click="openPayment(p.name)" class="clickable-row">
              <td><span class="pay-num">{{ p.name }}</span></td>
              <td>{{ p.party }}</td>
              <td class="text-muted">{{ p.mode_of_payment || "—" }}</td>
              <td class="text-muted mono-sm">{{ fmtDate(p.payment_date) }}</td>
              <td>
                <span class="badge" :class="p.payment_type === 'Receive' ? 'badge-green' : 'badge-red'">
                  {{ p.payment_type }}
                </span>
              </td>
              <td class="ta-r mono-sm" :class="p.payment_type === 'Receive' ? 'green' : 'red'">
                {{ fmt(p.paid_amount) }}
              </td>
            </tr>
            <tr v-if="!filtered.length">
              <td colspan="6" class="empty-row">No payments found</td>
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

const { list: payments, loading, fetch } = useFrappeList("Payment Entry", {
  fields: ["name","party","party_type","paid_amount","payment_type","payment_date","mode_of_payment"],
  limit: 50,
  order_by: "payment_date desc",
});

const activeType = ref("all");
const types = [
  { key: "all",     label: "All"      },
  { key: "Receive", label: "Received" },
  { key: "Pay",     label: "Paid Out" },
];

const filtered = computed(() => {
  if (activeType.value === "all") return payments.value;
  return payments.value.filter(p => p.payment_type === activeType.value);
});

function newPayment()  { frappe.new_doc("Payment Entry"); }
function openPayment(name) { frappe.set_route("Form", "Payment Entry", name); }
onMounted(fetch);
</script>

<style scoped>
.page-payments { display: flex; flex-direction: column; gap: 16px; }
.page-actions  { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.filter-group  { display: flex; gap: 6px; }
.filter-pill {
  padding: 6px 14px; border-radius: 20px; font-size: 12.5px; font-weight: 600;
  border: 1px solid var(--books-border); background: var(--books-surface);
  color: var(--books-muted); cursor: pointer; transition: all .15s; font-family: var(--font-body);
}
.filter-pill.active { background: var(--books-accent-soft); border-color: var(--books-accent); color: var(--books-accent); }
.pay-num   { font-family: var(--font-display); font-size: 12.5px; color: var(--books-accent); font-weight: 600; }
.mono-sm   { font-family: var(--font-display); font-size: 12.5px; }
.text-muted{ color: var(--books-muted); }
.green { color: var(--books-green); }
.red   { color: var(--books-red);   }
.ta-r  { text-align: right; }
.clickable-row { cursor: pointer; }
.clickable-row:hover td { background: var(--books-surface-2); }
.empty-row { text-align: center; color: var(--books-muted); padding: 32px !important; }
</style>
