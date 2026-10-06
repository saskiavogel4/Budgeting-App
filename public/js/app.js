import { CATEGORIES, category, categorizePlaid, defaultBudgets, isSpendingCategory } from "./categories.js";
import { getState, update, subscribe, reset, initStore } from "./store.js";
import { buildDemoData } from "./demo.js";
import { connectBank, reconnectBank, disconnectBank, syncAll, plaidStatus } from "./plaid.js";
import {
  currentUser, signIn, signUp, sendPasswordReset, setNewPassword, signOut,
  onAuthChange, linkErrorFromUrl, friendlyAuthError, isRecoveryLink,
} from "./auth.js";
import { loadProfile, saveProfile, firstName, initials } from "./profile.js";

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const VIEWS = { overview: "Overview", activity: "Activity", budgets: "Budgets", profile: "Profile", settings: "Settings" };
let plaidInfo = { configured: false, reachable: false, env: "sandbox" };
let busy = false;
let user = null;
let profile = null; // null while loading
let profileError = null;
let activityFilter = { q: "", cat: "all", limit: 150 };

/* ---------- Formatting ---------- */
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money = (n) => usd.format(n || 0);
const money0 = (n) => usd0.format(Math.round(n || 0));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const parseDate = (s) => new Date(`${s}T12:00:00`);
const fmtDay = (s) => parseDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtMonth = (s) => parseDate(s).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function timeAgo(isoStr) {
  if (!isoStr) return "";
  const mins = Math.round((Date.now() - new Date(isoStr).getTime()) / 60000);
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Updated ${hrs}h ago`;
  return `Updated ${Math.round(hrs / 24)}d ago`;
}

/* ---------- Derived data ---------- */
function accounts() {
  const s = getState();
  if (s.mode === "demo") return (s.demo?.accounts || []).map((a) => ({ ...a, institution: "Demo Bank" }));
  return s.items.flatMap((i) => i.accounts.map((a) => ({ ...a, institution: i.institution })));
}

function transactions() {
  const s = getState();
  const source = s.mode === "demo" ? s.demo?.transactions || [] : s.items.flatMap((i) => i.transactions);
  const acctNames = Object.fromEntries(accounts().map((a) => [a.id, a.name]));
  const all = [
    ...source.map((t) => ({ ...t, category: s.overrides[t.id] || categorizePlaid(t), account: acctNames[t.accountId] || "" })),
    ...s.manual.map((t) => ({ ...t, category: s.overrides[t.id] || t.category, account: "Cash", manual: true })),
  ];
  return all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function lastSynced() {
  const s = getState();
  if (s.mode === "demo") return s.demo?.syncedAt;
  const times = s.items.map((i) => i.syncedAt).filter(Boolean).sort();
  return times[0] || null; // oldest, so the label never overstates freshness
}

function monthSummary() {
  const month = todayISO().slice(0, 7);
  const tx = transactions().filter((t) => t.date.startsWith(month));
  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  let spent = 0;
  let income = 0;
  for (const t of tx) {
    if (t.category === "income") income -= t.amount;
    else if (isSpendingCategory(t.category)) {
      byCat[t.category] = (byCat[t.category] || 0) + t.amount;
      spent += t.amount;
    }
  }
  const budgets = getState().budgets;
  const budgetTotal = CATEGORIES.reduce((sum, c) => sum + (Number(budgets[c.id]) || 0), 0);
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = daysInMonth - now.getDate() + 1;
  const left = budgetTotal - spent;
  return { spent, income, byCat, budgetTotal, left, daysLeft, daysInMonth, safePerDay: Math.max(0, left) / daysLeft };
}

function balances() {
  let cash = 0;
  let owed = 0;
  for (const a of accounts()) {
    if (a.type === "depository") cash += a.available ?? a.current ?? 0;
    else if (a.type === "credit") owed += a.current ?? 0;
  }
  return { cash, owed };
}

/* ---------- Theme ---------- */
const media = window.matchMedia("(prefers-color-scheme: dark)");
function themePref() {
  try {
    return localStorage.getItem("campuscash:theme") || "system";
  } catch {
    return "system";
  }
}
function applyTheme(pref) {
  try {
    localStorage.setItem("campuscash:theme", pref);
  } catch {
    /* ignore */
  }
  const dark = pref === "dark" || (pref === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = pref;
  $("#theme-btn").setAttribute("aria-label", `Theme: ${pref}. Click to change.`);
  $("#theme-btn").title = `Theme: ${pref[0].toUpperCase() + pref.slice(1)}`;
}
media.addEventListener("change", () => themePref() === "system" && applyTheme("system"));
$("#theme-btn").addEventListener("click", () => {
  const next = { light: "dark", dark: "system", system: "light" }[themePref()];
  applyTheme(next);
  toast(`Theme: ${next[0].toUpperCase() + next.slice(1)}`);
  if (currentView() === "settings") render();
});

/* ---------- UI helpers ---------- */
let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
}

function openDialog({ title, body, actions }) {
  const dlg = $("#dialog");
  $("#dialog-title").textContent = title;
  $("#dialog-body").innerHTML = body;
  $("#dialog-actions").innerHTML = actions
    .map((a) => `<button class="btn ${a.className || ""}" value="${esc(a.value)}" ${a.submit ? "" : 'formnovalidate'}>${esc(a.label)}</button>`)
    .join("");
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true });
  });
}

function catIcon(id) {
  const c = category(id);
  return `<span class="cat-icon" aria-hidden="true">${c.icon}</span>`;
}

function progressBar(value, max, extraLabel = "") {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : value > 0 ? 100 : 0;
  const cls = max > 0 && value > max ? "over" : pct >= 85 ? "warn" : "";
  return `<div class="progress ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${esc(extraLabel)}"><span style="width:${pct}%"></span></div>`;
}

function txRow(t, clickable = true) {
  const c = category(t.category);
  const inflow = t.amount < 0;
  const inner = `
    ${catIcon(t.category)}
    <div class="row-main">
      <div class="row-title">${esc(t.name)}${t.pending ? '<span class="tag">Pending</span>' : ""}${t.manual ? '<span class="tag">Cash</span>' : ""}</div>
      <div class="row-sub">${esc(c.name)} · ${fmtDay(t.date)}${t.account ? ` · ${esc(t.account)}` : ""}</div>
    </div>
    <div class="row-amt num ${inflow ? "in" : ""}">${inflow ? "+" : "−"}${money(Math.abs(t.amount))}</div>`;
  return clickable
    ? `<li><button type="button" class="row" data-action="edit-tx" data-id="${esc(t.id)}">${inner}</button></li>`
    : `<li class="row">${inner}</li>`;
}

/* ---------- Views ---------- */
function welcomeView() {
  return `
    <section class="card welcome">
      <h2>Welcome to CampusCash${firstName(profile) ? `, ${esc(firstName(profile))}` : ""} 👋</h2>
      <p>Budgeting built for college life. Connect your bank to see your balances and spending,
      set simple monthly budgets, and know exactly how much you can spend today.</p>
      <div class="btn-row">
        <button class="btn btn-primary" data-action="connect">Connect your bank</button>
        <button class="btn" data-action="demo-on">Try it with demo data</button>
      </div>
      <div class="feature-list">
        <div><strong>Safe-to-spend</strong>A daily number so you don't run out before the month ends.</div>
        <div><strong>Student budgets</strong>Starter budgets for rent, food, books and fun.</div>
        <div><strong>Private</strong>Your data stays in your browser. Bank access is through Plaid.</div>
      </div>
    </section>`;
}

function overviewView() {
  const s = getState();
  if (!s.mode) return welcomeView();
  const m = monthSummary();
  const b = balances();
  const tx = transactions();
  const accts = accounts();
  const monthName = new Date().toLocaleDateString("en-US", { month: "long" });
  const topCats = CATEGORIES.map((c) => ({ ...c, spent: m.byCat[c.id] || 0, budget: Number(s.budgets[c.id]) || 0 }))
    .filter((c) => c.spent > 0)
    .sort((a, b2) => b2.spent - a.spent)
    .slice(0, 6);

  const leftPill = m.left >= 0
    ? `<span class="pill pill-good">On track</span>`
    : `<span class="pill pill-bad">Over by ${money0(-m.left)}</span>`;

  const name = firstName(profile);
  return `
    <div class="stack">
      ${name ? `<p class="greeting">Hi, ${esc(name)} 👋</p>` : ""}
      <section class="grid grid-hero" aria-label="Summary">
        <div class="card stat-hero">
          <div class="stat-label">Safe to spend today</div>
          <div class="stat-value num">${money0(m.safePerDay)}</div>
          <div class="stat-sub">${m.daysLeft} day${m.daysLeft === 1 ? "" : "s"} left in ${monthName}</div>
          <div style="margin-top:12px">${progressBar(m.spent, m.budgetTotal, "Monthly budget used")}</div>
        </div>
        <div class="card">
          <div class="stat-label">Left this month</div>
          <div class="stat-value num">${money0(Math.max(0, m.left))}</div>
          <div class="stat-sub">${money0(m.spent)} of ${money0(m.budgetTotal)} spent · ${leftPill}</div>
        </div>
        <div class="card">
          <div class="stat-label">Cash available</div>
          <div class="stat-value num">${money0(b.cash)}</div>
          <div class="stat-sub">Checking + savings</div>
        </div>
        <div class="card">
          <div class="stat-label">${b.owed > 0 ? "Credit card balance" : `Income in ${monthName}`}</div>
          <div class="stat-value num">${money0(b.owed > 0 ? b.owed : m.income)}</div>
          <div class="stat-sub">${b.owed > 0 ? "Pay in full to avoid interest" : "Paychecks & deposits"}</div>
        </div>
      </section>

      <div class="grid grid-2">
        <div class="stack">
          <section class="card">
            <div class="card-head"><h2>Spending in ${monthName}</h2><a href="#/budgets">Edit budgets</a></div>
            ${topCats.length
              ? topCats.map((c) => `
                <div class="cat-bar">
                  ${catIcon(c.id)}
                  <div>
                    <div class="cat-bar-top"><strong>${esc(c.name)}</strong><span class="num muted">${money0(c.spent)} / ${money0(c.budget)}</span></div>
                    ${progressBar(c.spent, c.budget, c.name)}
                  </div>
                </div>`).join("")
              : `<div class="empty"><span class="emoji">🌱</span>No spending yet this month.</div>`}
          </section>
          <section class="card">
            <div class="card-head"><h2>Recent activity</h2><a href="#/activity">See all</a></div>
            ${tx.length ? `<ul class="list">${tx.slice(0, 6).map((t) => txRow(t)).join("")}</ul>` : `<div class="empty"><span class="emoji">🧾</span>No transactions yet. New banks can take a minute to load.</div>`}
          </section>
        </div>
        <div class="stack">
          <section class="card">
            <div class="card-head"><h2>Accounts</h2>${s.mode === "plaid" ? `<button class="link-btn" data-action="connect">+ Add bank</button>` : ""}</div>
            ${accts.length
              ? `<ul class="list">${accts.map((a) => `
                <li class="row">
                  <span class="cat-icon" aria-hidden="true">${a.type === "credit" ? "💳" : a.subtype === "savings" ? "🐷" : "🏦"}</span>
                  <div class="row-main">
                    <div class="row-title">${esc(a.name)}</div>
                    <div class="row-sub">${esc(a.institution)}${a.mask ? ` ···${esc(a.mask)}` : ""}</div>
                  </div>
                  <div class="row-amt num">${a.type === "credit" ? "−" : ""}${money(a.type === "credit" ? a.current : a.available ?? a.current)}</div>
                </li>`).join("")}</ul>`
              : `<div class="empty">No accounts yet.</div>`}
          </section>
          <section class="card">
            <div class="card-head"><h2>Paid with cash?</h2></div>
            <p class="muted small" style="margin:0 0 12px">Add cash or Venmo spending your bank can't see so your budget stays accurate.</p>
            <button class="btn" data-action="add-cash">+ Add expense</button>
          </section>
        </div>
      </div>
    </div>`;
}

function activityView() {
  const s = getState();
  if (!s.mode) return welcomeView();
  const q = activityFilter.q.trim().toLowerCase();
  const all = transactions().filter((t) =>
    (activityFilter.cat === "all" || t.category === activityFilter.cat) &&
    (!q || t.name.toLowerCase().includes(q) || category(t.category).name.toLowerCase().includes(q))
  );
  const shown = all.slice(0, activityFilter.limit);
  let html = "";
  let currentMonth = "";
  for (const t of shown) {
    const mk = t.date.slice(0, 7);
    if (mk !== currentMonth) {
      if (currentMonth) html += "</ul>";
      currentMonth = mk;
      html += `<div class="month-head">${fmtMonth(t.date)}</div><ul class="list">`;
    }
    html += txRow(t);
  }
  if (currentMonth) html += "</ul>";

  const catOptions = [...CATEGORIES, category("income"), category("transfer")]
    .map((c) => `<option value="${c.id}" ${activityFilter.cat === c.id ? "selected" : ""}>${c.icon} ${esc(c.name)}</option>`)
    .join("");

  return `
    <section class="card">
      <div class="toolbar">
        <input class="input" type="search" id="tx-search" placeholder="Search transactions" aria-label="Search transactions" value="${esc(activityFilter.q)}">
        <select class="input" id="tx-cat" aria-label="Filter by category"><option value="all">All categories</option>${catOptions}</select>
        <button class="btn" data-action="add-cash">+ Add expense</button>
      </div>
      ${shown.length ? html : `<div class="empty"><span class="emoji">🔍</span>No matching transactions.</div>`}
      ${all.length > shown.length ? `<div style="text-align:center;margin-top:12px"><button class="btn" data-action="more">Show more (${all.length - shown.length} left)</button></div>` : ""}
    </section>`;
}

function incomeNote(m) {
  const planned = profile?.monthly_income;
  if (planned > 0) {
    const pct = Math.round((m.budgetTotal / planned) * 100);
    const over = m.budgetTotal > planned;
    return `Your budget is <strong>${pct}%</strong> of your ${money0(planned)} monthly income${over ? ` <span class="pill pill-warn">over by ${money0(m.budgetTotal - planned)}</span>` : ""}. `;
  }
  const earned = m.income > 0 ? `You've brought in ${money0(m.income)} this month. ` : "";
  return `${earned}<a href="#/profile">Add your monthly income</a> to compare it with your budget. `;
}

