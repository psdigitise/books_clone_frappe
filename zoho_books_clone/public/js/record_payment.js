/**
 * record_payment.js
 * Place in: zoho_books_clone/public/js/record_payment.js
 * Register in hooks.py:
 *   app_include_js = ["/assets/zoho_books_clone/js/record_payment.js"]
 */

(function () {
  "use strict";

  /* ── helpers ── */
  function fmt_currency(amount, symbol) {
    symbol = symbol || "Rs.";
    return symbol + Number(amount || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  /** Get CSRF token — works in Frappe SPA and classic desk */
  function getCsrf() {
    // 1. Frappe SPA sets window.csrf_token
    if (window.csrf_token && window.csrf_token !== "{{ csrf_token }}") return window.csrf_token;
    // 2. Classic Frappe desk
    if (window.frappe && frappe.csrf_token) return frappe.csrf_token;
    // 3. Cookie fallback
    var match = document.cookie.match(/csrftoken=([^;]+)/);
    if (match) return match[1];
    return "";
  }

  /** Resolve the correct API base — handles :8000, :8080, same-origin */
  function apiUrl(method) {
    return "/api/method/" + method;
  }

  function apiGet(method, params) {
    var qs = new URLSearchParams(params || {}).toString();
    var url = apiUrl(method) + (qs ? "?" + qs : "");
    return fetch(url, {
      credentials: "include",
      headers: { "X-Frappe-CSRF-Token": getCsrf() },
    }).then(function (r) { return r.json(); });
  }

  function apiPost(method, body) {
    return fetch(apiUrl(method), {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": getCsrf(),
      },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  /* ── escape html ── */
  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ══════════════════════════════════════════════════════════
     MAIN — openRecordPaymentDialog(invoiceName)
  ══════════════════════════════════════════════════════════ */
  window.openRecordPaymentDialog = function (invoiceName) {
    // 1. Fetch defaults
    apiGet("zoho_books_clone.api.books_data.get_payment_defaults", {
      invoice_name: invoiceName,
    }).then(function (res) {
      if (res.exc || res.exc_type) {
        alert("Error loading payment details:\n" + (res.exc || res.exc_type));
        return;
      }
      buildDialog(invoiceName, res.message);
    }).catch(function (err) {
      alert("Network error: " + err);
    });
  };

  function buildDialog(invoiceName, d) {
    var symbol = d.currency === "INR" ? "Rs." : (d.currency + " ");

    /* ── select options ── */
    var modeOptions = (d.payment_modes && d.payment_modes.length
      ? d.payment_modes
      : ["Cash", "Bank Transfer", "Cheque"]
    ).map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === "Cash" ? " selected" : "") + ">" + esc(m) + "</option>";
    }).join("");

    var accountOptions = (d.bank_accounts || []).map(function (a) {
      return '<option value="' + esc(a.name) + '">' + esc(a.name) + " (" + esc(a.account_type) + ")</option>";
    }).join("");

    /* ── today as YYYY-MM-DD for <input type=date> ── */
    var today = new Date().toISOString().split("T")[0];

    var html = [
      '<div class="rp-overlay" id="rpOverlay">',
      '  <div class="rp-modal">',

      '    <div class="rp-header">',
      '      <span class="rp-title">Payment for ' + esc(invoiceName) + "</span>",
      '      <button class="rp-close" id="rpClose">&#x2715;</button>',
      "    </div>",

      '    <div class="rp-badge">',
      '      <div class="rp-avatar">' + esc(d.customer_name.charAt(0).toUpperCase()) + "</div>",
      "      <div>",
      '        <div class="rp-cname">' + esc(d.customer_name) + "</div>",
      '        <div class="rp-due">Balance Due: <strong>' + fmt_currency(d.balance_due, symbol) + "</strong></div>",
      "      </div>",
      "    </div>",

      '    <div class="rp-body">',

      '      <div class="rp-row">',
      '        <div class="rp-field"><label class="rp-label req">Customer Name</label>',
      '          <input class="rp-input" value="' + esc(d.customer_name) + '" readonly /></div>',
      '        <div class="rp-field"><label class="rp-label req">Payment #</label>',
      '          <input class="rp-input" id="rpPayNum" value="' + esc(d.payment_number) + '" /></div>',
      "      </div>",

      '      <div class="rp-row">',
      '        <div class="rp-field"><label class="rp-label req">Amount Received (' + esc(d.currency) + ")</label>",
      '          <input class="rp-input rp-amount" id="rpAmount" type="number" min="0" step="0.01" value="' + d.balance_due + '" /></div>',
      '        <div class="rp-field"><label class="rp-label">Bank Charges (if any)</label>',
      '          <input class="rp-input" id="rpCharges" type="number" min="0" step="0.01" value="0" /></div>',
      "      </div>",

      '      <div class="rp-row">',
      '        <div class="rp-field"><label class="rp-label">Tax Deducted?</label>',
      '          <div class="rp-radios">',
      '            <label><input type="radio" name="rpTds" value="no" checked /> No Tax Deducted</label>',
      '            <label><input type="radio" name="rpTds" value="yes" /> Yes, TDS (Income Tax)</label>',
      "          </div></div>",
      '        <div class="rp-field" id="rpTdsWrap" style="display:none"><label class="rp-label">TDS Amount</label>',
      '          <input class="rp-input" id="rpTdsAmt" type="number" min="0" step="0.01" value="0" /></div>',
      "      </div>",

      '      <div class="rp-row">',
      '        <div class="rp-field"><label class="rp-label req">Payment Date</label>',
      '          <input class="rp-input" id="rpDate" type="date" value="' + today + '" /></div>',
      '        <div class="rp-field"><label class="rp-label">Payment Mode</label>',
      '          <select class="rp-input rp-sel" id="rpMode">' + modeOptions + "</select></div>",
      "      </div>",

      '      <div class="rp-row">',
      '        <div class="rp-field"><label class="rp-label">Reference #</label>',
      '          <input class="rp-input" id="rpRef" placeholder="Cheque / UTR / Txn ID" /></div>',
      '        <div class="rp-field"><label class="rp-label req">Deposit To</label>',
      '          <select class="rp-input rp-sel" id="rpDeposit">' + accountOptions + "</select></div>",
      "      </div>",

      '      <div class="rp-field rp-full">',
      '        <label class="rp-label">Notes</label>',
      '        <textarea class="rp-input rp-ta" id="rpNotes" rows="2" placeholder="Optional notes..."></textarea>',
      "      </div>",

      '      <div class="rp-summary" id="rpSummary">',
      '        <span>Invoice Total: <strong>' + fmt_currency(d.grand_total, symbol) + "</strong></span>",
      '        <span>Entering: <strong id="rpSumAmt">' + fmt_currency(d.balance_due, symbol) + "</strong></span>",
      '        <span>Balance After: <strong id="rpSumBal">' + fmt_currency(0, symbol) + "</strong></span>",
      "      </div>",

      "    </div>", // .rp-body

      '    <div class="rp-footer">',
      '      <button class="rp-btn rp-outline" id="rpCancel">Cancel</button>',
      '      <div class="rp-fr">',
      '        <button class="rp-btn rp-secondary" id="rpDraft">Save as Draft</button>',
      '        <button class="rp-btn rp-primary" id="rpPaid">Save as Paid</button>',
      "      </div>",
      "    </div>",

      "  </div>",
      "</div>",
    ].join("\n");

    var wrap = document.createElement("div");
    wrap.innerHTML = html;
    document.body.appendChild(wrap);

    /* ── refs ── */
    var overlay  = document.getElementById("rpOverlay");
    var amountEl = document.getElementById("rpAmount");
    var sumAmt   = document.getElementById("rpSumAmt");
    var sumBal   = document.getElementById("rpSumBal");
    var tdsWrap  = document.getElementById("rpTdsWrap");

    /* ── summary update ── */
    function updateSummary() {
      var amt = parseFloat(amountEl.value) || 0;
      sumAmt.textContent = fmt_currency(amt, symbol);
      var alreadyPaid = d.grand_total - d.balance_due;
      var balAfter = Math.max(0, d.grand_total - alreadyPaid - amt);
      sumBal.textContent = fmt_currency(balAfter, symbol);
    }
    amountEl.addEventListener("input", updateSummary);
    updateSummary();

    /* ── TDS toggle ── */
    document.querySelectorAll('input[name="rpTds"]').forEach(function (r) {
      r.addEventListener("change", function () {
        tdsWrap.style.display = (r.value === "yes" && r.checked) ? "block" : "none";
      });
    });

    /* ── close ── */
    function close() { wrap.remove(); }
    document.getElementById("rpClose").addEventListener("click", close);
    document.getElementById("rpCancel").addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });

    /* ── submit ── */
    function submit(saveAsDraft) {
      var amt = parseFloat(amountEl.value);
      if (!amt || amt <= 0) {
        alert("Please enter a valid amount greater than 0.");
        return;
      }
      var btn = saveAsDraft
        ? document.getElementById("rpDraft")
        : document.getElementById("rpPaid");
      btn.disabled = true;
      btn.textContent = "Saving…";

      var tdsRadio = document.querySelector('input[name="rpTds"]:checked');

      apiPost("zoho_books_clone.api.books_data.record_payment", {
        invoice_name:    invoiceName,
        amount_received: amt,
        payment_date:    document.getElementById("rpDate").value,
        payment_mode:    document.getElementById("rpMode").value,
        deposit_to:      document.getElementById("rpDeposit").value,
        bank_charges:    parseFloat(document.getElementById("rpCharges").value) || 0,
        reference_no:    document.getElementById("rpRef").value,
        notes:           document.getElementById("rpNotes").value,
        tds_deducted:    (tdsRadio && tdsRadio.value === "yes") ? 1 : 0,
        tds_amount:      parseFloat(document.getElementById("rpTdsAmt").value) || 0,
        save_as_draft:   saveAsDraft ? 1 : 0,
      }).then(function (res) {
        if (res.exc || res.exc_type) {
          alert("Error saving payment:\n" + (res._server_messages || res.exc || "Unknown error"));
          btn.disabled = false;
          btn.textContent = saveAsDraft ? "Save as Draft" : "Save as Paid";
          return;
        }
        var msg = res.message;
        var notice = document.createElement("div");
        notice.className = "rp-toast";
        notice.innerHTML = "&#x2714; Payment <b>" + esc(msg.payment_entry) + "</b> " +
          (msg.status === "draft" ? "saved as draft" : "recorded successfully") + "!";
        document.body.appendChild(notice);
        setTimeout(function () { notice.remove(); }, 4000);
        close();

        // Refresh page / list if possible
        if (window.cur_frm && cur_frm.doc && cur_frm.doc.name === invoiceName) {
          cur_frm.reload_doc();
        } else {
          window.dispatchEvent(new CustomEvent("payment_recorded", {
            detail: { invoice: invoiceName, payment: msg.payment_entry },
          }));
        }
      }).catch(function (err) {
        alert("Network error: " + err);
        btn.disabled = false;
        btn.textContent = saveAsDraft ? "Save as Draft" : "Save as Paid";
      });
    }

    document.getElementById("rpDraft").addEventListener("click", function () { submit(true); });
    document.getElementById("rpPaid").addEventListener("click",  function () { submit(false); });

    /* ── animate in ── */
    requestAnimationFrame(function () { overlay.classList.add("rp-visible"); });
  }

  /* ── auto-attach to [data-record-payment] buttons ── */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-record-payment]");
    if (btn) {
      var inv = btn.getAttribute("data-record-payment") || btn.getAttribute("data-invoice");
      if (inv) openRecordPaymentDialog(inv);
    }
  });

})();
