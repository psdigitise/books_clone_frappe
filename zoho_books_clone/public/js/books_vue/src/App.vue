<template>
  <div class="books-app" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <!-- ── Sidebar ── -->
    <aside class="books-sidebar">
      <div class="sidebar-brand">
        <span class="brand-icon">⬡</span>
        <transition name="fade-slide">
          <span v-if="!sidebarCollapsed" class="brand-name">Books</span>
        </transition>
      </div>

      <nav class="sidebar-nav">
        <router-link
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :title="item.label"
          active-class="nav-item--active"
        >
          <span class="nav-icon" v-html="item.icon"></span>
          <transition name="fade-slide">
            <span v-if="!sidebarCollapsed" class="nav-label">{{ item.label }}</span>
          </transition>
        </router-link>
      </nav>

      <div class="sidebar-footer">
        <button class="nav-item collapse-btn" @click="sidebarCollapsed = !sidebarCollapsed" title="Toggle">
          <span class="nav-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path :d="sidebarCollapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6'"/>
            </svg>
          </span>
        </button>
      </div>
    </aside>

    <!-- ── Main ── -->
    <div class="books-main">
      <!-- Top bar -->
      <header class="books-topbar">
        <div class="topbar-left">
          <h1 class="page-title">{{ pageTitle }}</h1>
        </div>
        <div class="topbar-right">
          <div class="search-wrap">
            <svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              v-model="searchQuery"
              class="topbar-search"
              placeholder="Search invoices, payments…"
              @keydown.enter="doSearch"
            />
          </div>
          <div class="company-badge">
            <span class="company-dot"></span>
            <span class="company-name">{{ companyName }}</span>
          </div>
          <div class="avatar">{{ userInitials }}</div>
        </div>
      </header>

      <!-- Page content -->
      <main class="books-content">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { useRoute } from "vue-router";

const route           = useRoute();
const sidebarCollapsed = ref(false);
const searchQuery     = ref("");

const companyName = computed(() =>
  frappe?.defaults?.get_user_default?.("company") ||
  frappe?.boot?.sysdefaults?.company ||
  "My Company"
);
const userInitials = computed(() => {
  const name = frappe?.session?.user_fullname || "U";
  return name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
});

const routeTitles = {
  dashboard: "Dashboard",
  invoices:  "Invoices",
  payments:  "Payments",
  banking:   "Banking",
  accounts:  "Chart of Accounts",
  reports:   "Reports",
};
const pageTitle = computed(() => routeTitles[route.name] || "Books");

const navItems = [
  { to: "/",         label: "Dashboard", icon: iconGrid },
  { to: "/invoices", label: "Invoices",  icon: iconDoc  },
  { to: "/payments", label: "Payments",  icon: iconPay  },
  { to: "/banking",  label: "Banking",   icon: iconBank },
  { to: "/accounts", label: "Accounts",  icon: iconTree },
  { to: "/reports",  label: "Reports",   icon: iconChart},
];

function doSearch() {
  if (!searchQuery.value.trim()) return;
  frappe.route_options = { query: searchQuery.value };
  frappe.set_route("zoho-books-search");
}

// ── inline SVG icons ──
const iconGrid  = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
const iconDoc   = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
const iconPay   = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
const iconBank  = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 22h18M6 18v-7m4 7v-7m4 7v-7m4 7v-7M3 7l9-5 9 5H3z"/></svg>`;
const iconTree  = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const iconChart = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
</script>

<style>
/* ───────────────────────────────────────────
   DESIGN TOKENS
─────────────────────────────────────────── */
:root {
  --books-bg:          #0f1117;
  --books-surface:     #181c27;
  --books-surface-2:   #1e2336;
  --books-border:      #2a2f45;
  --books-accent:      #4f8ef7;
  --books-accent-soft: rgba(79,142,247,.12);
  --books-green:       #34d399;
  --books-red:         #f87171;
  --books-amber:       #fbbf24;
  --books-text:        #e2e8f0;
  --books-muted:       #6b7280;
  --books-sidebar-w:   220px;
  --books-sidebar-w-sm:60px;
  --radius:            10px;
  --radius-sm:         6px;
  --shadow:            0 4px 24px rgba(0,0,0,.4);
  --font-display:      'DM Mono', 'Fira Code', monospace;
  --font-body:         'DM Sans', 'Outfit', system-ui, sans-serif;
  --transition:        .18s ease;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body { background: var(--books-bg); color: var(--books-text); font-family: var(--font-body); }

/* ── App shell ── */
.books-app {
  display: grid;
  grid-template-columns: var(--books-sidebar-w) 1fr;
  min-height: 100vh;
  transition: grid-template-columns var(--transition);
}
.books-app.sidebar-collapsed {
  grid-template-columns: var(--books-sidebar-w-sm) 1fr;
}

/* ── Sidebar ── */
.books-sidebar {
  background: var(--books-surface);
  border-right: 1px solid var(--books-border);
  display: flex;
  flex-direction: column;
  padding: 16px 0;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: hidden;
  z-index: 100;
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px 20px;
  border-bottom: 1px solid var(--books-border);
  margin-bottom: 8px;
}
.brand-icon {
  font-size: 22px;
  color: var(--books-accent);
  flex-shrink: 0;
  line-height: 1;
}
.brand-name {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--books-text);
  white-space: nowrap;
}
.sidebar-nav { flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 0 8px; }
.sidebar-footer { padding: 8px 8px 0; border-top: 1px solid var(--books-border); }

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  color: var(--books-muted);
  text-decoration: none;
  cursor: pointer;
  background: transparent;
  border: none;
  font-size: 13.5px;
  font-family: var(--font-body);
  width: 100%;
  transition: color var(--transition), background var(--transition);
  white-space: nowrap;
}
.nav-item:hover { background: var(--books-surface-2); color: var(--books-text); }
.nav-item--active { background: var(--books-accent-soft); color: var(--books-accent) !important; }
.nav-icon { flex-shrink: 0; display: flex; align-items: center; }
.nav-label { overflow: hidden; }
.collapse-btn { color: var(--books-muted); }

