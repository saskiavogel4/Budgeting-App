// Pulls live balances and transactions for one connected bank (Plaid Item).
import { handler, plaid, openToken, HttpError } from "../lib/plaid.mjs";

const MAX_PAGES = 10;

async function getAccounts(access_token) {
  try {
    // Real-time balances straight from the bank.
    return (await plaid("/accounts/balance/get", { access_token })).accounts;
  } catch (err) {
    if (err.code === "ITEM_LOGIN_REQUIRED") throw err;
    // Some institutions don't support real-time balance; fall back to cached balances.
    return (await plaid("/accounts/get", { access_token })).accounts;
  }
}

export default handler(async (body, user) => {
  if (!body.token) throw new HttpError(400, "MISSING_TOKEN", "token is required.");
  const access_token = openToken(body.token, user.id);

  const accounts = await getAccounts(access_token);

  const transactions = [];
  let cursor = null;
  let status = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await plaid("/transactions/sync", {
      access_token,
      count: 500,
      ...(cursor ? { cursor } : {}),
    });
    transactions.push(...data.added);
    cursor = data.next_cursor;
    status = data.transactions_update_status;
    if (!data.has_more) break;
  }

  return {
    accounts: accounts.map((a) => ({
      id: a.account_id,
      name: a.name,
      officialName: a.official_name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      current: a.balances.current,
      available: a.balances.available,
      limit: a.balances.limit,
      currency: a.balances.iso_currency_code || "USD",
    })),
    transactions: transactions.map((t) => ({
      id: t.transaction_id,
      accountId: t.account_id,
      date: t.date,
      name: t.merchant_name || t.name,
      amount: t.amount, // Plaid convention: positive = money out
      pending: t.pending,
      pfcPrimary: t.personal_finance_category?.primary || null,
      pfcDetailed: t.personal_finance_category?.detailed || null,
      logo: t.logo_url || null,
    })),
    status,
    syncedAt: new Date().toISOString(),
  };
});

export const config = { path: "/api/sync" };
