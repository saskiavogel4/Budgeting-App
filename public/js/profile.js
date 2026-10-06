// The signed-in user's profile, stored in the Supabase "profiles" table.
// Row Level Security makes sure each user can only read and edit their own row.
import { client } from "./auth.js";

const FIELDS = "full_name, school, major, graduation_year, monthly_income, updated_at";

export async function loadProfile(userId) {
  const { data, error } = await client.from("profiles").select(FIELDS).eq("id", userId).maybeSingle();
  if (error) throw error;
  return normalize(data || {});
}

export async function saveProfile(userId, fields) {
  const { data, error } = await client
    .from("profiles")
    .upsert({ id: userId, ...fields })
    .select(FIELDS)
    .single();
  if (error) throw error;
  return normalize(data);
}

function normalize(p) {
  return {
    full_name: p.full_name || "",
    school: p.school || "",
    major: p.major || "",
    graduation_year: p.graduation_year ?? null,
    monthly_income: p.monthly_income == null ? null : Number(p.monthly_income),
    updated_at: p.updated_at || null,
  };
}

export function firstName(profile) {
  return (profile?.full_name || "").trim().split(/\s+/)[0] || "";
}

export function initials(profile, email) {
  const parts = (profile?.full_name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length) return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  return (email || "?")[0].toUpperCase();
}
