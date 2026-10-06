// Lets the app know whether Plaid keys are set, without revealing them.
import { json } from "../lib/plaid.mjs";

export default async () => {
  const configured = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
  const env = (process.env.PLAID_ENV || "sandbox").toLowerCase();
  return json({ configured, env });
};

export const config = { path: "/api/status" };
