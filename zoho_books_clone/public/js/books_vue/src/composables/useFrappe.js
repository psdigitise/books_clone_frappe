// composables/useFrappe.js
// Thin wrapper around frappe.call / frappe.db for use in Vue components.

import { ref } from "vue";

/**
 * Call a whitelisted Python method.
 * Returns { data, loading, error, execute }.
 */
export function useFrappeCall(method, args = {}) {
  const data    = ref(null);
  const loading = ref(false);
  const error   = ref(null);

  async function execute(overrideArgs = {}) {
    loading.value = true;
    error.value   = null;
    try {
      const res = await frappe.call({
        method,
        args: { ...args, ...overrideArgs },
      });
      data.value = res.message;
    } catch (e) {
      error.value = e;
      console.error(`[useFrappeCall] ${method}`, e);
    } finally {
      loading.value = false;
    }
    return data.value;
  }

  return { data, loading, error, execute };
}

/**
 * Fetch a list of documents via frappe.db.get_list equivalent.
 */
export function useFrappeList(doctype, opts = {}) {
  const list    = ref([]);
  const loading = ref(false);
  const error   = ref(null);

  async function fetch(overrideOpts = {}) {
    loading.value = true;
    error.value   = null;
    try {
      const res = await frappe.call({
        method: "frappe.client.get_list",
        args: {
          doctype,
          fields:     opts.fields     || ["name"],
          filters:    opts.filters    || [],
          order_by:   opts.order_by   || "modified desc",
          limit_page_length: opts.limit || 20,
          ...overrideOpts,
        },
      });
      list.value = res.message || [];
    } catch (e) {
      error.value = e;
    } finally {
      loading.value = false;
    }
    return list.value;
  }

  return { list, loading, error, fetch };
}

/** Format a number as INR currency */
export function formatCurrency(val, currency = "INR") {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(val);
}

/** Format ISO date to readable string */
export function formatDate(val) {
  if (!val) return "—";
  return new Date(val).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
}