function budgetsView() {
  const s = getState();
  const m = monthSummary();
  const monthName = new Date().toLocaleDateString("en-US", { month: "long" });
  return `
    <div class="stack">
      <section class="card">
        <div class="card-head">
          <h2>${monthName} budget</h2>
          ${m.left >= 0 ? `<span class="pill pill-good">${money0(m.left)} left</span>` : `<span class="pill pill-bad">${money0(-m.left)} over</span>`}
        </div>
        <div class="stat-value num">${money0(m.spent)} <span class="muted" style="font-size:16px;font-weight:500">of ${money0(m.budgetTotal)}</span></div>
        <div style="margin:12px 0 8px">${progressBar(m.spent, m.budgetTotal, "Total budget used")}</div>
        <div class="muted small">${incomeNote(m)}Tip: a common student rule of thumb is 50% needs, 30% wants, 20% savings.</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Monthly limits</h2><button class="link-btn" data-action="reset-budgets">Reset to defaults</button></div>
        ${CATEGORIES.map((c) => {
          const spent = m.byCat[c.id] || 0;
          const budget = Number(s.budgets[c.id]) || 0;
          return `
            <div class="budget-row">
              ${catIcon(c.id)}
              <div style="min-width:0">
                <div class="cat-bar-top"><strong>${esc(c.name)}</strong><span class="num muted small">${money0(spent)} spent</span></div>
                ${progressBar(spent, budget, c.name)}
              </div>
              <div class="money-input"><input class="input num" type="number" inputmode="decimal" min="0" step="5" data-budget="${c.id}" value="${budget}" aria-label="${esc(c.name)} monthly budget"></div>
            </div>`;
        }).join("")}
      </section>
    </div>`;
}

