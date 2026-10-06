// Email-only sign-in (magic link) with Supabase Auth.
// The Supabase client is loaded from /vendor/supabase-*.js as window.supabase.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});

// Resolves once any sign-in link in the URL has been processed.
export async function currentUser() {
  const { data } = await client.auth.getSession();
  return data.session?.user || null;
}

export async function accessToken() {
  const { data } = await client.auth.getSession();
  return data.session?.access_token || null;
}

export async function sendSignInLink(email) {
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + "/" },
  });
  if (error) throw error;
}

export async function signOut() {
  await client.auth.signOut();
}

export function onAuthChange(fn) {
  client.auth.onAuthStateChange((event, session) => fn(event, session?.user || null));
}

// Error details Supabase puts in the URL when a sign-in link is expired or already used.
export function linkErrorFromUrl() {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search.slice(1));
  const msg = params.get("error_description");
  if (!msg) return null;
  history.replaceState(null, "", window.location.pathname);
  return msg.replace(/\+/g, " ");
}
