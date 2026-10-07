// Server-side helpers for the Admin page. Privileged account actions (set password,
// suspend, delete, create) use the Supabase service key, which only lives in Netlify.
import { SUPABASE_URL, SUPABASE_KEY } from "../../public/js/config.js";
import { HttpError } from "./plaid.mjs";

const url = () => process.env.SUPABASE_URL || SUPABASE_URL;

export function serviceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
}

function serviceHeaders() {
  const k = serviceKey();
  if (!k) {
    throw new HttpError(503, "NO_SERVICE_KEY",
      "This action needs the SUPABASE_SERVICE_ROLE_KEY environment variable in Netlify. See the README.");
  }
  // New-style secret keys (sb_secret_...) go only in the apikey header.
  return k.startsWith("sb_secret_") ? { apikey: k } : { apikey: k, Authorization: `Bearer ${k}` };
}

async function parse(res, fallback) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HttpError(res.status >= 500 ? 502 : 400, data.error_code || data.code || "SUPABASE_ERROR",
      data.msg || data.message || data.error_description || fallback);
  }
  return data;
}

// Supabase Auth admin API (service key).
export async function authAdmin(method, path, body) {
  const res = await fetch(`${url()}/auth/v1/admin${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...serviceHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  return parse(res, "Supabase admin request failed.");
}

// Calls a database function as the signed-in user (their role is checked in SQL).
export async function rpcAsUser(token, fn, args = {}) {
  const res = await fetch(`${url()}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  return parse(res, `Database call ${fn} failed.`);
}

export async function sendRecovery(email, redirectTo) {
  const res = await fetch(`${url()}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify({ email }),
  });
  return parse(res, "Couldn't send the reset email.");
}

export async function supabaseHealth() {
  const start = Date.now();
  try {
    const res = await fetch(`${url()}/auth/v1/health`, { headers: { apikey: SUPABASE_KEY } });
    return { ok: res.ok, ms: Date.now() - start };
  } catch {
    return { ok: false, ms: Date.now() - start };
  }
}
