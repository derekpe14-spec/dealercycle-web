// Seeds data.json from the REAL catalog/colors extracted from FeedCycle_Prototype.html
// plus the real 31-name Evans Cattle roster and the live cycle config.
// Re-running re-seeds catalog/settings but PRESERVES customers + orders + invoices
// + payments unless you pass --fresh.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FRESH = process.argv.includes("--fresh");
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-raw.json"), "utf8"));

const { MASTER, BAG_HEX, HEXNAME } = raw;

// ---- products (real Umbarger catalog, real feed-tag bag colors) ----
const products = MASTER.map(p => {
  const hex = BAG_HEX[p[0]] || "9aa3b0";
  return {
    id: p[0],
    name: p[1],
    category: p[2],
    wholesale: p[3],
    srp: p[4],
    size: p[5],
    bag_hex: "#" + hex,
    bag_color_name: HEXNAME[hex] || "",
    active: 1
  };
});

const categoryOrder = ["Cattle", "Lamb", "Goats", "Repro", "Swine", "Horse", "Poultry", "Vita Ferm", "Extras"];
const categoryColors = {
  "Cattle": "#1F3864", "Lamb": "#8E44AD", "Goats": "#C0392B", "Repro": "#16A085",
  "Swine": "#D35400", "Horse": "#7F8C8D", "Poultry": "#B7950B", "Vita Ferm": "#27AE60", "Extras": "#2980B9"
};

// ---- settings (the live DEALER config + invoice/cycle settings) ----
const settings = {
  dealer_name: "Evans Cattle Company",
  payable_to: "Evans Cattle Company",
  address: "3209 Drennon Rd, Campbellsburg, KY 40011",
  phone: "217-218-0242",
  email: "derekpe14@gmail.com",
  venmo: "@Derek-Evans-79",
  pricing_basis: "srp",        // "srp" = % off SRP floored at wholesale; "cost" = markup on wholesale
  margin_pct: 1,
  freight: 2.75,
  tax_enabled: false,
  tax_pct: 6.0,
  cycle_anchor: "2026-05-02",
  frequency_days: 14,
  open_day: "Saturday", open_time: "9:00 AM",
  close_day: "Monday", close_time: "10:30 AM",
  mill_day: "Monday", mill_time: "10:45 AM",
  invoice_day: "Wednesday", invoice_time: "8:00 AM",
  mill_contact_name: "Hannah Cragen",
  mill_contact_email: "hcragen@umbargerandsons.com",
  invoice_terms: "Total due in 10 business days. Overdue accounts subject to a service charge of 20% per month.",
  invoice_counter: 0,          // next invoice = YY-(counter+1)
  order_window: "open"         // "auto" (use cycle days/times) | "open" (always, for pilot) | "closed"
};

const ROSTER = [
  "Aaron Hartman","Adam Chunglo","Alica Woods","Amanda Chumley","Aron Combs","Beth Johnson",
  "Charles Toll","Chris Conway","Crittenden Farm Supply","Darin Williams","Evans Cattle",
  "Fatima Jackson","Jackson Jeffries","Jeremy Harlow","Jimmy Simpson","Joe Mobley","John Dyehouse",
  "John Ethington","John Ruber","John Way","Josh Martin","JR Zinner","Kassie Popp","Kay Kaufman",
  "Kyle Young","Laura Parker","Paul Ricketts","Rick Hagerman","Ryan Wonderlich","Stephanie Stefanic","Wyatt Acey"
];

function token() { return crypto.randomBytes(16).toString("hex"); }

let existing = null;
if (fs.existsSync(DATA_FILE) && !FRESH) {
  existing = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

const customers = (existing && existing.customers && existing.customers.length)
  ? existing.customers
  : ROSTER.map((name, i) => ({
      id: i + 1, name, phone: "", email: "", address: "",
      payment_method: "Check", payment_detail_label: "",
      link_token: token(), source: "seed", active: 1
    }));

const data = {
  products,
  categoryOrder,
  categoryColors,
  settings: (existing && !FRESH) ? Object.assign({}, settings, existing.settings) : settings,
  customers,
  cycles: (existing && existing.cycles) || [],
  orders: (existing && existing.orders) || [],
  order_items: (existing && existing.order_items) || [],
  invoices: (existing && existing.invoices) || [],
  payments: (existing && existing.payments) || [],
  outbox: (existing && existing.outbox) || []
};

// re-seed catalog every run (prices/colors are source-of-truth from the prototype)
data.products = products;
data.categoryOrder = categoryOrder;
data.categoryColors = categoryColors;

fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
console.log(`Seeded data.json — ${products.length} products, ${customers.length} customers.${FRESH ? " (fresh)" : ""}`);
console.log("Sample customer link token:", customers[0].name, "->", customers[0].link_token);