function settingsView() {
  const s = getState();
  const pref = themePref();
  const themeBtn = (id, label, icon) => `<button type="button" data-action="theme" data-theme="${id}" aria-pressed="${pref === id}">${icon}${label}</button>`;
  const banks = s.items.map((i) => `
    <li class="row">
      <span class="cat-icon" aria-hidden="true">🏦</span>
      <div class="row-main">
        <div class="row-title">${esc(i.institution)}</div>
        <div class="row-sub">${i.error ? `<span style="color:var(--bad)">${esc(i.error.message)}</span>` : `${i.accounts.length} account${i.accounts.length === 1 ? "" : "s"} · ${timeAgo(i.syncedAt) || "Not synced yet"}`}</div>
      </div>
      <div class="btn-row">
        ${i.error ? `<button class="btn" data-action="reconnect" data-id="${esc(i.itemId)}">Reconnect</button>` : ""}
        <button class="btn btn-danger" data-action="disconnect" data-id="${esc(i.itemId)}">Disconnect</button>
      </div>
    </li>`).join("");

  return `
    <div class="stack">
      <section class="card settings-section">
        <div class="card-head"><h2>Appearance</h2></div>
        <p>Choose a theme. “System” follows your device's light or dark mode.</p>
        <div class="segmented" role="group" aria-label="Theme">
          ${themeBtn("light", "Light", '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>')}
          ${themeBtn("dark", "Dark", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>')}
          ${themeBtn("system", "System", '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>')}
        </div>
      </section>

      <section class="card settings-section">
        <div class="card-head"><h2>Bank connections</h2>${plaidInfo.reachable ? `<span class="pill ${plaidInfo.configured ? "pill-good" : "pill-warn"}">Plaid ${plaidInfo.configured ? plaidInfo.env : "not set up"}</span>` : ""}</div>
        <p>Banks connect securely through Plaid. CampusCash never sees your bank password.
        ${plaidInfo.configured && plaidInfo.env === "sandbox" ? "<br><strong>Sandbox mode:</strong> use the test login <code>user_good</code> / <code>pass_good</code>." : ""}</p>
        ${banks ? `<ul class="list" style="margin-bottom:14px">${banks}</ul>` : ""}
        <div class="btn-row">
          <button class="btn btn-primary" data-action="connect">${s.items.length ? "Connect another bank" : "Connect a bank"}</button>
          ${s.mode === "demo" ? `<button class="btn" data-action="demo-off">Exit demo mode</button>` : `<button class="btn" data-action="demo-on">Use demo data</button>`}
        </div>
      </section>

      <section class="card settings-section">
        <div class="card-head"><h2>Account</h2></div>
        <p>Signed in as <span class="account-email">${esc(user?.email || "")}</span></p>
        <div class="btn-row">
          <a class="btn" href="#/profile">Edit profile</a>
          <button class="btn" data-action="sign-out">Sign out</button>
        </div>
      </section>

      <section class="card settings-section">
        <div class="card-head"><h2>Your data</h2></div>
        <p>Budgets, cash expenses and cached bank data are stored only in this browser.</p>
        <button class="btn btn-danger" data-action="clear">Clear all data</button>
      </section>
    </div>`;
}

