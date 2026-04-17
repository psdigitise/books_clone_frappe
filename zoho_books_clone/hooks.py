app_name        = "zoho_books_clone"
app_title       = "Books"
app_publisher   = "PS Digitise"
app_description = "A full-featured accounting application built on Frappe"
app_email       = "devteam@psdigitise.com"
app_license     = "MIT"
app_version     = "1.0.0"
app_icon        = "octicon octicon-book"
app_color       = "#2563EB"

fixtures = [
    {"dt": "Role", "filters": [["name", "in", [
        "Books Admin", "Accountant", "Books Manager", "Books Viewer"
    ]]]},
    "Custom Field",
    "Property Setter",
]

# Central validation layer (P2/Issue 10) — runs on every financial document
_CV = "zoho_books_clone.accounts.central_validator"
# Stock link layer (Audit-2 / Audit-3) — auto stock entries on invoice submit/cancel
_SL = "zoho_books_clone.inventory.stock_link"
doc_events = {
    "Sales Invoice": {
        "validate":  f"{_CV}.on_validate",
        "on_submit": [f"{_CV}.on_submit", f"{_SL}.on_sales_invoice_submit"],
        "on_cancel": f"{_SL}.on_sales_invoice_cancel",
    },
    "Purchase Invoice": {
        "validate":  f"{_CV}.on_validate",
        "on_submit": [f"{_CV}.on_submit", f"{_SL}.on_purchase_invoice_submit"],
        "on_cancel": f"{_SL}.on_purchase_invoice_cancel",
    },
    "Payment Entry":    {"validate": f"{_CV}.on_validate", "on_submit": f"{_CV}.on_submit"},
    "Journal Entry":    {"validate": f"{_CV}.on_validate", "on_submit": f"{_CV}.on_submit"},
    "Credit Note":      {"validate": f"{_CV}.on_validate", "on_submit": f"{_CV}.on_submit"},
    "Expense":          {"validate": f"{_CV}.on_validate", "on_submit": f"{_CV}.on_submit"},
    "Expense Claim":    {"validate": f"{_CV}.on_validate"},
}

scheduler_events = {
    "daily": [
        "zoho_books_clone.utils.scheduler.send_payment_reminders",
        "zoho_books_clone.banking.utils.auto_match_bank_transactions",
        "zoho_books_clone.inventory.utils.get_reorder_alerts",   # logs reorder items daily
    ],
    "monthly": [
        "zoho_books_clone.utils.scheduler.generate_monthly_reports",
    ],
}

global_search_doctypes = {
    "Accounts":  [
        {"doctype": "Account"},
        {"doctype": "Cost Center"},
    ],
    "Invoicing": [
        {"doctype": "Sales Invoice"},
        {"doctype": "Purchase Invoice"},
        {"doctype": "Customer"},
        {"doctype": "Supplier"},
        {"doctype": "Item"},
    ],
    "Payments": [
        {"doctype": "Payment Entry"},
    ],
    "Expenses": [
        {"doctype": "Expense"},
        {"doctype": "Expense Claim"},
    ],
    "Inventory": [
        {"doctype": "Warehouse"},
        {"doctype": "Stock Entry"},
        {"doctype": "Item Price"},
        {"doctype": "Price List"},
    ],
    "Books Setup": [
        {"doctype": "Currency"},
        {"doctype": "Currency Exchange"},
        {"doctype": "UOM"},
        {"doctype": "Books Payment Mode"},
        {"doctype": "Payment Terms"},
    ],
}

app_include_css = ["/assets/zoho_books_clone/css/books.css"]
app_include_js  = ["/assets/zoho_books_clone/js/books.js"]

after_install = "zoho_books_clone.books_setup.install.after_install"
after_migrate = "zoho_books_clone.books_setup.install.after_migrate"
