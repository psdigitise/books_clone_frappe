app_name        = "zoho_books_clone"
app_title       = "Zoho Books Clone"
app_publisher   = "Your Company"
app_description = "A full-featured accounting application like ZOHO Books"
app_email       = "dev@yourcompany.com"
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

# NOTE: No doc_events for submit/cancel — the DocType classes handle those
# directly via on_submit / on_cancel methods. Putting them here too causes
# double GL posting.
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
    "Accounts":  [{"doctype": "Account"}, {"doctype": "Customer"}, {"doctype": "Supplier"}],
    "Invoicing": [{"doctype": "Sales Invoice"}, {"doctype": "Purchase Invoice"}],
    "Payments":  [{"doctype": "Payment Entry"}],
}

app_include_css = ["/assets/zoho_books_clone/css/books.css"]
app_include_js  = ["/assets/zoho_books_clone/js/books.js"]

after_install = "zoho_books_clone.setup.install.after_install"
after_migrate = "zoho_books_clone.setup.install.after_migrate"
