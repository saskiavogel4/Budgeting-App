// Browser side of the Plaid integration. Talks only to our own Netlify Functions;
// Plaid keys never reach the browser.
import { getState, update } from "./store.js";

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  } catch {
    throw new ApiError("NETWORK", "Couldn't reach the server. Check your connection.", 0);
  }
  const data = await res.json().catch(() => null);
  if (!data) {
    // Not JSON (e.g. a 404 page): the Netlify Functions aren't running.
    throw new ApiError("NO_FUNCTIONS", "The server functions aren't running. Deploy to Netlify or use `netlify dev` locally.", res.status);
  }
  if (!res.ok) throw new ApiError(data.error || "SERVER_ERROR", data.message || "Something went wrong.", res.status);
  return data;
}

export async function plaidStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return { configured: false, reachable: false };
    return { ...(await res.json()), reachable: true };
  } catch {
    return { configured: false, reachable: false };
  }
}

let scriptPromise;
function loadLinkScript() {
  if (window.Plaid) return Promise.resolve();
  scriptPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    s.onload = resolve;
    s.onerror = () => {
      scriptPromise = null;
      reject(new ApiError("LINK_LOAD_FAILED", "Couldn't load Plaid. Disable any ad blocker and try again."));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

function openLink(linkToken) {
  return new Promise((resolve, reject) => {
    const link = window.Plaid.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) => resolve({ publicToken, metadata }),
      onExit: (err) => {
        link.destroy();
        if (err) reject(new ApiError(err.error_code || "LINK_EXIT", err.display_message || err.error_message || "Bank connection was cancelled."));
        else resolve(null);
      },
    });
    link.open();
  });
}

// Opens Plaid Link to connect a new bank. Returns true if a bank was added.
export async function connectBank() {
  const [{ link_token }] = await Promise.all([api("link-token"), loadLinkScript()]);
  const result = await openLink(link_token);
  if (!result) return false;
  const { token, item_id } = await api("exchange", { public_token: result.publicToken });
  update((s) => {
    s.mode = "plaid";
    s.items = s.items.filter((i) => i.itemId !== item_id);
    s.items.push({
      token,
      itemId: item_id,
      institution: result.metadata?.institution?.name || "Bank",
      accounts: [],
      transactions: [],
      syncedAt: null,
      error: null,
    });
  });
  await syncItem(item_id, { waitForTransactions: true });
  return true;
}

// Re-authenticate a bank whose login expired (Plaid "update mode").
export async function reconnectBank(itemId) {
  const item = getState().items.find((i) => i.itemId === itemId);
  if (!item) return false;
  const [{ link_token }] = await Promise.all([api("link-token", { token: item.token }), loadLinkScript()]);
  const result = await openLink(link_token);
  if (!result) return false;
  await syncItem(itemId);
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function syncItem(itemId, { waitForTransactions = false } = {}) {
  const item = getState().items.find((i) => i.itemId === itemId);
  if (!item) return;
  try {
    let data = await api("sync", { token: item.token });
    // Right after linking, Plaid may still be pulling history. Poll briefly.
    for (let tries = 0; waitForTransactions && tries < 6 && data.transactions.length === 0 && data.status !== "HISTORICAL_UPDATE_COMPLETE"; tries++) {
      await sleep(2500);
      data = await api("sync", { token: item.token });
    }
    update((s) => {
      const target = s.items.find((i) => i.itemId === itemId);
      if (!target) return;
      target.accounts = data.accounts;
      target.transactions = data.transactions;
      target.syncedAt = data.syncedAt;
      target.error = null;
    });
  } catch (err) {
    update((s) => {
      const target = s.items.find((i) => i.itemId === itemId);
      if (target) target.error = { code: err.code, message: err.message };
    });
    throw err;
  }
}

export async function syncAll() {
  const results = await Promise.allSettled(getState().items.map((i) => syncItem(i.itemId)));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) throw failed[0].reason;
}

export async function disconnectBank(itemId) {
  const item = getState().items.find((i) => i.itemId === itemId);
  if (!item) return;
  try {
    await api("remove", { token: item.token });
  } finally {
    // Remove locally even if Plaid already forgot this item.
    update((s) => {
      s.items = s.items.filter((i) => i.itemId !== itemId);
      if (!s.items.length && s.mode === "plaid") s.mode = null;
    });
  }
}
