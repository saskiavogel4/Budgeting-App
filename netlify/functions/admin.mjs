// Admin actions for staff. Every request re-checks the caller's role in the database.
//   employee: health, send_reset
//   admin:    everything, including set_password, suspend/unsuspend, delete, create, confirm email
import { handler, HttpError } from "../lib/plaid.mjs";
import { authAdmin, rpcAsUser, sendRecovery, serviceKey, supabaseHealth } from "../lib/supabase-admin.mjs";

const STAFF = ["admin", "employee"];
const ACTIONS = {
  health: STAFF,
  send_reset: STAFF,
  set_password: ["admin"],
  suspend: ["admin"],
  unsuspend: ["admin"],
  confirm_email: ["admin"],
  delete_user: ["admin"],
  create_user: ["admin"],
};

const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ""));
const validPassword = (p) => typeof p === "string" && p.length >= 6 && p.length <= 72;

export default handler(async (body, user, req) => {
  const token = req.headers.get("authorization").slice(7);
  const allowed = ACTIONS[body.action];
  if (!allowed) throw new HttpError(400, "BAD_ACTION", "Unknown admin action.");
  const role = await rpcAsUser(token, "my_role");
  if (!allowed.includes(role)) throw new HttpError(403, "FORBIDDEN", "You don't have permission to do that.");

  const log = (action, target, details = {}) =>
    rpcAsUser(token, "log_admin_action", { p_action: action, p_target: target || null, p_details: details }).catch(() => {});
  const target = body.userId;
  const needsTarget = !["health", "create_user", "send_reset"].includes(body.action);
  if (needsTarget && !isUuid(target)) throw new HttpError(400, "BAD_USER", "Missing user.");
  if (["suspend", "delete_user"].includes(body.action) && target === user.id) {
    throw new HttpError(400, "SELF", "You can't do that to your own account.");
  }

  switch (body.action) {
    case "health": {
      const supabase = await supabaseHealth();
      return {
        time: new Date().toISOString(),
        supabase,
        serviceKey: Boolean(serviceKey()),
        plaid: {
          configured: Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
          env: (process.env.PLAID_ENV || "sandbox").toLowerCase(),
        },
        node: process.version,
        region: process.env.AWS_REGION || null,
        site: process.env.URL || null,
      };
    }
    case "send_reset": {
      const email = String(body.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "BAD_EMAIL", "Invalid email.");
      const origin = req.headers.get("origin") || process.env.URL || new URL(req.url).origin;
      await sendRecovery(email, origin + "/");
      await log("user.reset_email", isUuid(target) ? target : null, { email });
      return { ok: true };
    }
    case "set_password": {
      if (!validPassword(body.password)) throw new HttpError(400, "BAD_PASSWORD", "Password must be 6–72 characters.");
      await authAdmin("PUT", `/users/${target}`, { password: body.password });
      await log("user.set_password", target);
      return { ok: true };
    }
    case "suspend":
      await authAdmin("PUT", `/users/${target}`, { ban_duration: "876000h" });
      await log("user.suspend", target);
      return { ok: true };
    case "unsuspend":
      await authAdmin("PUT", `/users/${target}`, { ban_duration: "none" });
      await log("user.unsuspend", target);
      return { ok: true };
    case "confirm_email":
      await authAdmin("PUT", `/users/${target}`, { email_confirm: true });
      await log("user.confirm_email", target);
      return { ok: true };
    case "delete_user": {
      const email = String(body.email || "");
      await authAdmin("DELETE", `/users/${target}`);
      await log("user.delete", null, { email, id: target });
      return { ok: true };
    }
    case "create_user": {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "BAD_EMAIL", "Invalid email.");
      if (!validPassword(body.password)) throw new HttpError(400, "BAD_PASSWORD", "Password must be 6–72 characters.");
      const created = await authAdmin("POST", "/users", { email, password: body.password, email_confirm: true });
      const newId = created.id || created.user?.id;
      if (newId && ["employee", "admin"].includes(body.role)) {
        await rpcAsUser(token, "admin_set_role", { p_user: newId, p_role: body.role });
      }
      await log("user.create", newId, { email, role: body.role || "user" });
      return { ok: true, id: newId };
    }
  }
});

export const config = { path: "/api/admin" };