function profileView() {
  if (profileError && !profile) {
    return `
      <section class="card"><div class="empty"><span class="emoji">⚠️</span>Couldn't load your profile. ${esc(profileError)}
      <div style="margin-top:12px"><button class="btn" data-action="reload-profile">Try again</button></div></div></section>`;
  }
  if (!profile) return `<section class="card"><div class="empty">Loading your profile…</div></section>`;
  const p = profile;
  const isNew = !p.full_name;
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 9 }, (_, i) => thisYear - 2 + i);
  if (p.graduation_year && !years.includes(p.graduation_year)) years.push(p.graduation_year);
  years.sort((a, b) => a - b);
  return `
    <div class="stack profile-page">
      <section class="card profile-header">
        <span class="avatar avatar-lg" aria-hidden="true">${esc(initials(p, user?.email))}</span>
        <div style="min-width:0">
          <h2>${esc(p.full_name || "Your profile")}</h2>
          <div class="muted small account-email">${esc(user?.email || "")}</div>
          ${p.school || p.major ? `<div class="muted small">${esc([p.major, p.school].filter(Boolean).join(" · "))}${p.graduation_year ? ` · Class of ${p.graduation_year}` : ""}</div>` : ""}
        </div>
      </section>
      ${isNew ? `<div class="banner banner-info">👋 Welcome! Tell us a bit about yourself so CampusCash can personalize your budget.</div>` : ""}
      <form class="card" id="profile-form" novalidate>
        <div class="card-head"><h2>About you</h2></div>
        <div class="form-grid">
          <div class="field">
            <label for="pf-name">Full name</label>
            <input class="input" id="pf-name" name="full_name" autocomplete="name" maxlength="80" required value="${esc(p.full_name)}" placeholder="Alex Rivera">
          </div>
          <div class="field">
            <label for="pf-school">School</label>
            <input class="input" id="pf-school" name="school" autocomplete="organization" maxlength="120" value="${esc(p.school)}" placeholder="University of Florida">
          </div>
          <div class="field">
            <label for="pf-major">Major</label>
            <input class="input" id="pf-major" name="major" maxlength="80" value="${esc(p.major)}" placeholder="Business">
          </div>
          <div class="field">
            <label for="pf-year">Graduation year</label>
            <select class="input" id="pf-year" name="graduation_year">
              <option value="">Select a year</option>
              ${years.map((y) => `<option value="${y}" ${p.graduation_year === y ? "selected" : ""}>${y}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="pf-income">Monthly income</label>
            <div class="money-input"><input class="input num" id="pf-income" name="monthly_income" type="number" inputmode="decimal" min="0" max="1000000" step="1" value="${p.monthly_income ?? ""}" placeholder="0"></div>
            <p class="hint small muted">Jobs, financial aid, family help. Used to check your budget fits.</p>
          </div>
        </div>
        <p class="auth-error" id="profile-error" role="alert" hidden></p>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit" id="profile-save">${isNew ? "Save profile" : "Save changes"}</button>
          ${isNew ? `<a class="btn" href="#/overview" data-action="skip-profile">Skip for now</a>` : ""}
        </div>
        ${p.updated_at && !isNew ? `<p class="muted small" style="margin:12px 0 0">Last updated ${new Date(p.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>` : ""}
      </form>
    </div>`;
}

async function fetchProfile() {
  const uid = user?.id;
  profileError = null;
  try {
    const p = await loadProfile(uid);
    if (user?.id !== uid) return;
    profile = p;
  } catch (err) {
    console.error(err);
    profileError = friendlyAuthError(err);
  }
  render();
  updateAvatar();
  // First visit: send new users to their profile once.
  if (profile && !profile.full_name && currentView() === "overview") {
    let skipped = false;
    try {
      skipped = localStorage.getItem(`campuscash:profile-skipped:${uid}`) === "1";
    } catch {
      /* ignore */
    }
    if (!skipped) location.hash = "#/profile";
  }
}

function updateAvatar() {
  const label = user ? initials(profile, user.email) : "";
  document.querySelectorAll("[data-avatar]").forEach((el) => (el.textContent = label));
}

view.addEventListener("submit", async (e) => {
  if (e.target.id !== "profile-form") return;
  e.preventDefault();
  const f = e.target.elements;
  const fullName = f.full_name.value.trim();
  if (!fullName) {
    showError("#profile-error", "Please enter your name.");
    return f.full_name.focus();
  }
  const income = f.monthly_income.value.trim();
  if (income && !(Number(income) >= 0 && Number(income) <= 1000000)) {
    return showError("#profile-error", "Monthly income must be between $0 and $1,000,000.");
  }
  const fields = {
    full_name: fullName,
    school: f.school.value.trim() || null,
    major: f.major.value.trim() || null,
    graduation_year: f.graduation_year.value ? Number(f.graduation_year.value) : null,
    monthly_income: income === "" ? null : Math.round(Number(income) * 100) / 100,
  };
  const wasNew = !profile?.full_name;
  await submitting($("#profile-save"), "Saving…", async () => {
    try {
      profile = await saveProfile(user.id, fields);
      updateAvatar();
      toast(wasNew ? "Profile created!" : "Profile saved");
      if (wasNew) location.hash = "#/overview";
      else render();
    } catch (err) {
      showError("#profile-error", friendlyAuthError(err));
    }
  });
});

/* ---------- Render ---------- */
function currentView() {
  const v = location.hash.replace(/^#\/?/, "");
  return VIEWS[v] ? v : "overview";
}

function render() {
  if (!user) return;
  const v = currentView();
  const s = getState();
  document.title = `${VIEWS[v]} · CampusCash`;
  $("#view-title").textContent = VIEWS[v];
  document.querySelectorAll("[data-view]").forEach((a) => {
    if (a.dataset.view === v) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  view.innerHTML = { overview: overviewView, activity: activityView, budgets: budgetsView, profile: profileView, settings: settingsView }[v]();

  $("#sync-btn").hidden = !s.mode;
  $("#sync-label").textContent = s.mode ? timeAgo(lastSynced()) : "";

  const banner = $("#banner");
  const broken = s.mode === "plaid" ? s.items.find((i) => i.error) : null;
  if (s.mode === "demo") {
    banner.innerHTML = `You're viewing <strong>demo data</strong>. <button class="link-btn" data-action="connect">Connect your bank</button>`;
    banner.hidden = false;
  } else if (broken) {
    banner.innerHTML = `${esc(broken.institution)}: ${esc(broken.error.message)} <button class="link-btn" data-action="${broken.error.code === "ITEM_LOGIN_REQUIRED" ? "reconnect" : "sync"}" data-id="${esc(broken.itemId)}">${broken.error.code === "ITEM_LOGIN_REQUIRED" ? "Reconnect" : "Retry"}</button>`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

// Mobile tab bar mirrors the sidebar nav.
$("#tabbar").innerHTML = $("#nav").innerHTML;

/* ---------- Actions ---------- */
async function withBusy(fn) {
  if (busy) return;
  busy = true;
  $("#sync-btn").classList.add("spinning");
  try {
    await fn();
  } catch (err) {
    console.error(err);
    if (err.code === "NOT_SIGNED_IN") {
      await signOut();
      showSignedOut(err.message);
    } else if (err.code === "NOT_CONFIGURED" || err.code === "NO_FUNCTIONS") showSetupHelp(err);
    else toast(err.message || "Something went wrong.");
  } finally {
    busy = false;
    $("#sync-btn").classList.remove("spinning");
    render();
  }
}

function showSetupHelp(err) {
  openDialog({
    title: "Connect Plaid to use real bank data",
    body: `
      <p class="muted">${esc(err?.message || "")}</p>
      <ol class="small" style="padding-left:18px;line-height:1.7">
        <li>Create a free account at <a href="https://dashboard.plaid.com/signup" target="_blank" rel="noopener">dashboard.plaid.com</a>.</li>
        <li>Copy your <strong>client_id</strong> and <strong>Sandbox secret</strong> from <em>Developers → Keys</em>.</li>
        <li>In Netlify, go to <em>Site configuration → Environment variables</em> and add <code>PLAID_CLIENT_ID</code>, <code>PLAID_SECRET</code>, and <code>PLAID_ENV=sandbox</code>.</li>
        <li>Redeploy the site, then click <em>Connect a bank</em> again.</li>
      </ol>
      <p class="muted small">Until then, you can explore everything with demo data.</p>`,
    actions: [
      { label: "Close", value: "close" },
      { label: "Use demo data", value: "demo", className: "btn-primary" },
    ],
  }).then((v) => v === "demo" && enableDemo());
}

function enableDemo() {
  update((s) => {
    s.mode = "demo";
    s.demo = buildDemoData();
  });
  toast("Demo data loaded");
}

async function addCashExpense() {
  const options = CATEGORIES.map((c) => `<option value="${c.id}">${c.icon} ${esc(c.name)}</option>`).join("");
  const result = await openDialog({
    title: "Add an expense",
    body: `
      <div class="field"><label for="cx-name">What was it?</label><input class="input" id="cx-name" required maxlength="60" placeholder="e.g. Pizza with roommates"></div>
      <div class="field"><label for="cx-amt">Amount</label><div class="money-input"><input class="input num" id="cx-amt" type="number" inputmode="decimal" min="0.01" step="0.01" required placeholder="0.00"></div></div>
      <div class="field"><label for="cx-cat">Category</label><select class="input" id="cx-cat">${options}</select></div>
      <div class="field"><label for="cx-date">Date</label><input class="input" id="cx-date" type="date" required value="${todayISO()}" max="${todayISO()}"></div>`,
    actions: [
      { label: "Cancel", value: "cancel" },
      { label: "Add expense", value: "save", className: "btn-primary", submit: true },
    ],
  });
  if (result !== "save") return;
  const amount = Math.round(parseFloat($("#cx-amt").value) * 100) / 100;
  const name = $("#cx-name").value.trim();
  if (!name || !(amount > 0)) return;
  update((s) => {
    s.manual.push({ id: `cash-${Date.now()}`, name, amount, date: $("#cx-date").value || todayISO(), category: $("#cx-cat").value, pending: false });
  });
  toast("Expense added");
}

async function editTransaction(id) {
  const t = transactions().find((x) => x.id === id);
  if (!t) return;
  const options = [...CATEGORIES, category("income"), category("transfer")]
    .map((c) => `<option value="${c.id}" ${t.category === c.id ? "selected" : ""}>${c.icon} ${esc(c.name)}</option>`)
    .join("");
  const result = await openDialog({
    title: t.name,
    body: `
      <p class="muted" style="margin-top:-6px">${fmtDay(t.date)} · ${t.amount < 0 ? "+" : "−"}${money(Math.abs(t.amount))}${t.account ? ` · ${esc(t.account)}` : ""}</p>
      <div class="field"><label for="tx-cat-edit">Category</label><select class="input" id="tx-cat-edit">${options}</select></div>`,
    actions: [
      ...(t.manual ? [{ label: "Delete", value: "delete", className: "btn-danger" }] : []),
      { label: "Cancel", value: "cancel" },
      { label: "Save", value: "save", className: "btn-primary" },
    ],
  });
  if (result === "save") {
    const cat = $("#tx-cat-edit").value;
    update((s) => {
      s.overrides[id] = cat;
    });
  } else if (result === "delete") {
    update((s) => {
      s.manual = s.manual.filter((m) => m.id !== id);
      delete s.overrides[id];
    });
    toast("Expense deleted");
  }
}

async function confirm(title, message, label) {
  const v = await openDialog({
    title,
    body: `<p class="muted">${esc(message)}</p>`,
    actions: [
      { label: "Cancel", value: "cancel" },
      { label, value: "ok", className: "btn-primary" },
    ],
  });
  return v === "ok";
}

async function refresh() {
  const s = getState();
  if (s.mode === "demo") {
    update((st) => {
      st.demo = buildDemoData();
    });
    toast("Demo data refreshed");
  } else if (s.mode === "plaid") {
    await withBusy(async () => {
      await syncAll();
      toast("Up to date");
    });
  }
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;
  switch (action) {
    case "connect":
      if (plaidInfo.reachable && !plaidInfo.configured) return showSetupHelp();
      return withBusy(async () => {
        if (await connectBank()) {
          if (getState().mode === "plaid") toast("Bank connected!");
          location.hash = "#/overview";
        }
      });
    case "reconnect":
      return withBusy(async () => {
        if (await reconnectBank(id)) toast("Bank reconnected");
      });
    case "sync":
      return refresh();
    case "disconnect": {
      const item = getState().items.find((i) => i.itemId === id);
      if (await confirm("Disconnect bank?", `Remove ${item?.institution || "this bank"} and its transactions from CampusCash?`, "Disconnect")) {
        await withBusy(async () => {
          await disconnectBank(id);
          toast("Bank disconnected");
        });
      }
      return;
    }
    case "demo-on":
      return enableDemo();
    case "demo-off":
      update((s) => {
        s.demo = null;
        s.mode = s.items.length ? "plaid" : null;
      });
      return toast("Demo mode off");
    case "theme":
      applyTheme(el.dataset.theme);
      return render();
    case "reload-profile":
      return fetchProfile();
    case "skip-profile":
      try {
        localStorage.setItem(`campuscash:profile-skipped:${user.id}`, "1");
      } catch {
        /* ignore */
      }
      return;
    case "sign-out":
      await signOut();
      return;
    case "add-cash":
      return addCashExpense();
    case "edit-tx":
      return editTransaction(id);
    case "more":
      activityFilter.limit += 150;
      return render();
    case "reset-budgets":
      if (await confirm("Reset budgets?", "Set every category back to the starter student budget?", "Reset")) {
        update((s) => {
          s.budgets = defaultBudgets();
        });
      }
      return;
    case "clear":
      if (await confirm("Clear all data?", "This removes budgets, cash expenses, and bank connections from this browser.", "Clear everything")) {
        const items = [...getState().items];
        await Promise.allSettled(items.map((i) => disconnectBank(i.itemId)));
        reset();
        toast("All data cleared");
        location.hash = "#/overview";
      }
      return;
  }
});

