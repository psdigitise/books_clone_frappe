"""
Patch v1_1: Fix company name mismatch in Account records.

Background:
    During early development the bench site was set up with the company name
    'booksnew' and later manually renamed.  Any Account (and dependent doctype)
    rows that still carry the old company name are invisible to every query that
    filters by the current Books Settings company, making the app appear broken.

What this patch does:
    1. Reads the canonical company name from Books Settings.default_company.
    2. Finds every distinct company value stored in the Account table.
    3. For each stale company name (everything that is NOT the canonical one and
       that looks like it should belong to the same org — e.g. 'booksnew',
       'site1.local', empty string, etc.) it updates all affected rows to the
       canonical company name.
    4. Runs the same correction across related doctypes so foreign-key-style
       company filters remain consistent.

Safe to re-run: all UPDATE statements are idempotent.
"""

import frappe


# Doctypes that carry a company field and need to be kept in sync.
_COMPANY_FIELD_DOCTYPES = [
    "Account",
    "Cost Center",
    "Sales Invoice",
    "Purchase Invoice",
    "Payment Entry",
    "Bank Account",
    "Bank Transaction",
    "General Ledger Entry",
]

# Known stale names produced during dev / early setup.
_KNOWN_STALE = {"booksnew", "site1.local", ""}


def execute():
    canonical = frappe.db.get_single_value("Books Settings", "default_company")
    if not canonical:
        # Nothing to do — Books Settings not configured yet
        frappe.log_error(
            "fix_company_names patch skipped: Books Settings.default_company is not set.",
            "Patch v1_1",
        )
        return

    updated_total = 0

    for doctype in _COMPANY_FIELD_DOCTYPES:
        table = f"tab{doctype}"

        # Skip if DocType table doesn't exist yet
        try:
            frappe.db.sql(f"SELECT 1 FROM `{table}` LIMIT 1")
        except Exception:
            continue

        # Skip if the company column hasn't been created yet (schema update pending)
        if not frappe.db.has_column(doctype, "company"):
            continue

        # Collect all distinct company values present in this table
        rows = frappe.db.sql(
            f"SELECT DISTINCT company FROM `{table}` WHERE company != %s",
            canonical,
            as_dict=True,
        )

        for row in rows:
            stale = (row.get("company") or "").strip()

            # Only rewrite rows that look stale — exact known names or blank
            if stale in _KNOWN_STALE:
                count = frappe.db.sql(
                    f"SELECT COUNT(*) FROM `{table}` WHERE company = %s",
                    stale or "",
                )[0][0]

                if count:
                    frappe.db.sql(
                        f"UPDATE `{table}` SET company = %s WHERE company = %s",
                        (canonical, stale or ""),
                    )
                    updated_total += count
                    frappe.log_error(
                        f"Renamed company '{stale}' → '{canonical}' in {doctype} ({count} rows)",
                        "Patch v1_1 info",
                    )

    frappe.db.commit()

    if updated_total:
        print(
            f"✅  fix_company_names: updated {updated_total} rows across "
            f"{len(_COMPANY_FIELD_DOCTYPES)} doctypes → company = '{canonical}'"
        )
    else:
        print("✅  fix_company_names: nothing to fix — all rows already consistent.")
