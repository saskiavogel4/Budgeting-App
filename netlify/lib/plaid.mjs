// Shared helpers for the Plaid-backed Netlify Functions.
// Secrets (PLAID_CLIENT_ID / PLAID_SECRET) only ever live here, on the server.
import crypto from "node:crypto";

const HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function plaidConfig() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = (process.env.PLAID_ENV || "sandbox").toLowerCase();
  if (!clientId || !secret) {
    throw new HttpError(
      503,
      "NOT_CONFIGURED",
      "Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET in your Netlify environment variables."
    );
  }
  if (!HOSTS[env]) {
    throw new HttpError(500, "BAD_ENV", `PLAID_ENV must be "sandbox" or "production" (got "${env}").`);
  }
  return { clientId, secret, env, host: HOSTS[env] };
}

export async function plaid(path, body = {}) {
  const { clientId, secret, host } = plaidConfig();
  const res = await fetch(host + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HttpError(
      res.status >= 500 ? 502 : 400,
      data.error_code || "PLAID_ERROR",
      data.display_message || data.error_message || `Plaid request to ${path} failed.`,
      { error_type: data.error_type }
    );
  }
  return data;
}

// Access tokens are encrypted with AES-256-GCM before being handed to the
// browser, so the functions can stay stateless (no database needed).
function key() {
  const material = process.env.TOKEN_ENCRYPTION_KEY || process.env.PLAID_SECRET;
  if (!material) throw new HttpError(503, "NOT_CONFIGURED", "Missing encryption key.");
  return crypto.createHash("sha256").update(material).digest();
}

export function sealToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

export function openToken(sealed) {
  try {
    const buf = Buffer.from(String(sealed), "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new HttpError(400, "INVALID_TOKEN", "This bank connection is no longer valid. Please reconnect.");
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Wraps a handler: POST-only, parses the JSON body, and turns errors into JSON responses.
export function handler(fn) {
  return async (req, context) => {
    if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    try {
      const body = await req.json().catch(() => ({}));
      return json(await fn(body, req, context));
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.code, message: err.message, ...err.extra }, err.status);
      }
      console.error(err);
      return json({ error: "SERVER_ERROR", message: "Something went wrong on the server." }, 500);
    }
  };
}
