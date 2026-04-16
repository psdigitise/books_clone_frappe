from frappe.model.document import Document


class Bin(Document):
    """
    Bin holds the *current* stock position for a single Item + Warehouse combination.
    It is never created manually — the Stock Ledger Entry controller maintains it.
    """
    pass