$("#sync-btn").addEventListener("click", refresh);

view.addEventListener("input", (e) => {
  if (e.target.id === "tx-search") {
    activityFilter.q = e.target.value;
    activityFilter.limit = 150;
    const pos = e.target.selectionStart;
    render();
    const input = $("#tx-search");
    input.focus();
    input.setSelectionRange(pos, pos);
  }
});

view.addEventListener("change", (e) => {
  if (e.target.id === "tx-cat") {
    activityFilter.cat = e.target.value;
    activityFilter.limit = 150;
    render();
  } else if (e.target.dataset.budget) {
    const val = Math.max(0, parseFloat(e.target.value) || 0);
    update((s) => {
      s.budgets[e.target.dataset.budget] = val;
    });
  }
});

window.addEventListener("hashchange", () => {
  render();
  window.scrollTo(0, 0);
});
subscribe(render);
setInterval(() => getState().mode && ($("#sync-label").textContent = timeAgo(lastSynced())), 60000);

/* ---------- Sign-in ---------- */
const authForm = $("#auth-form");
const AUTH_PANELS = ["#auth-form", "#auth-forgot", "#auth-reset", "#auth-message"];
let recovering = isRecoveryLink;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function showPanel(id) {
  AUTH_PANELS.forEach((p) => ($(p).hidden = p !== id));
  document.querySelectorAll(".auth-error").forEach((el) => (el.hidden = true));
  const first = $(`${id} input`);
  if (first && !first.value) first.focus();
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg || "";
  el.hidden = !msg;
}

