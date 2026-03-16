<template>
  <div class="page-accounts">
    <div class="page-actions">
      <div class="filter-group">
        <button
          v-for="t in accountTypes"
          :key="t"
          class="filter-pill"
          :class="{ active: activeType === t }"
          @click="activeType = t"
        >{{ t }}</button>
      </div>
      <button class="books-btn books-btn-primary" @click="newAccount">+ New Account</button>
    </div>

    <div class="books-card">
      <table class="books-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Type</th>
            <th>Parent</th>
            <th>Currency</th>
            <th class="ta-r">Balance</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading">
            <tr v-for="n in 8" :key="n">
              <td colspan="5"><div class="loading-shimmer" style="height:12px"></div></td>
            </tr>
          </template>
          <template v-else>
            <tr v-for="acct in filtered" :key="acct.name" @click="openAccount(acct.name)" class="clickable-row">
              <td>
                <div class="acct-name">{{ acct.account_name }}</div>
                <div class="acct-code">{{ acct.name }}</div>
              </td>
              <td><span class="badge" :class="typeBadge(acct.account_type)">{{ acct.account_type }}</span></td>
              <td class="text-muted">{{ acct.parent_account || "—" }}</td>
              <td class="text-muted">{{ acct.account_currency || "INR" }}</td>
              <td class="ta-r mono-sm">{{ fmt(acct.balance) }}</td>
            </tr>
            <tr v-if="!filtered.length">
              <td colspan="5" class="empty-row">No accounts found</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useFrappeList, formatCurrency } from "../composables/useFrappe.js";

const fmt = formatCurrency;
const { list: accounts, loading, fetch } = useFrappeList("Account", {
  fields: ["name","account_name","account_type","parent_account","account_currency","balance"],
  limit: 100,
  order_by: "account_type asc, account_name asc",
});

const activeType = ref("All");
const accountTypes = computed(() => {
  const types = [...new Set(accounts.value.map(a => a.account_type).filter(Boolean))];
  return ["All", ...types.sort()];
});

const filtered = computed(() =>
  activeType.value === "All" ? accounts.value
    : accounts.value.filter(a => a.account_type === activeType.value)
);

const typeColors = {
  Asset: "badge-blue", Liability: "badge-red", Equity: "badge-amber",
  Income: "badge-green", Expense: "badge-red", Bank: "badge-blue",
};
function typeBadge(t) { return typeColors[t] || "badge-muted"; }
function newAccount()  { frappe.new_doc("Account"); }
function openAccount(name) { frappe.set_route("Form", "Account", name); }

onMounted(fetch);
</script>

<style scoped>
.page-accounts { display: flex; flex-direction: column; gap: 16px; }
.page-actions  { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.filter-group  { display: flex; gap: 6px; flex-wrap: wrap; }
.filter-pill {
  padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 600;
  border: 1px solid var(--books-border); background: var(--books-surface);
  color: var(--books-muted); cursor: pointer; transition: all .15s; font-family: var(--font-body);
}
.filter-pill.active { background: var(--books-accent-soft); border-color: var(--books-accent); color: var(--books-accent); }
.acct-name  { font-weight: 600; font-size: 13px; }
.acct-code  { font-family: var(--font-display); font-size: 11px; color: var(--books-muted); }
.text-muted { color: var(--books-muted); font-size: 12.5px; }
.mono-sm    { font-family: var(--font-display); font-size: 12.5px; }
.ta-r       { text-align: right; }
.clickable-row { cursor: pointer; }
.clickable-row:hover td { background: var(--books-surface-2); }
.empty-row { text-align: center; color: var(--books-muted); padding: 32px !important; }
</style>
