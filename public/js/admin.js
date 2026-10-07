// Admin page: monitoring, users, activity log, announcements.
// Every action is also enforced on the server (database functions + /api/admin),
// so hiding buttons here is only for convenience, never for security.
import { client, accessToken } from "./auth.js";

let ctx; // helpers from app.js: { esc, openDialog, toast, confirm, render, user, role }
const st = { tab: "overview", stats: null, users: null, log: null, health: null, announcement: null, error: null, loading: false, q: "", roleFilter: "all", loadedAt: 0 };

export function initAdmin(helpers) {
  ctx = helpers;
}

export function resetAdmin() {
  Object.assign(st, { tab: "overview", stats: null, users: null, log: null, health: null, announcement: null, error: null, loadedAt: 0 });
}

const isAdmin = () => ctx.role() === "admin";
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const fmtDateTime = (s) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Never");

function ago(s) {
  if (!s) return "Never";
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

async function rpc(fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

async function adminApi(action, payload = {}) {
  let res;
  try {
    res = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await accessToken()}` },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch {
    throw new Error("Couldn't reach the server.");
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error("The admin server function isn't running (deploy to Netlify).");
  if (!res.ok) throw new Error(data.message || "Something went wrong.");
  return data;
}

export async function loadAdmin(force = false) {
  if (st.loading || (!force && Date.now() - st.loadedAt < 30000 && st.users)) return;
  st.loading = true;
  st.error = null;
  ctx.render();
  const [stats, users, log, ann, health] = await Promise.allSettled([
    rpc("admin_stats"),
    rpc("admin_list_users"),
    client.from("admin_audit_log").select("*").order("created_at", { ascending: false }).limit(100),
    client.from("announcements").select("*").eq("active", true).order("created_at", { ascending: false }).limit(1),
    adminApi("health"),
  ]);
  st.loading = false;
  st.loadedAt = Date.now();
  if (stats.status === "rejected" || users.status === "rejected") {
    st.error = (stats.reason || users.reason)?.message || "Couldn't load admin data.";
  }
  st.stats = stats.value || st.stats;
  st.users = users.value || st.users;
  st.log = log.value?.data || [];
  st.announcement = ann.value?.data?.[0] || null;
  st.health = health.status === "fulfilled" ? health.value : { error: health.reason?.message };
  ctx.render();
}

/* ---------- Views ---------- */
export function adminView() {
  const { esc } = ctx;
  if (!["admin", "employee"].includes(ctx.role())) {
    return `<section class="card"><div class="empty"><span class="emoji">🔒</span>You don't have access to this page.</div></section>`;
  }
  if (!st.users && !st.error) {
    loadAdmin();
    return `<section class="card"><div class="empty">Loading admin data…</div></section>`;
  }
  const tabs = [
    ["overview", "Monitoring"],
    ["users", `Users${st.users ? ` (${st.users.length})` : ""}`],
    ["activity", "Activity log"],
    ...(isAdmin() ? [["announce", "Announcement"]] : []),
  ];
  const body = { overview: overviewTab, users: usersTab, activity: activityTab, announce: announceTab }[st.tab] || overviewTab;
  return `
    <div class="stack">
      <div class="admin-bar">
        <div class="segmented" role="tablist" aria-label="Admin sections">
          ${tabs.map(([id, label]) => `<button type="button" role="tab" data-action="admin-tab" data-tab="${id}" aria-pressed="${st.tab === id}">${esc(label)}</button>`).join("")}
        </div>
        <div class="admin-bar-right">
          <span class="pill ${isAdmin() ? "pill-good" : "pill-warn"}">${isAdmin() ? "Administrator" : "Employee"}</span>
          <button class="btn" data-action="admin-refresh" ${st.loading ? "disabled" : ""}>${st.loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>
      ${st.error ? `<div class="banner">${esc(st.error)}</div>` : ""}
      ${body()}
    </div>`;
}

function statTile(label, value, sub = "") {
  return `<div class="card"><div class="stat-label">${label}</div><div class="stat-value num">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ""}</div>`;
}

function signupChart(days) {
  const { esc } = ctx;
  if (!days?.length) return "";
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((s, d) => s + d.count, 0);
  const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `
    <section class="card">
      <div class="card-head"><h2>New sign-ups, last 30 days</h2><span class="muted small">${total} total</span></div>
      <div class="bars" role="img" aria-label="Daily sign-ups for the last 30 days, ${total} in total, peak ${max} in a day">
        ${days.map((d) => `<div class="bar-col" tabindex="0" data-tip="${esc(fmt(d.day))}: ${d.count} sign-up${d.count === 1 ? "" : "s"}"><span class="bar" style="height:${d.count ? Math.max(4, (d.count / max) * 100) : 0}%"></span></div>`).join("")}
      </div>
      <div class="bars-axis muted small"><span>${esc(fmt(days[0].day))}</span><span>Today</span></div>
    </section>`;
}

function healthCard() {
  const { esc } = ctx;
  const h = st.health;
  const row = (ok, label, detail) => `
    <li class="row"><span class="status-dot ${ok === true ? "ok" : ok === false ? "bad" : "warn"}" aria-hidden="true"></span>
      <div class="row-main"><div class="row-title">${label}</div><div class="row-sub">${detail}</div></div>
      <span class="pill ${ok === true ? "pill-good" : ok === false ? "pill-bad" : "pill-warn"}">${ok === true ? "OK" : ok === false ? "Problem" : "Check"}</span></li>`;
  if (!h) return "";
  if (h.error) {
    return `<section class="card"><div class="card-head"><h2>System health</h2></div><ul class="list">
      ${row(true, "Database", "Reachable (this page loaded from it)")}
      ${row(false, "Server functions", esc(h.error))}</ul></section>`;
  }
  return `
    <section class="card">
      <div class="card-head"><h2>System health</h2><span class="muted small">Checked ${esc(ago(h.time))}</span></div>
      <ul class="list">
        ${row(h.supabase.ok, "Supabase (auth & database)", h.supabase.ok ? `Responding in ${h.supabase.ms} ms` : "Not responding")}
        ${row(true, "Netlify server functions", `Running${h.region ? ` in ${esc(h.region)}` : ""} · Node ${esc(h.node)}`)}
        ${row(h.plaid.configured ? true : null, "Plaid bank connections", h.plaid.configured ? `Configured (${esc(h.plaid.env)})` : "Not configured. Users can only use demo data")}
        ${row(h.serviceKey ? true : null, "Admin account actions", h.serviceKey ? "Enabled (service key set)" : "Set password, suspend, delete and create need SUPABASE_SERVICE_ROLE_KEY in Netlify")}
      </ul>
    </section>`;
}

function overviewTab() {
  const { esc } = ctx;
  const s = st.stats || {};
  const recent = [...(st.users || [])].filter((u) => u.last_sign_in_at).sort((a, b) => (a.last_sign_in_at < b.last_sign_in_at ? 1 : -1)).slice(0, 5);
  return `
    <section class="grid grid-hero" aria-label="User stats">
      ${statTile("Total users", s.total ?? 0, `${s.profiles_completed ?? 0} completed profiles`)}
      ${statTile("New this week", s.new_7d ?? 0, `${s.new_30d ?? 0} in the last 30 days`)}
      ${statTile("Active this week", s.active_7d ?? 0, `${s.active_24h ?? 0} in the last 24 hours`)}
      ${statTile("Needs attention", (s.unconfirmed ?? 0) + (s.banned ?? 0), `${s.unconfirmed ?? 0} unconfirmed · ${s.banned ?? 0} suspended`)}
    </section>
    <div class="grid grid-2">
      <div class="stack">
        ${signupChart(s.signups_by_day)}
        ${healthCard()}
      </div>
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Roles</h2></div>
          <ul class="list">
            <li class="row"><span class="cat-icon" aria-hidden="true">🛡️</span><div class="row-main"><div class="row-title">Administrators</div><div class="row-sub">Full access</div></div><div class="row-amt num">${s.admins ?? 0}</div></li>
            <li class="row"><span class="cat-icon" aria-hidden="true">🧑‍💼</span><div class="row-main"><div class="row-title">Employees</div><div class="row-sub">View users, monitoring, send reset emails</div></div><div class="row-amt num">${s.employees ?? 0}</div></li>
            <li class="row"><span class="cat-icon" aria-hidden="true">🎓</span><div class="row-main"><div class="row-title">Users</div><div class="row-sub">Their own data only</div></div><div class="row-amt num">${s.users ?? 0}</div></li>
          </ul>
        </section>
        <section class="card">
          <div class="card-head"><h2>Recent sign-ins</h2><button class="link-btn" data-action="admin-tab" data-tab="users">All users</button></div>
          ${recent.length ? `<ul class="list">${recent.map((u) => `
            <li class="row"><span class="avatar avatar-sm" aria-hidden="true">${esc(initialsOf(u))}</span>
              <div class="row-main"><div class="row-title">${esc(u.full_name || u.email)}</div><div class="row-sub">${esc(u.email)}</div></div>
              <span class="muted small">${esc(ago(u.last_sign_in_at))}</span></li>`).join("")}</ul>` : `<div class="empty">No sign-ins yet.</div>`}
        </section>
      </div>
    </div>`;
}

function initialsOf(u) {
  const parts = (u.full_name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length) return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  return (u.email || "?")[0].toUpperCase();
}

const ROLE_LABEL = { admin: "Admin", employee: "Employee", user: "User" };
const suspended = (u) => u.banned_until && new Date(u.banned_until) > new Date();

function filteredUsers() {
  const q = st.q.trim().toLowerCase();
  return (st.users || []).filter((u) =>
    (st.roleFilter === "all" || u.role === st.roleFilter) &&
    (!q || [u.email, u.full_name, u.school, u.major].some((v) => (v || "").toLowerCase().includes(q))));
}

function usersTab() {
  const { esc } = ctx;
  const list = filteredUsers();
  return `
    <section class="card">
      <div class="toolbar">
        <input class="input" type="search" id="admin-search" placeholder="Search name, email, school" aria-label="Search users" value="${esc(st.q)}">
        <select class="input" id="admin-role-filter" aria-label="Filter by role">
          ${[["all", "All roles"], ["admin", "Admins"], ["employee", "Employees"], ["user", "Users"]].map(([v, l]) => `<option value="${v}" ${st.roleFilter === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <button class="btn" data-action="admin-export">Export CSV</button>
        ${isAdmin() ? `<button class="btn btn-primary" data-action="admin-create">+ Add user</button>` : ""}
      </div>
      ${list.length ? `<ul class="list">${list.map((u) => `
        <li><button type="button" class="row" data-action="admin-user" data-id="${esc(u.id)}">
          <span class="avatar avatar-sm" aria-hidden="true">${esc(initialsOf(u))}</span>
          <div class="row-main">
            <div class="row-title">${esc(u.full_name || u.email)}${u.id === ctx.user().id ? '<span class="tag">You</span>' : ""}</div>
            <div class="row-sub">${esc(u.email)} · Joined ${esc(fmtDate(u.created_at))} · Last sign-in ${esc(ago(u.last_sign_in_at))}</div>
          </div>
          <div class="user-pills">
            ${suspended(u) ? '<span class="pill pill-bad">Suspended</span>' : ""}
            ${!u.email_confirmed_at ? '<span class="pill pill-warn">Unconfirmed</span>' : ""}
            <span class="pill role-${u.role}">${ROLE_LABEL[u.role]}</span>
          </div>
        </button></li>`).join("")}</ul>` : `<div class="empty"><span class="emoji">🔍</span>No matching users.</div>`}
    </section>`;
}

const ACTION_LABEL = {
  "role.change": "Changed role",
  "profile.update": "Edited profile",
  "user.reset_email": "Sent password reset email",
  "user.set_password": "Set a new password",
  "user.suspend": "Suspended account",
  "user.unsuspend": "Unsuspended account",
  "user.confirm_email": "Confirmed email",
  "user.delete": "Deleted account",
  "user.create": "Created account",
  "announcement.post": "Posted announcement",
  "announcement.clear": "Removed announcement",
};

function activityTab() {
  const { esc } = ctx;
  const log = st.log || [];
  const detail = (e) => {
    const d = e.details || {};
    if (e.action === "role.change") return `${ROLE_LABEL[d.from] || d.from} → ${ROLE_LABEL[d.to] || d.to}`;
    if (e.action === "announcement.post") return `“${d.message || ""}”`;
    if (e.action === "user.create") return `as ${ROLE_LABEL[d.role] || "User"}`;
    return "";
  };
  return `
    <section class="card">
      <div class="card-head"><h2>Admin activity</h2><span class="muted small">Last ${log.length} actions</span></div>
      ${log.length ? `<ul class="list">${log.map((e) => `
        <li class="row">
          <span class="cat-icon" aria-hidden="true">📝</span>
          <div class="row-main">
            <div class="row-title">${esc(ACTION_LABEL[e.action] || e.action)}${e.target_email ? ` · ${esc(e.target_email)}` : ""}</div>
            <div class="row-sub">by ${esc(e.actor_email || "unknown")}${detail(e) ? ` · ${esc(detail(e))}` : ""}</div>
          </div>
          <span class="muted small">${esc(fmtDateTime(e.created_at))}</span>
        </li>`).join("")}</ul>` : `<div class="empty"><span class="emoji">📋</span>No admin actions yet. Role changes, password resets and other admin actions will show up here.</div>`}
    </section>`;
}

function announceTab() {
  const { esc } = ctx;
  const a = st.announcement;
  return `
    <section class="card">
      <div class="card-head"><h2>Site announcement</h2></div>
      <p class="muted small" style="margin-top:0">Shown at the top of the app for every signed-in user, e.g. planned maintenance or new features.</p>
      ${a ? `<div class="banner ${a.level === "info" ? "banner-info" : ""}" style="margin:0 0 16px">${esc(a.message)}</div>
        <button class="btn btn-danger" data-action="admin-clear-announcement">Remove current announcement</button><hr class="sep">` : ""}
      <form id="announce-form" novalidate>
        <div class="field"><label for="ann-msg">${a ? "Replace with a new message" : "Message"}</label>
          <textarea class="input" id="ann-msg" rows="3" maxlength="280" placeholder="Scheduled maintenance Sunday 2–3am ET."></textarea></div>
        <div class="field"><label for="ann-level">Style</label>
          <select class="input" id="ann-level"><option value="info">Info</option><option value="warning">Warning</option></select></div>
        <button class="btn btn-primary" type="submit">Post announcement</button>
      </form>
    </section>`;
}

/* ---------- Actions ---------- */
async function run(label, fn) {
  try {
    await fn();
    if (label) ctx.toast(label);
  } catch (err) {
    ctx.toast(err.message || "Something went wrong.");
  }
  await loadAdmin(true);
}

async function openUser(id) {
  const { esc, openDialog, confirm } = ctx;
  const u = (st.users || []).find((x) => x.id === id);
  if (!u) return;
  const me = u.id === ctx.user().id;
  const admin = isAdmin();
  const ro = admin ? "" : "disabled";
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 9 }, (_, i) => thisYear - 2 + i);
  if (u.graduation_year && !years.includes(u.graduation_year)) years.unshift(u.graduation_year);
  const result = await openDialog({
    title: u.full_name || u.email,
    body: `
      <div class="user-meta small muted">
        <div>${esc(u.email)}</div>
        <div>Joined ${esc(fmtDate(u.created_at))} · Last sign-in ${esc(fmtDateTime(u.last_sign_in_at))}</div>
        <div>${u.email_confirmed_at ? "Email confirmed" : "Email not confirmed"}${suspended(u) ? " · <strong style=\"color:var(--bad)\">Suspended</strong>" : ""}</div>
      </div>
      <div class="field"><label for="au-role">Role</label>
        <select class="input" id="au-role" ${admin && !me ? "" : "disabled"}>
          ${["user", "employee", "admin"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}
        </select>
        ${me ? '<p class="hint small muted">You can\'t change your own role.</p>' : ""}</div>
      <div class="form-grid">
        <div class="field"><label for="au-name">Full name</label><input class="input" id="au-name" maxlength="80" value="${esc(u.full_name || "")}" ${ro}></div>
        <div class="field"><label for="au-school">School</label><input class="input" id="au-school" maxlength="120" value="${esc(u.school || "")}" ${ro}></div>
        <div class="field"><label for="au-major">Major</label><input class="input" id="au-major" maxlength="80" value="${esc(u.major || "")}" ${ro}></div>
        <div class="field"><label for="au-year">Graduation year</label><select class="input" id="au-year" ${ro}><option value="">—</option>${years.map((y) => `<option ${u.graduation_year === y ? "selected" : ""}>${y}</option>`).join("")}</select></div>
        <div class="field"><label for="au-income">Monthly income</label><div class="money-input"><input class="input num" id="au-income" type="number" min="0" step="1" value="${u.monthly_income ?? ""}" ${ro}></div></div>
      </div>
      <div class="field"><label>Account actions</label>
        <div class="btn-row">
          <button class="btn" value="reset" formnovalidate>Send reset email</button>
          ${admin ? `<button class="btn" value="password" formnovalidate>Set password</button>` : ""}
          ${admin && !u.email_confirmed_at ? `<button class="btn" value="confirm" formnovalidate>Confirm email</button>` : ""}
          ${admin && !me ? `<button class="btn" value="${suspended(u) ? "unsuspend" : "suspend"}" formnovalidate>${suspended(u) ? "Unsuspend" : "Suspend"}</button>` : ""}
          ${admin && !me ? `<button class="btn btn-danger" value="delete" formnovalidate>Delete</button>` : ""}
        </div></div>`,
    actions: admin ? [{ label: "Close", value: "close" }, { label: "Save changes", value: "save", className: "btn-primary" }] : [{ label: "Close", value: "close" }],
  });

  if (result === "save") {
    const val = (sel) => document.querySelector(sel).value.trim();
    const newRole = val("#au-role");
    const fields = {
      p_full_name: val("#au-name"), p_school: val("#au-school"), p_major: val("#au-major"),
      p_graduation_year: val("#au-year") ? Number(val("#au-year")) : null,
      p_monthly_income: val("#au-income") === "" ? null : Number(val("#au-income")),
    };
    const changedProfile = fields.p_full_name !== (u.full_name || "") || fields.p_school !== (u.school || "") ||
      fields.p_major !== (u.major || "") || fields.p_graduation_year !== (u.graduation_year ?? null) ||
      fields.p_monthly_income !== (u.monthly_income == null ? null : Number(u.monthly_income));
    return run("Changes saved", async () => {
      if (!me && newRole !== u.role) await rpc("admin_set_role", { p_user: u.id, p_role: newRole });
      if (changedProfile) await rpc("admin_update_profile", { p_user: u.id, ...fields });
    });
  }
  if (result === "reset") {
    return run(`Reset email sent to ${u.email}`, () => adminApi("send_reset", { userId: u.id, email: u.email }));
  }
  if (result === "password") {
    const r = await openDialog({
      title: `Set password for ${u.email}`,
      body: `<div class="field"><label for="au-pw">New password</label><input class="input" id="au-pw" type="text" minlength="6" maxlength="72" required autocomplete="off" value="${esc(randomPassword())}"></div>
        <p class="hint small muted">At least 6 characters. Share it with the user securely; they can change it later with "Forgot password".</p>`,
      actions: [{ label: "Cancel", value: "cancel" }, { label: "Set password", value: "ok", className: "btn-primary", submit: true }],
    });
    if (r !== "ok") return;
    const pw = document.querySelector("#au-pw").value;
    return run("Password updated", () => adminApi("set_password", { userId: u.id, password: pw }));
  }
  if (result === "confirm") return run("Email confirmed", () => adminApi("confirm_email", { userId: u.id }));
  if (result === "suspend" && (await confirm("Suspend account?", `${u.email} won't be able to sign in until you unsuspend them.`, "Suspend"))) {
    return run("Account suspended", () => adminApi("suspend", { userId: u.id }));
  }
  if (result === "unsuspend") return run("Account unsuspended", () => adminApi("unsuspend", { userId: u.id }));
  if (result === "delete" && (await confirm("Delete account permanently?", `This deletes ${u.email} and their profile. It can't be undone.`, "Delete account"))) {
    return run("Account deleted", () => adminApi("delete_user", { userId: u.id, email: u.email }));
  }
}

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function createUser() {
  const { esc, openDialog } = ctx;
  const r = await openDialog({
    title: "Add a user",
    body: `
      <div class="field"><label for="cu-email">Email</label><input class="input" id="cu-email" type="email" required autocomplete="off"></div>
      <div class="field"><label for="cu-pw">Temporary password</label><input class="input" id="cu-pw" type="text" minlength="6" maxlength="72" required autocomplete="off" value="${esc(randomPassword())}"></div>
      <div class="field"><label for="cu-role">Role</label><select class="input" id="cu-role"><option value="user">User</option><option value="employee">Employee</option><option value="admin">Admin</option></select></div>
      <p class="hint small muted">The account is created already confirmed, so they can sign in right away.</p>`,
    actions: [{ label: "Cancel", value: "cancel" }, { label: "Create user", value: "ok", className: "btn-primary", submit: true }],
  });
  if (r !== "ok") return;
  const email = document.querySelector("#cu-email").value.trim();
  const password = document.querySelector("#cu-pw").value;
  const role = document.querySelector("#cu-role").value;
  return run(`Created ${email}`, () => adminApi("create_user", { email, password, role }));
}

function exportCsv() {
  const cols = ["email", "full_name", "role", "school", "major", "graduation_year", "monthly_income", "created_at", "last_sign_in_at", "email_confirmed_at", "banned_until"];
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  const csv = [cols.join(","), ...filteredUsers().map((u) => cols.map((c) => cell(u[c])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `campuscash-users-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Returns true if the action was handled here.
export async function handleAdminAction(action, el) {
  switch (action) {
    case "admin-tab":
      st.tab = el.dataset.tab;
      ctx.render();
      return true;
    case "admin-refresh":
      await loadAdmin(true);
      return true;
    case "admin-user":
      await openUser(el.dataset.id);
      return true;
    case "admin-create":
      await createUser();
      return true;
    case "admin-export":
      exportCsv();
      return true;
    case "admin-clear-announcement":
      if (await ctx.confirm("Remove announcement?", "It will disappear for all users.", "Remove")) {
        await run("Announcement removed", () => rpc("admin_clear_announcement"));
        ctx.refreshAnnouncement();
      }
      return true;
  }
  return false;
}

export function handleAdminInput(e) {
  if (e.target.id === "admin-search") {
    st.q = e.target.value;
    const pos = e.target.selectionStart;
    ctx.render();
    const input = document.querySelector("#admin-search");
    input.focus();
    input.setSelectionRange(pos, pos);
    return true;
  }
  if (e.target.id === "admin-role-filter") {
    st.roleFilter = e.target.value;
    ctx.render();
    return true;
  }
  return false;
}

export async function handleAdminSubmit(e) {
  if (e.target.id !== "announce-form") return false;
  e.preventDefault();
  const message = document.querySelector("#ann-msg").value.trim();
  if (!message) {
    ctx.toast("Write a message first.");
    return true;
  }
  const level = document.querySelector("#ann-level").value;
  await run("Announcement posted", () => rpc("admin_set_announcement", { p_message: message, p_level: level }));
  ctx.refreshAnnouncement();
  return true;
}
