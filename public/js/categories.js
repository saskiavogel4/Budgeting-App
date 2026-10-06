// Student-friendly spending categories, with sensible starter monthly budgets.
export const CATEGORIES = [
  { id: "housing", name: "Rent & Utilities", icon: "🏠", budget: 700 },
  { id: "groceries", name: "Groceries", icon: "🛒", budget: 250 },
  { id: "food", name: "Eating Out & Coffee", icon: "🍔", budget: 120 },
  { id: "transport", name: "Transportation", icon: "🚌", budget: 60 },
  { id: "school", name: "School & Books", icon: "📚", budget: 50 },
  { id: "subscriptions", name: "Subscriptions", icon: "📱", budget: 30 },
  { id: "fun", name: "Fun & Going Out", icon: "🎉", budget: 80 },
  { id: "shopping", name: "Shopping", icon: "🛍️", budget: 60 },
  { id: "health", name: "Health & Personal", icon: "💊", budget: 30 },
  { id: "bills", name: "Bills & Fees", icon: "🧾", budget: 40 },
  { id: "other", name: "Other", icon: "📦", budget: 30 },
];

// Not spending: excluded from budgets.
export const SPECIAL = {
  income: { id: "income", name: "Income", icon: "💰" },
  transfer: { id: "transfer", name: "Transfer", icon: "🔁" },
};

const BY_ID = Object.fromEntries([...CATEGORIES, ...Object.values(SPECIAL)].map((c) => [c.id, c]));

export function category(id) {
  return BY_ID[id] || BY_ID.other;
}

export function isSpendingCategory(id) {
  return id !== "income" && id !== "transfer";
}

// Maps Plaid's personal_finance_category to our categories.
// https://plaid.com/documents/transactions-personal-finance-category-taxonomy.csv
const DETAILED = {
  FOOD_AND_DRINK_GROCERIES: "groceries",
  GENERAL_SERVICES_EDUCATION: "school",
  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS: "school",
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES: "school",
  ENTERTAINMENT_TV_AND_MOVIES: "subscriptions",
  ENTERTAINMENT_MUSIC_AND_AUDIO: "subscriptions",
  GENERAL_SERVICES_INTERNET_AND_CABLE: "housing",
  RENT_AND_UTILITIES_TELEPHONE: "bills",
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: "transfer",
};

const PRIMARY = {
  INCOME: "income",
  TRANSFER_IN: "transfer",
  TRANSFER_OUT: "transfer",
  LOAN_PAYMENTS: "bills",
  BANK_FEES: "bills",
  ENTERTAINMENT: "fun",
  FOOD_AND_DRINK: "food",
  GENERAL_MERCHANDISE: "shopping",
  HOME_IMPROVEMENT: "shopping",
  MEDICAL: "health",
  PERSONAL_CARE: "health",
  GENERAL_SERVICES: "bills",
  GOVERNMENT_AND_NON_PROFIT: "other",
  TRANSPORTATION: "transport",
  TRAVEL: "transport",
  RENT_AND_UTILITIES: "housing",
};

export function categorizePlaid(tx) {
  if (tx.pfcDetailed && DETAILED[tx.pfcDetailed]) return DETAILED[tx.pfcDetailed];
  if (tx.pfcPrimary && PRIMARY[tx.pfcPrimary]) return PRIMARY[tx.pfcPrimary];
  return tx.amount < 0 ? "income" : "other";
}

export function defaultBudgets() {
  return Object.fromEntries(CATEGORIES.map((c) => [c.id, c.budget]));
}