function showMessage(title, text) {
  $("#auth-message-title").textContent = title;
  $("#auth-message-text").textContent = text;
  showPanel("#auth-message");
}

function setAuthMode(mode) {
  const signup = mode === "signup";
  authForm.dataset.mode = mode;
  $("#auth-title").textContent = signup ? "Create your account" : "Sign in";
  $("#auth-subtitle").textContent = signup ? "Start budgeting in under a minute." : "Welcome back! Sign in to see your budget.";
  $("#auth-submit").textContent = signup ? "Create account" : "Sign in";
  $("#auth-switch-text").textContent = signup ? "Already have an account?" : "New here?";
  $("#auth-switch").textContent = signup ? "Sign in" : "Create an account";
  $("#auth-password").autocomplete = signup ? "new-password" : "current-password";
  $("#auth-password-hint").hidden = !signup;
  showError("#auth-error", "");
}

function showSignedOut(message) {
  user = null;
  profile = null;
  document.body.className = "signed-out";
  document.title = "Sign in · CampusCash";
  if (recovering) {
    showPanel("#auth-reset");
    return;
  }
  setAuthMode("signin");
  showPanel("#auth-form");
  showError("#auth-error", message);
}

function startApp(u) {
  const switched = user?.id !== u.id;
  user = u;
  document.body.className = "signed-in";
  if (!switched) return;
  initStore(u.id);
  profile = null;
  render();
  updateAvatar();
  fetchProfile();
  plaidStatus().then((info) => {
    plaidInfo = info;
    if (currentView() === "settings") render();
    // Refresh live bank data if it's more than 15 minutes old.
    const s = getState();
    const stale = !lastSynced() || Date.now() - new Date(lastSynced()).getTime() > 15 * 60000;
    if (s.mode === "plaid" && info.configured && stale) withBusy(syncAll);
  });
}

