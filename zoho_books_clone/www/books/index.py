import frappe

no_cache = 1

def get_context(context):
    # Redirect guests
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/books"
        raise frappe.Redirect

    csrf     = frappe.session.csrf_token or ""
    user     = frappe.session.user or ""
    try:
        fullname = frappe.utils.get_fullname(user) or user
    except Exception:
        fullname = user

    html = (
        "<!DOCTYPE html>"
        "<html lang='en'><head>"
        "<meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1.0'/>"
        "<title>Books</title>"
        "<link rel='preconnect' href='https://fonts.googleapis.com'>"
        "<link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>"
        "<link href='https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap' rel='stylesheet'>"
        "<link rel='stylesheet' href='/assets/zoho_books_clone/css/books.css'>"
        "<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}"
        "html,body{height:100%;width:100%;background:#0f1117;color:#e2e8f0;overflow:hidden}"
        "#books-app{height:100vh;width:100vw;display:flex}</style>"
        "</head><body>"
        "<div id='books-app'></div>"
        "<script>"
        "window.frappe={csrf_token:'" + csrf + "',"
        "session:{user:'" + user + "',user_fullname:'" + fullname + "'},"
        "boot:{sysdefaults:{company:''}}};"
        "window.__booksCompany='';"
        "</script>"
        "<script src='https://unpkg.com/vue@3/dist/vue.global.prod.js'></script>"
        "<script src='https://unpkg.com/vue-router@4/dist/vue-router.global.prod.js'></script>"
        "<script src='/assets/zoho_books_clone/js/books.js'></script>"
        "</body></html>"
    )

    # Directly set the response on the Frappe local object and abort template rendering
    from werkzeug.wrappers import Response as WerkzeugResponse
    wz_response = WerkzeugResponse(html, status=200, mimetype="text/html")
    raise wz_response
