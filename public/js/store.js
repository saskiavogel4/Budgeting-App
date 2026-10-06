// App state, saved in this browser's localStorage.
import { defaultBudgets } from "./categories.js";

const LEGACY_KEY = "campuscash:data:v1";
let KEY = LEGACY_KEY;

function blank() {
  return {
    mode: null, // "plaid" | "demo" | null (not set up yet)
    items: [], // connected banks: { token, itemId, institution, accounts, transactions, syncedAt, error }
    demo: null, // { accounts, transactions, syncedAt }
    manual: [], // cash expenses the user added by hand
    overrides: {}, // transaction id -> category id
    budgets: defaultBudgets(),
  };
}

let state = blank();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...blank(), ...JSON.parse(raw) };
  } catch {
    /* storage blocked or corrupted: start fresh */
  }
  return blank();
}

// Each signed-in user gets their own saved data in this browser.
export function initStore(userId) {
  KEY = `${LEGACY_KEY}:${userId}`;
  try {
    // One-time move of data saved before sign-in existed.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && !localStorage.getItem(KEY)) localStorage.setItem(KEY, legacy);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* storage blocked */
  }
  state = load();
}

export function getState() {
  return state;
}

export function update(fn) {
  fn(state);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked: keep working in memory */
  }
  listeners.forEach((l) => l(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reset() {
  state = blank();
  update(() => {});
}
