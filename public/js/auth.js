// Email + password sign-in with Supabase Auth.
// The Supabase client is loaded from /vendor/supabase-*.js as window.supabase.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

// Read before the client consumes the URL: true when the user arrived from a
// "reset your password" email and needs to choose a new password.
export const isRecoveryLink = /(^|[#&?])type=recovery(&|$)/.test(window.location.hash + window.location.search);

export const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});

const redirectTo = () => window.location.origin + "/";

// Resolves once any confirmation or reset link in the URL has been processed.
export async function currentUser() {
  const { data } = await client.auth.getSession();
  return data.session?.user || null;
}

export async function accessToken() {
  const { data } = await client.auth.getSession();
  return data.session?.access_token || null;
}

export async function signIn(email, password) {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

// Returns true if the user is signed in right away, false if they must confirm their email first.
export async function signUp(email, password) {
  const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } });
  if (error) throw error;
  return Boolean(data.session);
}

export async function sendPasswordReset(email) {
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
  if (error) throw error;
}

export async function setNewPassword(password) {
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  await client.auth.signOut();
}

export function onAuthChange(fn) {
  client.auth.onAuthStateChange((event, session) => fn(event, session?.user || null));
}

// Error details Supabase puts in the URL when an email link is expired or already used.
export function linkErrorFromUrl() {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search.slice(1));
  const msg = params.get("error_description");
  if (!msg) return null;
  history.replaceState(null, "", window.location.pathname);
  return msg.replace(/\+/g, " ");
}

// Turns Supabase's error messages into friendlier ones.
export function friendlyAuthError(err) {
  const msg = err?.message || "";
  if (err?.status === 429 || /rate limit/i.test(msg)) return "Too many attempts. Please wait a few minutes and try again.";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (/banned/i.test(msg)) return "This account has been suspended. Contact the site administrator.";
  if (/email not confirmed/i.test(msg)) return "Please confirm your email first. Check your inbox for the confirmation link.";
  if (/already registered|already exists/i.test(msg)) return "An account with this email already exists. Sign in instead.";
  if (/password should be|weak password|at least/i.test(msg)) return msg;
  if (/not authorized/i.test(msg)) return "This email address can't receive emails from the app yet. See the README's email delivery note.";
  if (/failed to fetch|network/i.test(msg)) return "Couldn't reach the server. Check your connection and try again.";
  return msg || "Something went wrong. Please try again.";
}
