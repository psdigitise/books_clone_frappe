<template>
  <div class="page-banking">

    <!-- Cash position strip -->
    <div class="books-card cash-strip">
      <div class="cash-label">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 22h18M6 18v-7m4 7v-7m4 7v-7m4 7v-7M3 7l9-5 9 5H3z"/></svg>
        Total Cash Position
      </div>
      <div class="cash-total">
        <template v-if="cashLoading"><div class="loading-shimmer" style="width:120px;height:24px"></div></template>
        <template v-else>{{ fmt(cashData?.total_cash) }}</template>
      </div>
    </div>

    <!-- Bank accounts grid -->
    <div class="bank-accounts-grid">
      <template v-if="cashLoading">
        <div v-for="n in 3" :key="n" class="books-card bank-account-card">
          <div class="loading-shimmer" style="height:80px;border-radius:8px"></div>
        </div>
      </template>
      <template v-else>
        <div
          v-for="acct in (cashData?.bank_accounts || [])"
          :key="acct.name"
          class="books-card bank-account-card"
          :class="{ selected: selectedAccount === acct.name }"
          @click="selectAccount(acct)"
        >
          <div class="acct-top">
            <div class="acct-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
            </div>
            <span class="acct-currency">{{ acct.currency || "INR" }}</span>
          </div>
          <div class="acct-name">{{ acct.account_name }}</div>
          <div class="acct-bank">{{ acct.bank_name || "—" }}</div>
          <div class="acct-balance">{{ fmt(acct.current_balance) }}</div>
        </div>
        <div v-if="!cashData?.bank_accounts?.length" class="books-card bank-account-card empty-acct">
          No bank accounts configured
        </div>
      </template>
    </div>

    <!-- Transactions -->
    <div class="books-card" v-if="selectedAccount">
      <div class="card-header">
        <span class="books-card-title">Transactions — {{ selectedAccount }}</span>
        <span class="badge badge-amber">{{ transactions.length }} unreconciled</span>
      </div>
      <table class="books-table">
        <thead>
          <tr>
            <th>Ref #</th>
            <th>Date</th>
            <th>Description</th>
            <th class="ta-r">Debit</th>
            <th class="ta-r">Credit</th>
            <th class="ta-r">Balance</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="txnLoading">
            <tr v-for="n in 6" :key="n">
              <td colspan="7"><div class="loading-shimmer" style="height:12px"></div></td>
            </tr>
          </template>
          <template v-else>
            <tr v-for="t in transactions" :key="t.name">
              <td><span class="pay-num">{{ t.reference_number || t.name }}</span></td>
              <td class="text-muted mono-sm">{{ fmtDate(t.date) }}</td>
              <td class="desc-cell">{{ t.description || "—" }}</td>
              <td class="ta-r mono-sm red">{{ t.debit  > 0 ? fmt(t.debit)  : "—" }}</td>
              <td class="ta-r mono-sm green">{{ t.credit > 0 ? fmt(t.credit) : "—" }}</td>
              <td class="ta-r mono-sm">{{ fmt(t.balance) }}</td>
              <td><span class="badge badge-amber">{{ t.status }}</span></td>
            </tr>
            <tr v-if="!transactions.length">
              <td colspan="7" class="empty-row">✓ All transactions reconciled</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useFrappeCall, formatCurrency, formatDate } from "../composables/useFrappe.js";

const fmt     = formatCurrency;
const fmtDate = formatDate;

const { data: cashData, loading: cashLoading, execute: loadCash } = useFrappeCall("zoho_books_clone.api.dashboard.get_cash_position");

const transactions  = ref([]);
const txnLoading    = ref(false);
const selectedAccount = ref(null);

async function selectAccount(acct) {
  selectedAccount.value = acct.name;
  txnLoading.value = true;
  try {
    const res = await frappe.call({
      method: "frappe.client.get_list",
      args: {
        doctype: "Bank Transaction",
        filters: [["bank_account","=",acct.name],["status","=","Unreconciled"],["docstatus","=",1]],
        fields: ["name","date","description","debit","credit","balance","reference_number","status"],
        order_by: "date asc",
        limit_page_length: 30,
      },
    });
    transactions.value = res.message || [];
  } finally {
    txnLoading.value = false;
  }
}

onMounted(loadCash);
</script>

<style scoped>
.page-banking { display: flex; flex-direction: column; gap: 16px; }
.cash-strip {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 20px;
}
.cash-label {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-family: var(--font-display); letter-spacing: .08em;
  text-transform: uppercase; color: var(--books-muted);
}
.cash-total {
  font-family: var(--font-display); font-size: 22px; font-weight: 700;
  color: var(--books-green);
}
.bank-accounts-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px;
}
.bank-account-card {
  cursor: pointer; transition: all .18s;
  border-color: var(--books-border);
}
.bank-account-card:hover { border-color: var(--books-accent); transform: translateY(-2px); }
.bank-account-card.selected { border-color: var(--books-accent); background: var(--books-accent-soft); }
.acct-top  { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.acct-icon {
  width: 34px; height: 34px; border-radius: var(--radius-sm);
  background: var(--books-surface-2); display: flex; align-items: center; justify-content: center;
  color: var(--books-accent);
}
.acct-currency { font-family: var(--font-display); font-size: 11px; color: var(--books-muted); }
.acct-name  { font-weight: 700; font-size: 13.5px; margin-bottom: 2px; }
.acct-bank  { font-size: 12px; color: var(--books-muted); margin-bottom: 10px; }
.acct-balance { font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--books-green); }
.empty-acct { color: var(--books-muted); font-size: 13px; text-align: center; padding: 32px; }
.card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.pay-num { font-family: var(--font-display); font-size: 12px; color: var(--books-accent); font-weight: 600; }
.desc-cell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--books-muted); }
.mono-sm { font-family: var(--font-display); font-size: 12.5px; }
.ta-r { text-align: right; }
.green { color: var(--books-green); }
.red   { color: var(--books-red);   }
.text-muted { color: var(--books-muted); }
.empty-row { text-align: center; color: var(--books-green); padding: 32px !important; }
</style>
