import { createRouter, createWebHashHistory } from "vue-router";
import Dashboard   from "./pages/Dashboard.vue";
import Invoices    from "./pages/Invoices.vue";
import Payments    from "./pages/Payments.vue";
import Banking     from "./pages/Banking.vue";
import Accounts    from "./pages/Accounts.vue";
import Reports     from "./pages/Reports.vue";

const routes = [
  { path: "/",         component: Dashboard,  name: "dashboard" },
  { path: "/invoices", component: Invoices,   name: "invoices"  },
  { path: "/payments", component: Payments,   name: "payments"  },
  { path: "/banking",  component: Banking,    name: "banking"   },
  { path: "/accounts", component: Accounts,   name: "accounts"  },
  { path: "/reports",  component: Reports,    name: "reports"   },
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
});
