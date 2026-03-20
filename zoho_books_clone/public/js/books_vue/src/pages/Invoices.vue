<template>
  <div class="inv-page">

    <!-- ── Top toolbar ── -->
    <div class="inv-toolbar">
      <div class="inv-toolbar-left">
        <h2 class="inv-heading">All Invoices</h2>
        <svg class="inv-heading-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="inv-toolbar-right">
        <button class="inv-btn-primary" @click="newInvoice">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New
        </button>
        <button class="inv-btn-icon" title="More options">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
      </div>
    </div>

    <!-- ── Filter pills ── -->
    <div class="inv-filters">
      <button
        v-for="f in filters" :key="f.key"
        class="inv-pill"
        :class="{ active: activeFilter === f.key }"
        @click="activeFilter = f.key"
      >
        {{ f.label }}
        <span v-if="f.key !== 'all'" class="inv-pill-count" :class="pillCountClass(f.key)">
          {{ counts[f.key] }}
        </span>
      </button>
    </div>

    <!-- ── Table ── -->
    <div class="inv-table-wrap">
      <table class="inv-table">
        <thead>
          <tr>
            <th class="th-check"><input type="checkbox" @change="toggleAll" :checked="allSelected" /></th>
            <th class="sortable" @click="sort('posting_date')">
              DATE <span class="sort-arrow">{{ sortArrow('posting_date') }}</span>
            </th>
            <th class="sortable" @click="sort('name')">
              INVOICE# <span class="sort-arrow">{{ sortArrow('name') }}</span>
            </th>
            <th>ORDER NUMBER</th>
            <th class="sortable" @click="sort('customer_name')">
              CUSTOMER NAME <span class="sort-arrow">{{ sortArrow('customer_name') }}</span>
            </th>
            <th class="sortable" @click="sort('status')">
              STATUS <span class="sort-arrow">{{ sortArrow('status') }}</span>
            </th>
            <th class="sortable" @click="sort('due_date')">
              DUE DATE <span class="sort-arrow">{{ sortArrow('due_date') }}</span>
            </th>
            <th class="ta-r sortable" @click="sort('grand_total')">
              AMOUNT <span class="sort-arrow">{{ sortArrow('grand_total') }}</span>
            </th>
            <th class="ta-r sortable" @click="sort('outstanding_amount')">
              BALANCE DUE <span class="sort-arrow">{{ sortArrow('outstanding_amount') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <!-- shimmer rows while loading -->
          <template v-if="loading">
            <tr v-for="n in 6" :key="n" class="shimmer-row">
              <td><div class="shimmer" style="width:14px;height:14px;border-radius:3px"></div></td>
              <td><div class="shimmer" style="width:80px"></div></td>
              <td><div class="shimmer" style="width:100px"></div></td>
              <td><div class="shimmer" style="width:60px"></div></td>
              <td><div class="shimmer" style="width:120px"></div></td>
              <td><div class="shimmer" style="width:90px"></div></td>
              <td><div class="shimmer" style="width:80px"></div></td>
              <td><div class="shimmer" style="width:80px;margin-left:auto"></div></td>
              <td><div class="shimmer" style="width:80px;margin-left:auto"></div></td>
            </tr>
          </template>
          <template v-else>
            <tr
              v-for="inv in sorted"
              :key="inv.name"
              class="inv-row"
              :class="{ selected: selected.has(inv.name) }"
              @click.self="openInvoice(inv.name)"
            >
              <td class="td-check" @click.stop>
                <input type="checkbox" :checked="selected.has(inv.name)"
                  @change="toggleRow(inv.name)" />
              </td>
              <td @click="openInvoice(inv.name)">{{ fmtDate(inv.posting_date) }}</td>
              <td @click="openInvoice(inv.name)">
                <span class="inv-link">{{ inv.name }}</span>
                <span v-if="inv.email_sent" class="inv-email-icon" title="Email sent">✉</span>
              </td>
              <td @click="openInvoice(inv.name)" class="text-muted">{{ inv.po_no || '—' }}</td>
              <td @click="openInvoice(inv.name)"><span class="inv-customer">{{ inv.customer_name || inv.customer }}</span></td>
              <td @click="openInvoice(inv.name)">
                <span class="inv-status-badge" :class="statusClass(inv)">{{ statusLabel(inv) }}</span>
              </td>
              <td @click="openInvoice(inv.name)" :class="isOverdue(inv) ? 'text-danger' : 'text-muted'">
                {{ fmtDate(inv.due_date) }}
              </td>
              <td class="ta-r" @click="openInvoice(inv.name)">{{ fmt(inv.grand_total) }}</td>
              <td class="ta-r" @click="openInvoice(inv.name)">
                <span :class="inv.outstanding_amount > 0 ? 'text-danger' : 'text-success'">
                  {{ fmt(inv.outstanding_amount) }}
                </span>
              </td>
            </tr>
            <tr v-if="!sorted.length">
              <td colspan="9" class="empty-state">
                <div class="empty-inner">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <p>No invoices found</p>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- ── Record Payment Modal ── -->
    <Teleport to="body">
      <div v-if="paymentModal.open" class="rp-backdrop" @click.self="closePayment">
        <div class="rp-dialog">

          <div class="rp-dialog-header">
            <span class="rp-dialog-title">Payment for {{ paymentModal.invoiceName }}</span>
            <button class="rp-close-btn" @click="closePayment">✕</button>
          </div>

          <!-- loading state -->
          <div v-if="paymentModal.loading" class="rp-loading">
            <div class="rp-spinner"></div> Loading payment details…
          </div>

          <template v-else-if="paymentModal.defaults">
            <!-- customer strip -->
            <div class="rp-customer-strip">
              <div class="rp-avatar">{{ paymentModal.defaults.customer_name?.charAt(0)?.toUpperCase() }}</div>
              <div>
                <div class="rp-cust-name">{{ paymentModal.defaults.customer_name }}</div>
                <div class="rp-cust-bal">
                  Balance Due: <strong class="text-danger">{{ fmtAmt(paymentModal.defaults.balance_due) }}</strong>
                </div>
              </div>
            </div>

            <div class="rp-body">
              <!-- Row 1 -->
              <div class="rp-row">
                <div class="rp-field">
                  <label class="rp-label rp-req">Customer Name</label>
                  <input class="rp-input" :value="paymentModal.defaults.customer_name" readonly />
                </div>
                <div class="rp-field">
                  <label class="rp-label rp-req">Payment #</label>
                  <input class="rp-input" v-model="paymentForm.paymentNum" />
                </div>
              </div>

              <!-- Row 2 -->
              <div class="rp-row">
                <div class="rp-field">
                  <label class="rp-label rp-req">Amount Received ({{ paymentModal.defaults.currency }})</label>
                  <input class="rp-input rp-amount-input" v-model.number="paymentForm.amount" type="number" min="0" step="0.01" />
                </div>
                <div class="rp-field">
                  <label class="rp-label">Bank Charges (if any)</label>
                  <input class="rp-input" v-model.number="paymentForm.bankCharges" type="number" min="0" step="0.01" />
                </div>
              </div>

              <!-- TDS row -->
              <div class="rp-row">
                <div class="rp-field">
                  <label class="rp-label">Tax Deducted?</label>
                  <div class="rp-radio-group">
                    <label class="rp-radio"><input type="radio" v-model="paymentForm.tds" value="no" /> No Tax Deducted</label>
                    <label class="rp-radio"><input type="radio" v-model="paymentForm.tds" value="yes" /> Yes, TDS (Income Tax)</label>
                  </div>
                </div>
                <div class="rp-field" v-show="paymentForm.tds === 'yes'">
                  <label class="rp-label">TDS Amount</label>
                  <input class="rp-input" v-model.number="paymentForm.tdsAmount" type="number" min="0" step="0.01" />
                </div>
              </div>

              <!-- Row 3 -->
              <div class="rp-row">
                <div class="rp-field">
                  <label class="rp-label rp-req">Payment Date</label>
                  <input class="rp-input" v-model="paymentForm.paymentDate" type="date" />
                </div>
                <div class="rp-field">
                  <label class="rp-label">Payment Mode</label>
                  <select class="rp-input rp-select" v-model="paymentForm.paymentMode">
                    <option v-for="m in paymentModal.defaults.payment_modes" :key="m" :value="m">{{ m }}</option>
                  </select>
                </div>
              </div>

              <!-- Row 4 -->
              <div class="rp-row">
                <div class="rp-field">
                  <label class="rp-label">Reference #</label>
                  <input class="rp-input" v-model="paymentForm.reference" placeholder="Cheque / UTR / Txn ID" />
                </div>
                <div class="rp-field">
                  <label class="rp-label rp-req">Deposit To</label>
                  <select class="rp-input rp-select" v-model="paymentForm.depositTo">
                    <option v-for="a in paymentModal.defaults.bank_accounts" :key="a.name" :value="a.name">
                      {{ a.name }} ({{ a.account_type }})
                    </option>
                  </select>
                </div>
              </div>

              <!-- Notes -->
              <div class="rp-field rp-field-full">
                <label class="rp-label">Notes</label>
                <textarea class="rp-input rp-textarea" v-model="paymentForm.notes" rows="2" placeholder="Optional notes…"></textarea>
              </div>

              <!-- Summary -->
              <div class="rp-summary">
                <span>Invoice Total: <strong>{{ fmtAmt(paymentModal.defaults.grand_total) }}</strong></span>
                <span>Entering: <strong>{{ fmtAmt(paymentForm.amount || 0) }}</strong></span>
                <span>Balance After:
                  <strong>{{ fmtAmt(Math.max(0, paymentModal.defaults.grand_total - (paymentModal.defaults.grand_total - paymentModal.defaults.balance_due) - (paymentForm.amount || 0))) }}</strong>
                </span>
              </div>
            </div>

            <!-- Footer -->
            <div class="rp-footer">
              <button class="rp-btn rp-btn-outline" @click="closePayment">Cancel</button>
              <div class="rp-footer-right">
                <button class="rp-btn rp-btn-secondary" :disabled="paymentModal.saving" @click="submitPayment(true)">
                  {{ paymentModal.saving ? 'Saving…' : 'Save as Draft' }}
                </button>
                <button class="rp-btn rp-btn-primary" :disabled="paymentModal.saving" @click="submitPayment(false)">
                  {{ paymentModal.saving ? 'Saving…' : 'Save as Paid' }}
                </button>
              </div>
            </div>
          </template>

        </div>
      </div>
    </Teleport>

    <!-- ── Toast ── -->
    <Teleport to="body">
      <transition name="toast">
        <div v-if="toast.show" class="inv-toast" :class="toast.type">{{ toast.message }}</div>
      </Transition>
    </Teleport>

  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted } from "vue";
import { useFrappeList, formatCurrency, formatDate } from "../composables/useFrappe.js";

const fmt     = formatCurrency;
const fmtDate = formatDate;
function fmtAmt(v) { return "₹" + Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/* ── Invoice list ── */
const { list: invoices, loading, fetch } = useFrappeList("Sales Invoice", {
  fields: ["name","customer","customer_name","posting_date","due_date","grand_total",
           "outstanding_amount","status","currency","po_no","docstatus"],
  limit: 100,
  order_by: "posting_date desc",
});

/* ── Filters ── */
const activeFilter = ref("all");
const filters = [
  { key: "all",     label: "All Invoices" },
  { key: "Draft",   label: "Draft"   },
  { key: "Unpaid",  label: "Unpaid"  },
  { key: "Overdue", label: "Overdue" },
  { key: "Paid",    label: "Paid"    },
];

function isOverdue(inv) {
  return inv.outstanding_amount > 0 && inv.due_date && new Date(inv.due_date) < new Date();
}
function statusLabel(inv) {
  if (isOverdue(inv)) {
    const days = Math.floor((new Date() - new Date(inv.due_date)) / 86400000);
    return `OVERDUE BY ${days} DAY${days !== 1 ? "S" : ""}`;
  }
  return (inv.status || "DRAFT").toUpperCase();
}
function statusClass(inv) {
  if (isOverdue(inv))               return "status-overdue";
  const s = inv.status?.toLowerCase();
  if (s === "paid")                 return "status-paid";
  if (s === "submitted" || s === "unpaid") return "status-unpaid";
  if (s === "cancelled")            return "status-cancelled";
  return "status-draft";
}

const counts = computed(() => ({
  Draft:   invoices.value.filter(i => i.status === "Draft").length,
  Unpaid:  invoices.value.filter(i => !isOverdue(i) && (i.status === "Submitted" || i.status === "Unpaid")).length,
  Overdue: invoices.value.filter(isOverdue).length,
  Paid:    invoices.value.filter(i => i.status === "Paid").length,
}));
function pillCountClass(key) {
  return { Draft:"pc-muted", Unpaid:"pc-amber", Overdue:"pc-red", Paid:"pc-green" }[key] || "pc-muted";
}

const filtered = computed(() => {
  if (activeFilter.value === "all")    return invoices.value;
  if (activeFilter.value === "Overdue") return invoices.value.filter(isOverdue);
  if (activeFilter.value === "Unpaid")  return invoices.value.filter(i => !isOverdue(i) && (i.status === "Submitted" || i.status === "Unpaid"));
  return invoices.value.filter(i => i.status === activeFilter.value);
});

/* ── Sorting ── */
const sortKey = ref("posting_date");
const sortDir = ref(-1);
function sort(key) {
  if (sortKey.value === key) sortDir.value *= -1;
  else { sortKey.value = key; sortDir.value = -1; }
}
function sortArrow(key) {
  if (sortKey.value !== key) return "";
  return sortDir.value === 1 ? "↑" : "↓";
}
const sorted = computed(() => {
  return [...filtered.value].sort((a, b) => {
    const va = a[sortKey.value] ?? "";
    const vb = b[sortKey.value] ?? "";
    if (va < vb) return -1 * sortDir.value;
    if (va > vb) return  1 * sortDir.value;
    return 0;
  });
});

/* ── Row selection ── */
const selected = ref(new Set());
const allSelected = computed(() => sorted.value.length && sorted.value.every(i => selected.value.has(i.name)));
function toggleAll(e) {
  if (e.target.checked) sorted.value.forEach(i => selected.value.add(i.name));
  else selected.value.clear();
  selected.value = new Set(selected.value);
}
function toggleRow(name) {
  const s = new Set(selected.value);
  s.has(name) ? s.delete(name) : s.add(name);
  selected.value = s;
}

/* ── Navigation ── */
function newInvoice()       { frappe.new_doc("Sales Invoice"); }
function openInvoice(name)  { frappe.set_route("Form", "Sales Invoice", name); }

/* ── Toast ── */
const toast = reactive({ show: false, message: "", type: "success" });
function showToast(msg, type = "success") {
  toast.message = msg; toast.type = type; toast.show = true;
  setTimeout(() => { toast.show = false; }, 3500);
}

/* ── Record Payment modal ── */
const paymentModal = reactive({
  open: false, loading: false, saving: false,
  invoiceName: "", defaults: null,
});
const paymentForm = reactive({
  amount: 0, bankCharges: 0, tds: "no", tdsAmount: 0,
  paymentDate: new Date().toISOString().split("T")[0],
  paymentMode: "Cash", depositTo: "", reference: "", notes: "",
  paymentNum: "1",
});

async function openPaymentModal(invoiceName) {
  paymentModal.open = true;
  paymentModal.loading = true;
  paymentModal.invoiceName = invoiceName;
  paymentModal.defaults = null;
  paymentModal.saving = false;

  try {
    const res = await frappe.call({
      method: "zoho_books_clone.api.books_data.get_payment_defaults",
      args: { invoice_name: invoiceName },
    });
    const d = res.message;
    paymentModal.defaults = d;
    paymentForm.amount      = d.balance_due;
    paymentForm.paymentDate = d.payment_date || new Date().toISOString().split("T")[0];
    paymentForm.paymentMode = d.payment_modes?.[0] || "Cash";
    paymentForm.depositTo   = d.bank_accounts?.[0]?.name || "";
    paymentForm.paymentNum  = d.payment_number || "1";
    paymentForm.bankCharges = 0;
    paymentForm.tds         = "no";
    paymentForm.reference   = "";
    paymentForm.notes       = "";
  } catch (e) {
    showToast("Failed to load payment details: " + (e.message || e), "error");
    paymentModal.open = false;
  } finally {
    paymentModal.loading = false;
  }
}

function closePayment() { paymentModal.open = false; }

async function submitPayment(saveAsDraft) {
  if (!paymentForm.amount || paymentForm.amount <= 0) {
    showToast("Please enter a valid amount.", "error"); return;
  }
  paymentModal.saving = true;
  try {
    const res = await frappe.call({
      method: "zoho_books_clone.api.books_data.record_payment",
      args: {
        invoice_name:    paymentModal.invoiceName,
        amount_received: paymentForm.amount,
        payment_date:    paymentForm.paymentDate,
        payment_mode:    paymentForm.paymentMode,
        deposit_to:      paymentForm.depositTo,
        bank_charges:    paymentForm.bankCharges || 0,
        reference_no:    paymentForm.reference,
        notes:           paymentForm.notes,
        tds_deducted:    paymentForm.tds === "yes" ? 1 : 0,
        tds_amount:      paymentForm.tdsAmount || 0,
        save_as_draft:   saveAsDraft ? 1 : 0,
      },
    });
    const msg = res.message;
    showToast(
      `✓ Payment ${msg.payment_entry} ${msg.status === "draft" ? "saved as draft" : "recorded successfully"}!`,
      "success"
    );
    closePayment();
    fetch(); // refresh list
  } catch (e) {
    showToast("Error: " + (e.message || JSON.stringify(e)), "error");
  } finally {
    paymentModal.saving = false;
  }
}

// Expose openPaymentModal globally so external buttons can call it
if (typeof window !== "undefined") {
  window.openRecordPaymentDialog = openPaymentModal;
}

onMounted(fetch);
</script>

<style scoped>
/* ─────────────────────────────────────────────
   Invoice List — Zoho Books exact style
───────────────────────────────────────────── */

.inv-page {
  background: #fff;
  min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: #1a1a2e;
}

/* ── Toolbar ── */
.inv-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px 12px;
  border-bottom: 1px solid #e8ecf0;
}
.inv-toolbar-left { display: flex; align-items: center; gap: 6px; }
.inv-heading {
  font-size: 16px;
  font-weight: 700;
  color: #1a1a2e;
  margin: 0;
}
.inv-heading-chevron { color: #6b7280; }
.inv-toolbar-right { display: flex; align-items: center; gap: 8px; }

.inv-btn-primary {
  display: inline-flex; align-items: center; gap: 6px;
  background: #1a6ef7; color: #fff;
  border: none; border-radius: 6px;
  padding: 7px 16px; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: background .15s;
}
.inv-btn-primary:hover { background: #155fd4; }

.inv-btn-icon {
  background: none; border: 1px solid #e8ecf0; border-radius: 6px;
  width: 32px; height: 32px; display: grid; place-items: center;
  cursor: pointer; color: #6b7280;
}
.inv-btn-icon:hover { background: #f5f6fa; }

/* ── Filter pills ── */
.inv-filters {
  display: flex;
  gap: 8px;
  padding: 12px 24px;
  border-bottom: 1px solid #e8ecf0;
  flex-wrap: wrap;
}
.inv-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 14px; border-radius: 20px; font-size: 12.5px; font-weight: 600;
  border: 1.5px solid #e8ecf0; background: #fff;
  color: #6b7280; cursor: pointer; transition: all .15s;
}
.inv-pill:hover { border-color: #1a6ef7; color: #1a6ef7; }
.inv-pill.active { background: #eaf1ff; border-color: #1a6ef7; color: #1a6ef7; }
.inv-pill-count {
  font-size: 10.5px; font-weight: 700;
  padding: 1px 6px; border-radius: 12px;
}
.pc-muted  { background: #e5e7eb; color: #6b7280; }
.pc-amber  { background: #fef3c7; color: #d97706; }
.pc-red    { background: #fee2e2; color: #dc2626; }
.pc-green  { background: #d1fae5; color: #059669; }

/* ── Table ── */
.inv-table-wrap { overflow-x: auto; }
.inv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.inv-table th {
  padding: 10px 16px;
  border-bottom: 2px solid #e8ecf0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .07em;
  color: #6b7280;
  text-align: left;
  white-space: nowrap;
  background: #fff;
  user-select: none;
}
.inv-table th.sortable { cursor: pointer; }
.inv-table th.sortable:hover { color: #1a6ef7; }
.sort-arrow { font-size: 10px; margin-left: 2px; color: #1a6ef7; }
.th-check { width: 40px; padding-left: 20px; }

.inv-table td {
  padding: 13px 16px;
  border-bottom: 1px solid #f0f2f5;
  color: #374151;
  vertical-align: middle;
  cursor: pointer;
}
.td-check { cursor: default; padding-left: 20px; }
.inv-row:hover td { background: #f8faff; }
.inv-row.selected td { background: #eaf1ff; }
.inv-table tr:last-child td { border-bottom: none; }

.inv-link {
  color: #1a6ef7; font-weight: 600; font-size: 13px;
}
.inv-email-icon { margin-left: 6px; font-size: 11px; color: #9ca3af; }
.inv-customer { font-weight: 600; color: #1a1a2e; }

/* ── Status badges ── */
.inv-status-badge {
  display: inline-flex; align-items: center;
  padding: 3px 10px; border-radius: 4px;
  font-size: 11px; font-weight: 700; letter-spacing: .04em;
  white-space: nowrap;
}
.status-overdue  { color: #dc2626; background: transparent; }
.status-paid     { color: #059669; background: #d1fae5; }
.status-unpaid   { color: #d97706; background: #fef3c7; }
.status-draft    { color: #6b7280; background: #f3f4f6; }
.status-cancelled{ color: #ef4444; background: #fee2e2; }

.text-danger  { color: #dc2626; }
.text-success { color: #059669; }
.text-muted   { color: #9ca3af; }
.ta-r         { text-align: right; }

/* ── Shimmer ── */
.shimmer {
  height: 12px; border-radius: 4px;
  background: linear-gradient(90deg, #f0f2f5 25%, #e4e7ec 50%, #f0f2f5 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}
@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

/* ── Empty state ── */
.empty-state { padding: 48px 0 !important; text-align: center; cursor: default !important; }
.empty-inner { display: flex; flex-direction: column; align-items: center; gap: 10px; color: #9ca3af; font-size: 13px; }

/* ══════════════════════════════════════════════
   Record Payment Dialog
══════════════════════════════════════════════ */
.rp-backdrop {
  position: fixed; inset: 0;
  background: rgba(15,23,42,.45);
  display: flex; align-items: center; justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(2px);
}
.rp-dialog {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 20px 60px rgba(0,0,0,.2);
  width: min(680px, 95vw);
  max-height: 90vh; overflow-y: auto;
  display: flex; flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  animation: rp-in .2s cubic-bezier(.34,1.56,.64,1);
}
@keyframes rp-in { from { opacity:0; transform: scale(.95) translateY(10px); } }

.rp-dialog-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 22px 14px;
  border-bottom: 1px solid #e8ecf0;
}
.rp-dialog-title { font-size: 15px; font-weight: 700; color: #1a1a2e; }
.rp-close-btn {
  background: none; border: none; font-size: 16px;
  color: #9ca3af; cursor: pointer; border-radius: 50%;
  width: 28px; height: 28px; display: grid; place-items: center;
}
.rp-close-btn:hover { background: #f3f4f6; color: #374151; }

.rp-loading {
  padding: 40px; display: flex; align-items: center; justify-content: center;
  gap: 12px; color: #6b7280; font-size: 14px;
}
.rp-spinner {
  width: 20px; height: 20px; border-radius: 50%;
  border: 2px solid #e8ecf0; border-top-color: #1a6ef7;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.rp-customer-strip {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 22px;
  background: #f8faff; border-bottom: 1px solid #e8ecf0;
}
.rp-avatar {
  width: 36px; height: 36px; border-radius: 50%;
  background: #1a6ef7; color: #fff;
  font-weight: 700; font-size: 15px;
  display: grid; place-items: center; flex-shrink: 0;
}
.rp-cust-name { font-weight: 600; font-size: 14px; color: #1a1a2e; }
.rp-cust-bal  { font-size: 12px; color: #6b7280; margin-top: 1px; }

.rp-body { padding: 18px 22px; display: flex; flex-direction: column; gap: 14px; }
.rp-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.rp-field { display: flex; flex-direction: column; gap: 4px; }
.rp-field-full { grid-column: 1 / -1; }

.rp-label { font-size: 11.5px; font-weight: 600; color: #6b7280; letter-spacing: .02em; }
.rp-req::after { content: ' *'; color: #dc2626; }

.rp-input {
  height: 36px; padding: 0 10px;
  border: 1.5px solid #e8ecf0; border-radius: 6px;
  font-size: 13px; color: #1a1a2e; background: #fff;
  outline: none; width: 100%; box-sizing: border-box;
  transition: border-color .15s, box-shadow .15s;
}
.rp-input:focus { border-color: #1a6ef7; box-shadow: 0 0 0 3px rgba(26,110,247,.12); }
.rp-input[readonly] { background: #f8faff; color: #6b7280; }
.rp-amount-input { font-weight: 700; font-size: 15px; color: #1a6ef7; }
.rp-select {
  appearance: none; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  padding-right: 28px;
}
.rp-textarea { height: auto; padding: 8px 10px; resize: vertical; line-height: 1.5; }

.rp-radio-group { display: flex; gap: 18px; padding-top: 6px; }
.rp-radio { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: #374151; }
.rp-radio input { accent-color: #1a6ef7; }

.rp-summary {
  display: flex; gap: 20px; flex-wrap: wrap;
  background: #eaf1ff; border: 1px solid #c5d8fc;
  border-radius: 6px; padding: 10px 14px;
  font-size: 12.5px; color: #1a5296;
}
.rp-summary strong { font-weight: 700; }

.rp-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 22px; border-top: 1px solid #e8ecf0;
  background: #f8faff; gap: 10px;
}
.rp-footer-right { display: flex; gap: 8px; }
.rp-btn {
  height: 36px; padding: 0 18px; border-radius: 6px;
  font-size: 13px; font-weight: 600; cursor: pointer;
  border: 1.5px solid transparent;
  font-family: inherit; transition: all .15s; white-space: nowrap;
}
.rp-btn:disabled { opacity: .55; cursor: not-allowed; }
.rp-btn-outline   { background: #fff; border-color: #e8ecf0; color: #6b7280; }
.rp-btn-outline:hover { background: #f3f4f6; }
.rp-btn-secondary { background: #fff; border-color: #1a6ef7; color: #1a6ef7; }
.rp-btn-secondary:hover { background: #eaf1ff; }
.rp-btn-primary   { background: #1a6ef7; color: #fff; border-color: #1a6ef7; }
.rp-btn-primary:hover { background: #155fd4; }

/* ── Toast ── */
.inv-toast {
  position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
  padding: 11px 22px; border-radius: 8px;
  font-size: 13px; font-weight: 500;
  box-shadow: 0 6px 24px rgba(0,0,0,.18); z-index: 99999;
  pointer-events: none;
}
.inv-toast.success { background: #059669; color: #fff; }
.inv-toast.error   { background: #dc2626; color: #fff; }
.toast-enter-active, .toast-leave-active { transition: all .25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(12px); }

@media (max-width: 600px) {
  .rp-row { grid-template-columns: 1fr; }
  .rp-footer { flex-wrap: wrap; }
  .inv-filters { padding: 10px 12px; }
  .inv-toolbar { padding: 12px 16px; }
}
</style>
