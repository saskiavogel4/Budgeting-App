// Creates a Plaid Link token. Pass { token } to open Link in update mode
// (used to re-authenticate a bank that needs the user to log in again).
import { handler, plaid, openToken, plaidConfig } from "../lib/plaid.mjs";

export default handler(async (body, user) => {
  const { env } = plaidConfig();
  const request = {
    client_name: "CampusCash",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: user.id },
  };
  if (body.token) {
    request.access_token = openToken(body.token, user.id);
  } else {
    request.products = ["transactions"];
    request.transactions = { days_requested: 180 };
  }
  const data = await plaid("/link/token/create", request);
  return { link_token: data.link_token, env };
});

export const config = { path: "/api/link-token" };
