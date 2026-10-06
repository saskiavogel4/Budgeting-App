// Exchanges the short-lived public_token from Plaid Link for an access token,
// then returns it encrypted so the browser never sees the raw access token.
import { handler, plaid, sealToken, HttpError } from "../lib/plaid.mjs";

export default handler(async (body) => {
  if (!body.public_token) throw new HttpError(400, "MISSING_PUBLIC_TOKEN", "public_token is required.");
  const data = await plaid("/item/public_token/exchange", { public_token: body.public_token });
  return { token: sealToken(data.access_token), item_id: data.item_id };
});

export const config = { path: "/api/exchange" };