/* ── Main ── */
.books-main {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  overflow: hidden;
}

/* ── Topbar ── */
.books-topbar {
  height: 56px;
  background: var(--books-surface);
  border-bottom: 1px solid var(--books-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  gap: 16px;
  position: sticky;
  top: 0;
  z-index: 50;
}
.page-title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: .03em;
  color: var(--books-text);
}
.topbar-right { display: flex; align-items: center; gap: 14px; }
.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 10px;
  color: var(--books-muted);
}
.topbar-search {
  background: var(--books-surface-2);
  border: 1px solid var(--books-border);
  border-radius: 20px;
  padding: 6px 14px 6px 32px;
  font-size: 12.5px;
  color: var(--books-text);
  width: 220px;
  outline: none;
  transition: border-color var(--transition), width var(--transition);
  font-family: var(--font-body);
}
.topbar-search:focus { border-color: var(--books-accent); width: 280px; }
.topbar-search::placeholder { color: var(--books-muted); }
.company-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--books-surface-2);
  border: 1px solid var(--books-border);
  border-radius: 20px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--books-muted);
}
.company-dot {
  width: 7px; height: 7px;
  background: var(--books-green);
  border-radius: 50%;
  animation: pulse 2.5s ease-in-out infinite;
}
@keyframes pulse {
  0%,100% { opacity:1; transform:scale(1); }
  50%      { opacity:.5; transform:scale(1.3); }
}
.avatar {
  width: 32px; height: 32px;
  background: linear-gradient(135deg, var(--books-accent), #7c3aed);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: #fff;
  cursor: pointer;
}

/* ── Content area ── */
.books-content { flex: 1; padding: 0; overflow-y: auto; background: #fff; }

/* ── Shared component styles ── */
.books-card {
  background: var(--books-surface);
  border: 1px solid var(--books-border);
  border-radius: var(--radius);
  padding: 20px;
}
.books-card-title {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--books-muted);
  margin-bottom: 16px;
}
.badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
}
.badge-green  { background: rgba(52,211,153,.15); color: var(--books-green); }
.badge-red    { background: rgba(248,113,113,.15); color: var(--books-red);   }
.badge-amber  { background: rgba(251,191,36,.15);  color: var(--books-amber); }
.badge-blue   { background: var(--books-accent-soft); color: var(--books-accent); }
.badge-muted  { background: rgba(107,114,128,.15);  color: var(--books-muted); }

.books-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition);
  border: none;
  font-family: var(--font-body);
}
.books-btn-primary {
  background: var(--books-accent);
  color: #fff;
}
.books-btn-primary:hover { background: #3b7be0; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(79,142,247,.35); }
.books-btn-ghost {
  background: var(--books-surface-2);
  color: var(--books-text);
  border: 1px solid var(--books-border);
}
.books-btn-ghost:hover { background: var(--books-border); }

.books-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.books-table th {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid var(--books-border);
  font-family: var(--font-display);
  font-size: 10.5px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--books-muted);
  font-weight: 600;
}
.books-table td {
  padding: 11px 12px;
  border-bottom: 1px solid rgba(42,47,69,.6);
  color: var(--books-text);
}
.books-table tr:last-child td { border-bottom: none; }
.books-table tr:hover td { background: var(--books-surface-2); }

.loading-shimmer {
  background: linear-gradient(90deg, var(--books-surface-2) 25%, var(--books-border) 50%, var(--books-surface-2) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
  border-radius: var(--radius-sm);
  height: 14px;
}
@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

/* ── Transitions ── */
.fade-slide-enter-active, .fade-slide-leave-active { transition: all .15s ease; }
.fade-slide-enter-from, .fade-slide-leave-to { opacity: 0; transform: translateX(-6px); }

.page-enter-active, .page-leave-active { transition: all .2s ease; }
.page-enter-from { opacity: 0; transform: translateY(8px); }
.page-leave-to  { opacity: 0; transform: translateY(-8px); }
</style>
