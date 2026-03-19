/**
 * record_payment.js
 * ─────────────────────────────────────────────────────────────
 * Drop this into:
 *   zoho_books_clone/public/js/record_payment.js
 *
 * And register it in hooks.py:
 *   app_include_js = ["/assets/zoho_books_clone/js/record_payment.js"]
 *
 * Or include it in your SPA bundle / page JS.
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  /* ───────────────────────────── helpers ───────────────────── */

  function fmt_currency(amount, symbol = "₹") {
    return symbol + Number(amount || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function get(url, params = {}) {
    const qs = new URLSearchParams({ ...params, cmd: url }).toString();
    return fetch(`/api/method/${url}?${qs}`, {
      headers: { "X-Frappe-CSRF-Token": frappe.csrf_token },
    }).then((r) => r.json());
  }

  function post(url, body = {}) {
    return fetch(`/api/method/${url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": frappe.csrf_token,
      },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  }

  /* ─────────────────────── MAIN DIALOG BUILDER ─────────────── */

  /**
   * openRecordPaymentDialog(invoiceName)
   *
   * Call this from anywhere — a button, a list-view action, etc.
   */
  window.openRecordPaymentDialog = async function (invoiceName) {
    // 1. Fetch defaults from backend
    let defaults;
    try {
      const res = await get(
        "zoho_books_clone.api.books_data.get_payment_defaults",
        { invoice_name: invoiceName }
      );
      if (res.exc) throw new Error(res.exc);
      defaults = res.message;
    } catch (e) {
      frappe.msgprint({ title: "Error", message: String(e), indicator: "red" });
      return;
    }

    const symbol = defaults.currency === "INR" ? "₹" : defaults.currency + " ";

    /* ── build <select> options ── */
    const modeOptions = (defaults.payment_modes || ["Cash", "Bank Transfer", "Cheque"])
      .map((m) => `<option value="${m}" ${m === "Cash" ? "selected" : ""}>${m}</option>`)
      .join("");

    const accountOptions = (defaults.bank_accounts || [])
      .map((a) => `<option value="${a.name}">${a.name} (${a.account_type})</option>`)
      .join("");

    /* ── today formatted as dd/MM/yyyy ── */
    const todayFormatted = (function () {
      const d = new Date();
      return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    })();

    /* ── HTML ── */
    const html = `
<div class="rp-modal-overlay" id="rpOverlay">
  <div class="rp-modal">

    <!-- Header -->
    <div class="rp-header">
      <span class="rp-header-title">Payment for ${frappe.utils.escape_html(invoiceName)}</span>
      <button class="rp-close" id="rpClose" title="Close">&#x2715;</button>
    </div>

    <!-- Customer badge -->
    <div class="rp-customer-badge">
      <div class="rp-avatar">${defaults.customer_name.charAt(0).toUpperCase()}</div>
      <div>
        <div class="rp-customer-name">${frappe.utils.escape_html(defaults.customer_name)}</div>
        <div class="rp-balance">Balance Due: <strong>${fmt_currency(defaults.balance_due, symbol)}</strong></div>
      </div>
    </div>

    <!-- Body -->
    <div class="rp-body">

      <!-- Row 1 -->
      <div class="rp-row">
        <div class="rp-field">
          <label class="rp-label required">Customer Name</label>
          <input class="rp-input" id="rpCustomerName" value="${frappe.utils.escape_html(defaults.customer_name)}" readonly />
        </div>
        <div class="rp-field">
          <label class="rp-label required">Payment #</label>
          <input class="rp-input" id="rpPaymentNum" value="${defaults.payment_number}" />
        </div>
      </div>

      <!-- Row 2: Amount + Bank Charges -->
      <div class="rp-row">
        <div class="rp-field">
          <label class="rp-label required">Amount Received (${defaults.currency})</label>
          <input class="rp-input rp-amount" id="rpAmount" type="number" min="0" step="0.01"
                 value="${defaults.balance_due}" />
        </div>
        <div class="rp-field">
          <label class="rp-label">Bank Charges (if any)</label>
          <input class="rp-input" id="rpBankCharges" type="number" min="0" step="0.01" value="0" />
        </div>
      </div>

      <!-- TDS row -->
      <div class="rp-row rp-tds-row">
        <div class="rp-field">
          <label class="rp-label">Tax Deducted?</label>
          <div class="rp-radio-group">
            <label class="rp-radio">
              <input type="radio" name="rpTds" value="no" checked /> No Tax Deducted
            </label>
            <label class="rp-radio">
              <input type="radio" name="rpTds" value="yes" /> Yes, TDS (Income Tax)
            </label>
          </div>
        </div>
        <div class="rp-field rp-tds-amount-wrap" id="rpTdsWrap" style="display:none;">
          <label class="rp-label">TDS Amount</label>
          <input class="rp-input" id="rpTdsAmount" type="number" min="0" step="0.01" value="0" />
        </div>
      </div>

      <!-- Row 3: Date + Mode -->
      <div class="rp-row">
        <div class="rp-field">
          <label class="rp-label required">Payment Date</label>
          <input class="rp-input rp-date" id="rpPaymentDate" type="date"
                 value="${new Date().toISOString().split("T")[0]}" />
        </div>
        <div class="rp-field">
          <label class="rp-label">Payment Mode</label>
          <select class="rp-input rp-select" id="rpPaymentMode">${modeOptions}</select>
        </div>
      </div>

      <!-- Row 4: Reference + Deposit To -->
      <div class="rp-row">
        <div class="rp-field">
          <label class="rp-label">Reference #</label>
          <input class="rp-input" id="rpReference" placeholder="e.g. cheque / UTR number" />
        </div>
        <div class="rp-field">
          <label class="rp-label required">Deposit To</label>
          <select class="rp-input rp-select" id="rpDepositTo">${accountOptions}</select>
        </div>
      </div>

      <!-- Notes -->
      <div class="rp-field rp-full">
        <label class="rp-label">Notes</label>
        <textarea class="rp-input rp-textarea" id="rpNotes" rows="3" placeholder="Optional notes..."></textarea>
      </div>

      <!-- Summary strip -->
      <div class="rp-summary" id="rpSummary">
        <span>Invoice Total: <strong>${fmt_currency(defaults.grand_total, symbol)}</strong></span>
        <span>Amount Entering: <strong id="rpSummaryAmount">${fmt_currency(defaults.balance_due, symbol)}</strong></span>
        <span>Balance After: <strong id="rpSummaryBalance">${fmt_currency(defaults.grand_total - defaults.balance_due, symbol)}</strong></span>
      </div>
    </div>

    <!-- Footer -->
    <div class="rp-footer">
      <button class="rp-btn rp-btn-outline" id="rpCancel">Cancel</button>
      <div class="rp-footer-right">
        <button class="rp-btn rp-btn-secondary" id="rpSaveDraft">Save as Draft</button>
        <button class="rp-btn rp-btn-primary" id="rpSavePaid">Save as Paid</button>
      </div>
    </div>

  </div>
</div>`;

    /* ── inject into DOM ── */
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper);

    /* ── refs ── */
    const overlay  = document.getElementById("rpOverlay");
    const amountEl = document.getElementById("rpAmount");
    const chargesEl= document.getElementById("rpBankCharges");
    const tdsWrap  = document.getElementById("rpTdsWrap");
    const tdsAmt   = document.getElementById("rpTdsAmount");
    const summaryAmt  = document.getElementById("rpSummaryAmount");
    const summaryBal  = document.getElementById("rpSummaryBalance");

    /* ── live summary update ── */
    function updateSummary() {
      const amt = parseFloat(amountEl.value) || 0;
      summaryAmt.textContent = fmt_currency(amt, symbol);
      const balanceAfter = defaults.grand_total - (defaults.grand_total - defaults.balance_due) - amt;
      summaryBal.textContent = fmt_currency(Math.max(0, balanceAfter), symbol);
    }
    amountEl.addEventListener("input", updateSummary);
    chargesEl.addEventListener("input", updateSummary);

    /* ── TDS toggle ── */
    document.querySelectorAll('input[name="rpTds"]').forEach((r) => {
      r.addEventListener("change", () => {
        tdsWrap.style.display = r.value === "yes" && r.checked ? "block" : "none";
      });
    });

    /* ── close ── */
    function close() { wrapper.remove(); }
    document.getElementById("rpClose").addEventListener("click", close);
    document.getElementById("rpCancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    /* ── submit helper ── */
    async function submit(saveAsDraft) {
      const amount = parseFloat(amountEl.value);
      if (!amount || amount <= 0) {
        frappe.show_alert({ message: "Please enter a valid amount.", indicator: "orange" });
        return;
      }

      const btn = saveAsDraft
        ? document.getElementById("rpSaveDraft")
        : document.getElementById("rpSavePaid");
      btn.disabled = true;
      btn.textContent = "Saving…";

      try {
        const res = await post("zoho_books_clone.api.books_data.record_payment", {
          invoice_name:  invoiceName,
          amount_received: amount,
          payment_date:  document.getElementById("rpPaymentDate").value,
          payment_mode:  document.getElementById("rpPaymentMode").value,
          deposit_to:    document.getElementById("rpDepositTo").value,
          bank_charges:  parseFloat(chargesEl.value) || 0,
          reference_no:  document.getElementById("rpReference").value,
          notes:         document.getElementById("rpNotes").value,
          tds_deducted:  document.querySelector('input[name="rpTds"]:checked').value === "yes" ? 1 : 0,
          tds_amount:    parseFloat(tdsAmt.value) || 0,
          save_as_draft: saveAsDraft ? 1 : 0,
        });

        if (res.exc) throw new Error(res.exc);

        const msg = res.message;
        frappe.show_alert({
          message: `Payment <b>${msg.payment_entry}</b> ${msg.status === "draft" ? "saved as draft" : "recorded successfully"}!`,
          indicator: "green",
        }, 5);

        close();

        // Reload the current form / list if available
        if (window.cur_frm && cur_frm.doc && cur_frm.doc.name === invoiceName) {
          cur_frm.reload_doc();
        } else if (window.cur_list) {
          cur_list.refresh();
        } else {
          // For SPA — dispatch a custom event so the SPA can react
          window.dispatchEvent(new CustomEvent("payment_recorded", {
            detail: { invoice: invoiceName, payment: msg.payment_entry },
          }));
        }
      } catch (e) {
        frappe.show_alert({ message: String(e), indicator: "red" }, 8);
        btn.disabled = false;
        btn.textContent = saveAsDraft ? "Save as Draft" : "Save as Paid";
      }
    }

    document.getElementById("rpSaveDraft").addEventListener("click", () => submit(true));
    document.getElementById("rpSavePaid").addEventListener("click",  () => submit(false));

    /* ── animate in ── */
    requestAnimationFrame(() => overlay.classList.add("rp-visible"));
  };

  /* ─────────── Auto-attach to "Record Payment" buttons ──────── */
  document.addEventListener("click", function (e) {
    const btn = e.target.closest("[data-record-payment]");
    if (btn) {
      const inv = btn.dataset.recordPayment || btn.dataset.invoice;
      if (inv) openRecordPaymentDialog(inv);
    }
  });

})();