// Disables a form's submit button while a request runs.
async function submitting(button, busyLabel, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const signup = authForm.dataset.mode === "signup";
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!EMAIL_RE.test(email)) return showError("#auth-error", "Enter a valid email address.");
  if (!password) return showError("#auth-error", "Enter your password.");
  if (signup && password.length < 6) return showError("#auth-error", "Password must be at least 6 characters.");
  showError("#auth-error", "");
  await submitting($("#auth-submit"), signup ? "Creating account…" : "Signing in…", async () => {
    try {
      if (signup) {
        const signedIn = await signUp(email, password);
        if (!signedIn) {
          showMessage("Confirm your email", `We sent a confirmation link to ${email}. Click it, then come back and sign in.`);
        }
      } else {
        await signIn(email, password);
      }
      $("#auth-password").value = "";
    } catch (err) {
      showError("#auth-error", friendlyAuthError(err));
    }
  });
});

$("#auth-switch").addEventListener("click", () => {
  setAuthMode(authForm.dataset.mode === "signup" ? "signin" : "signup");
  $("#auth-email").focus();
});

$("#auth-forgot-link").addEventListener("click", () => {
  $("#forgot-email").value = $("#auth-email").value.trim();
  showPanel("#auth-forgot");
});

$("#auth-forgot").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#forgot-email").value.trim();
  if (!EMAIL_RE.test(email)) return showError("#forgot-error", "Enter a valid email address.");
  await submitting($("#forgot-submit"), "Sending…", async () => {
    try {
      await sendPasswordReset(email);
      showMessage("Check your email", `If an account exists for ${email}, we sent a link to reset your password.`);
    } catch (err) {
      showError("#forgot-error", friendlyAuthError(err));
    }
  });
});

