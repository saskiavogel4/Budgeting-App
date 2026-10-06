// Disconnects a bank: tells Plaid to invalidate the access token.
import { handler, plaid, openToken, HttpError } from "../lib/plaid.mjs";

export default handler(async (body) => {
  if (!body.token) throw new HttpError(400, "MISSING_TOKEN", "token is required.");
  await plaid("/item/remove", { access_token: openToken(body.token) });
  return { removed: true };
});

export const config = { path: "/api/remove" };
