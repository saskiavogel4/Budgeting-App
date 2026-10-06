// Realistic sample data for a college student, so the app can be tried
// without connecting a bank. Dates are generated relative to today.

function iso(d) {
  return d.toISOString().slice(0, 10);
}

// Small deterministic random generator so the demo looks the same on every refresh.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export function buildDemoData() {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const rand = rng(42);
  const tx = [];
  let n = 0;

  const add = (daysAgo, name, amount, pfcPrimary, pfcDetailed, accountId = "demo-checking") => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    tx.push({
      id: `demo-${n++}`,
      accountId,
      date: iso(d),
      name,
      amount: Math.round(amount * 100) / 100,
      pending: daysAgo === 0,
      pfcPrimary,
      pfcDetailed,
    });
  };

  for (let day = 0; day < 90; day++) {
    const d = new Date(today);
    d.setDate(d.getDate() - day);
    const dom = d.getDate();
    const dow = d.getDay();

    if (dom === 1) add(day, "Campus View Apartments", 650, "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT");
    if (dom === 3) add(day, "Duke Energy", 38 + rand() * 20, "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY");
    if (dom === 5) add(day, "Spotify Student", 5.99, "ENTERTAINMENT", "ENTERTAINMENT_MUSIC_AND_AUDIO", "demo-credit");
    if (dom === 8) add(day, "Netflix", 6.99, "ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES", "demo-credit");
    if (dom === 12) add(day, "Mint Mobile", 15, "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_TELEPHONE");
    if (dom === 15) add(day, "Transfer to Savings", 50, "TRANSFER_OUT", "TRANSFER_OUT_SAVINGS");
    if (dom === 20) add(day, "Credit Card Payment", 120, "LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT");

    // Bi-weekly campus job paycheck on Fridays.
    if (dow === 5 && Math.floor(day / 7) % 2 === 0) {
      add(day, "University Payroll", -(410 + Math.round(rand() * 60)), "INCOME", "INCOME_WAGES");
    }
    if (dow === 0) add(day, ["Trader Joe's", "Aldi", "Publix"][Math.floor(rand() * 3)], 35 + rand() * 40, "FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES");
    if (dow >= 1 && dow <= 5 && rand() < 0.55) add(day, "Starbucks", 4 + rand() * 3, "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE", "demo-credit");
    if (rand() < 0.22) add(day, ["Chipotle", "Chick-fil-A", "Domino's", "Panda Express", "Insomnia Cookies"][Math.floor(rand() * 5)], 9 + rand() * 14, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT", "demo-credit");
    if (rand() < 0.12) add(day, "Uber", 8 + rand() * 12, "TRANSPORTATION", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES", "demo-credit");
    if (rand() < 0.05) add(day, "Shell", 25 + rand() * 15, "TRANSPORTATION", "TRANSPORTATION_GAS");
    if (dow === 6 && rand() < 0.5) add(day, ["AMC Theatres", "Bowlero", "Ticketmaster"][Math.floor(rand() * 3)], 12 + rand() * 30, "ENTERTAINMENT", "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS", "demo-credit");
    if (rand() < 0.06) add(day, ["Target", "Amazon", "H&M"][Math.floor(rand() * 3)], 15 + rand() * 45, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE", "demo-credit");
    if (rand() < 0.03) add(day, "CVS Pharmacy", 8 + rand() * 20, "MEDICAL", "MEDICAL_PHARMACIES_AND_SUPPLEMENTS");
    if (rand() < 0.04) add(day, "Venmo from Alex", -(10 + Math.round(rand() * 30)), "TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER");
  }
  add(24, "Campus Bookstore", 86.4, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS", "demo-credit");
  add(52, "Chegg", 15.95, "GENERAL_SERVICES", "GENERAL_SERVICES_EDUCATION", "demo-credit");

  const accounts = [
    { id: "demo-checking", name: "Student Checking", mask: "4821", type: "depository", subtype: "checking", current: 1243.57, available: 1243.57, limit: null, currency: "USD" },
    { id: "demo-savings", name: "Savings", mask: "9930", type: "depository", subtype: "savings", current: 860.0, available: 860.0, limit: null, currency: "USD" },
    { id: "demo-credit", name: "Student Rewards Card", mask: "1177", type: "credit", subtype: "credit card", current: 214.36, available: 785.64, limit: 1000, currency: "USD" },
  ];

  return { accounts, transactions: tx, syncedAt: new Date().toISOString(), institution: "Demo Bank" };
}