$("#auth-reset").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("#reset-password").value;
  if (password.length < 6) return showError("#reset-error", "Password must be at least 6 characters.");
  await submitting($("#reset-submit"), "Saving…", async () => {
    try {
      await setNewPassword(password);
      recovering = false;
      $("#reset-password").value = "";
      const u = await currentUser();
      if (u) {
        startApp(u);
        toast("Password updated");
      } else {
        showSignedOut("Password updated. Please sign in.");
      }
    } catch (err) {
      showError("#reset-error", /session|jwt|expired/i.test(err?.message || "")
        ? "This reset link has expired. Request a new one."
        : friendlyAuthError(err));
    }
  });
});

document.querySelectorAll("[data-auth-back]").forEach((btn) =>
  btn.addEventListener("click", () => {
    setAuthMode("signin");
    showPanel("#auth-form");
  })
);

document.querySelectorAll("[data-toggle-password]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const input = $(`#${btn.dataset.togglePassword}`);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  })
);

/* ---------- Boot ---------- */
applyTheme(themePref());
const linkError = linkErrorFromUrl();
onAuthChange((event, u) => {
  if (event === "PASSWORD_RECOVERY") {
    recovering = true;
    showSignedOut();
  } else if (u && !recovering) startApp(u);
  else if (event === "SIGNED_OUT") showSignedOut();
});
currentUser().then((u) => {
  // Drop any leftover tokens from email links out of the address bar.
  if (/access_token|refresh_token/.test(location.hash)) history.replaceState(null, "", "/#/overview");
  if (u && !recovering) startApp(u);
  else showSignedOut(linkError ? `That email link didn't work (${linkError}). Please try again.` : "");
});
