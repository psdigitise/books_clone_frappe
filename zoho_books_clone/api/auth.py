"""
Authentication helpers — signup, OTP verification, onboarding.
All guest endpoints require allow_guest=True; post-login endpoints use the default session guard.
"""
import random
import string

import frappe
from frappe import _


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _gen_otp(n=6):
    return "".join(random.choices(string.digits, k=n))


def _signup_cache_key(email):
    return f"books_signup:{email.strip().lower()}"


def _send_otp_email(email, first_name, otp):
    try:
        frappe.sendmail(
            recipients=[email],
            subject="Verify your Books account",
            message=f"""
<div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
    <div style="width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,#3949AB,#1A237E);
      display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;font-size:18px">B</div>
    <span style="font-size:18px;font-weight:700;color:#0D1117">Books</span>
  </div>
  <h2 style="color:#1A237E;font-size:22px;margin-bottom:8px">Verify your email</h2>
  <p style="color:#555;margin-bottom:24px;line-height:1.6">Hi {first_name}, use this code to activate your Books account:</p>
  <div style="background:#E8EAF6;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px">
    <span style="font-size:40px;font-weight:800;letter-spacing:14px;color:#1A237E;font-family:monospace">{otp}</span>
  </div>
  <p style="color:#888;font-size:13px;line-height:1.6">
    This code expires in <strong>30 minutes</strong>.<br>
    If you didn't request this, you can safely ignore this email.
  </p>
</div>""",
            now=True,
        )
    except Exception:
        pass  # Don't block signup in dev environments without email configured


# ─── Signup ───────────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=True, methods=["POST"])
def signup_user(first_name, email, password, company_name="", last_name=""):
    """Store signup data in cache and send a 6-digit verification OTP."""
    email = (email or "").strip().lower()
    first_name = (first_name or "").strip()
    password = password or ""

    if not email or not first_name or not password:
        frappe.throw(_("Name, email, and password are required."))

    if "@" not in email or "." not in email.split("@")[-1]:
        frappe.throw(_("Please enter a valid email address."))

    if frappe.db.exists("User", email):
        frappe.throw(_("An account with this email already exists. Please sign in instead."))

    if len(password) < 8:
        frappe.throw(_("Password must be at least 8 characters."))

    otp = _gen_otp()
    frappe.cache.set_value(
        _signup_cache_key(email),
        {
            "first_name": first_name,
            "last_name": (last_name or "").strip(),
            "email": email,
            "password": password,
            "company_name": (company_name or "").strip(),
            "otp": otp,
        },
        expires_in_sec=1800,
    )

    _send_otp_email(email, first_name, otp)
    return {"success": True, "email": email}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def resend_signup_otp(email):
    """Regenerate and resend the signup OTP."""
    email = (email or "").strip().lower()
    key = _signup_cache_key(email)
    data = frappe.cache.get_value(key)
    if not data:
        frappe.throw(_("Signup session expired. Please start over."))

    new_otp = _gen_otp()
    data["otp"] = new_otp
    frappe.cache.set_value(key, data, expires_in_sec=1800)
    _send_otp_email(email, data["first_name"], new_otp)
    return {"success": True}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def verify_signup_otp(email, otp):
    """Verify the OTP; on success create the User and Company."""
    email = (email or "").strip().lower()
    otp = (otp or "").strip()

    key = _signup_cache_key(email)
    data = frappe.cache.get_value(key)

    if not data:
        frappe.throw(_("Verification session expired. Please sign up again."))

    if data.get("otp") != otp:
        frappe.throw(_("Invalid verification code. Please try again."))

    try:
        # ── Create User ──────────────────────────────────────────────
        user = frappe.new_doc("User")
        user.email = email
        user.first_name = data["first_name"]
        user.last_name = data.get("last_name", "")
        user.user_type = "System User"
        user.send_welcome_email = 0
        user.enabled = 1
        user.new_password = data["password"]
        user.append("roles", {"role": "Books Manager"})
        user.insert(ignore_permissions=True)

        # ── Register Company (string-based, no Company DocType in this app) ──
        company_name = data.get("company_name", "").strip()
        created_company = ""
        if company_name:
            created_company = company_name

            # Store as per-user default — gives each user their own scope.
            try:
                frappe.defaults.set_user_default("company", created_company, user=email)
            except Exception:
                pass

            # Seed Books Settings.default_company only when nothing is set yet,
            # so first signup populates the global default but later signups don't overwrite.
            try:
                cur = frappe.db.get_single_value("Books Settings", "default_company")
                if not cur:
                    frappe.db.set_single_value("Books Settings", "default_company", created_company)
            except Exception:
                pass

            # Best-effort: bootstrap a minimal Chart of Accounts + Fiscal Year for this company.
            try:
                from zoho_books_clone.books_setup.bootstrap import bootstrap_company_data
                bootstrap_company_data(created_company)
            except Exception as exc:
                frappe.log_error(f"Books signup — bootstrap skipped: {exc}", "Books Auth")

        frappe.db.commit()
        frappe.cache.delete_value(key)

        return {"success": True, "user": email, "company": created_company or company_name}

    except Exception as exc:
        frappe.db.rollback()
        frappe.throw(str(exc))


# ─── Onboarding ───────────────────────────────────────────────────────────────

@frappe.whitelist(methods=["POST"])
def complete_onboarding(
    company_name="",
    gstin="",
    gst_state="",
    invoice_prefix="INV",
    currency="INR",
    fy_start="04-01",
):
    """Save initial company settings and bootstrap COA + FY after the onboarding wizard."""
    from zoho_books_clone.books_setup.bootstrap import bootstrap_company_data

    try:
        # Per-user company default — keeps each signup isolated
        if company_name:
            try:
                frappe.defaults.set_user_default("company", company_name, user=frappe.session.user)
            except Exception:
                pass

        # Update Books Settings (singleton). Avoid `get_doc` because the table
        # for a single doctype only has rows in `tabSingles`; use the helper.
        try:
            for field, val in [
                ("default_company",  company_name),
                ("gstin",            gstin),
                ("gst_state",        gst_state),
                ("invoice_prefix",   invoice_prefix or "INV"),
                ("default_currency", currency or "INR"),
            ]:
                if val:
                    frappe.db.set_single_value("Books Settings", field, val)
        except Exception as exc:
            frappe.log_error(f"Books Settings update — {exc}", "Books Onboarding")

        # Seed COA + Fiscal Year for this company (idempotent)
        if company_name:
            try:
                bootstrap_company_data(company_name, fy_start or "04-01")
            except Exception as exc:
                frappe.log_error(f"Bootstrap — {exc}", "Books Onboarding")

        frappe.db.commit()
        return {"success": True}

    except Exception as exc:
        frappe.log_error(str(exc), "Books Onboarding")
        return {"success": True, "note": "Settings partially saved — you can update them in Company Setup"}
