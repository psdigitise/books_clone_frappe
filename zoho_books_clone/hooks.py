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

# No doc_events for submit/cancel — handled by the DocType classes directly
doc_events = {}

scheduler_events = {
    "daily": [
        "zoho_books_clone.utils.scheduler.send_payment_reminders",
        "zoho_books_clone.banking.utils.auto_match_bank_transactions",
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
    "Books Setup": [
        {"doctype": "Currency"},
        {"doctype": "UOM"},
        {"doctype": "Books Payment Mode"},
        {"doctype": "Payment Terms"},
    ],
}

app_include_css = ["/assets/zoho_books_clone/css/books.css"]
app_include_js  = ["/assets/zoho_books_clone/js/books.js"]

after_install = "zoho_books_clone.books_setup.install.after_install"
after_migrate = "zoho_books_clone.books_setup.install.after_migrate"
