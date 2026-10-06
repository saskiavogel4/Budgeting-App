// App state, saved in this browser's localStorage.
import { defaultBudgets } from "./categories.js";

const KEY = "campuscash:data:v1";

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

let state = load();
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
