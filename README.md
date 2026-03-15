# Zoho Books Clone (Frappe App)

A full-featured accounting application built on the Frappe framework, inspired by ZOHO Books.

## Modules
- **Accounts** – Chart of Accounts, General Ledger, Fiscal Year
- **Invoicing** – Sales & Purchase Invoices with GST
- **Payments** – Payment Entries, Allocation, Receipts
- **Banking** – Bank Accounts, Statements, Reconciliation
- **Taxes** – GST Templates, Tax Rules
- **Reports** – P&L, Balance Sheet, Cash Flow, Aging

## Installation
```bash
bench get-app zoho_books_clone https://github.com/yourorg/zoho_books_clone
bench --site your.site install-app zoho_books_clone
bench --site your.site migrate
```

## Development
```bash
bench start
bench --site your.site console
bench --site your.site run-tests --app zoho_books_clone
```
