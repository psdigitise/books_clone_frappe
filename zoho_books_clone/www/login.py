import frappe

no_cache = 1


def get_context(context):
    redirect_to = frappe.local.request.args.get("redirect-to") or "/books"

    # Prevent open redirects — only allow same-origin paths
    if not redirect_to.startswith("/"):
        redirect_to = "/books"

    # Already logged in — send to destination
    if frappe.session.user and frappe.session.user != "Guest":
        frappe.local.flags.redirect_location = redirect_to
        raise frappe.Redirect

    context.no_header = 1
    context.no_footer = 1
    context.no_sidebar = 1
    context.title = "Sign In — Books"
    context.redirect_to = redirect_to

    # CSRF token — available even for guest sessions
    try:
        context.csrf_token = frappe.session.data.csrf_token or ""
    except Exception:
        context.csrf_token = ""

    return context
