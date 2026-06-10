// DealerCycle — Phase 1 web ordering system. Zero dependencies (Node 18+).
//   node seed.js     # one-time: build data.json from the real catalog
//   node server.js   # start the app on http://localhost:3000
//
// Customer order screen:  /o/<link_token>
// Dealer back office:     /admin   (passcode: env ADMIN_PASSCODE, default "evans")
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, save, nextId, reload } = require("./db");
const mailer = require("./mailer");
const payments = require("./payments");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "evans";
const BASE_URL = process.env.BASE_URL || ("http://localhost:" + PORT);
// Front-end files live alongside the server (flat, single folder). Only these are
// ever served as static assets — server code/data are never exposed.
const PUBLIC = __dirname;
const STATIC_ALLOW = new Set(["order.html", "admin.html", "start.html", "phone.html", "styles.css", "favicon.svg", "manifest.webmanifest", "dc-icon-192.png", "dc-icon-512.png", "dc-icon-180.png"]);

// First-run: if there's no database yet, build it automatically (no separate seed step).
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(path.join(DATA_DIR, "data.json"))) {
  console.log("First run — setting up your data...");
  require("child_process").execSync("node seed.js", { cwd: __dirname, stdio: "inherit" });
}

// ---------------------------------------------------------------------------
// Pricing engine — mirrors FeedCycle_Prototype.html to the penny.
// ---------------------------------------------------------------------------
function round2(n) { return Math.round(n * 100) / 100; }
function basePrice(p, s) {
  // The per-bag customer price is a real dollar amount, so round to the cent here.
  // Rounding the base first makes the order form, dashboard and invoice agree exactly.
  const raw = (s.pricing_basis === "cost")
    ? p.wholesale * (1 + s.margin_pct / 100)
    : Math.max(p.srp * (1 - s.margin_pct / 100), p.wholesale);
  return round2(raw);
}
function preTax(p, s) { return basePrice(p, s) + s.freight; }
function allIn(p, s) { const t = preTax(p, s); return s.tax_enabled ? t * (1 + s.tax_pct / 100) : t; }
function marginBag(p, s) { return basePrice(p, s) - p.wholesale; }
function money(n) { return "$" + round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ---------------------------------------------------------------------------
// Cycle helpers
// ---------------------------------------------------------------------------
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function parseTime(t) { // "9:00 AM" -> {h,m}
  const m = String(t).match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!m) return { h: 9, m: 0 };
  let h = +m[1]; const min = +m[2]; const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0;
  return { h, m: min };
}
function nextCycleSaturday(s, from) {
  const anchor = new Date(s.cycle_anchor + "T00:00:00");
  const today = from || new Date();
  const ms = 24 * 3600 * 1000;
  let d = new Date(anchor);
  while (d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
    d = new Date(d.getTime() + s.frequency_days * ms);
  }
  return d; // delivery Saturday on/after today
}
function cycleKey(d) { return d.toISOString().slice(0, 10); }
function cycleLabel(d) { return (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear(); }
function windowState(s) {
  if (s.order_window === "open") return { open: true, reason: "open" };
  if (s.order_window === "closed") return { open: false, reason: "closed" };
  // auto: open from open_day/open_time of the current cycle week through close_day/close_time
  const now = new Date();
  const sat = nextCycleSaturday(s, now);
  const openIdx = DAYS.indexOf(s.open_day), closeIdx = DAYS.indexOf(s.close_day);
  const ot = parseTime(s.open_time), ct = parseTime(s.close_time);
  // open moment: the Saturday (assume open_day on/after the prior cycle) — simple model: this cycle's Saturday at open_time
  const openMoment = new Date(sat); openMoment.setHours(ot.h, ot.m, 0, 0);
  // close moment: first close_day strictly after the open moment
  let cm = new Date(openMoment);
  do { cm = new Date(cm.getTime() + 24 * 3600 * 1000); } while (cm.getDay() !== closeIdx);
  cm.setHours(ct.h, ct.m, 0, 0);
  const open = now >= openMoment && now <= cm;
  return { open, reason: open ? "open" : "outside window" };
}
function getOrCreateCycle(s) {
  const sat = cycleSaturdayForNow(s);   // stable across the whole Sat→Mon order window
  const key = cycleKey(sat);
  let c = db().cycles.find(x => x.delivery_key === key);
  if (!c) {
    c = { id: nextId("cycles"), delivery_key: key, delivery_label: cycleLabel(sat), status: "open" };
    db().cycles.push(c); save();
  }
  return c;
}

// ---------------------------------------------------------------------------
// Order helpers
// ---------------------------------------------------------------------------
function findCustomerByToken(tok) { return db().customers.find(c => c.link_token === tok && c.active); }
function findCustomerById(id) { return db().customers.find(c => c.id === id); }
function product(id) { return db().products.find(p => p.id === id); }
function customerOrder(custId, cycleId) { return db().orders.find(o => o.customer_id === custId && o.cycle_id === cycleId); }
function orderItems(orderId) { return db().order_items.filter(i => i.order_id === orderId); }

function tallyCycle(cycleId) { // product_id -> bags
  const t = {};
  db().orders.filter(o => o.cycle_id === cycleId && o.status === "submitted").forEach(o => {
    orderItems(o.id).forEach(i => { t[i.product_id] = (t[i.product_id] || 0) + i.qty; });
  });
  return t;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
function nextInvoiceNum() {
  const s = db().settings;
  s.invoice_counter = (s.invoice_counter || 0) + 1;
  const yy = String(new Date().getFullYear()).slice(-2);
  return yy + "-" + String(s.invoice_counter).padStart(3, "0");
}
function buildInvoiceForCustomer(custId, cycleId) {
  const s = db().settings;
  const cust = findCustomerById(custId);
  const order = customerOrder(custId, cycleId);
  if (!order) return null;
  const items = orderItems(order.id).filter(i => i.qty > 0);
  if (!items.length) return null;
  const cyc = db().cycles.find(c => c.id === cycleId);

  if (!db().credits) db().credits = [];

  const baseLines = items.map(i => {
    const p = product(i.product_id);
    const unit = round2(basePrice(p, s));
    const freight = round2(i.qty * s.freight);
    const total = round2(i.qty * unit + freight);
    return { description: p.name, qty: i.qty, unitPrice: unit, freight, total };
  });
  const subtotal = round2(baseLines.reduce((a, l) => a + l.total, 0));
  const taxRate = s.tax_enabled ? s.tax_pct / 100 : 0;
  const tax = round2(subtotal * taxRate);
  const grossTotal = round2(subtotal + tax);   // before any credits
  const today = new Date().toISOString().slice(0, 10);

  // idempotent per (customer, cycle): reuse existing invoice if present
  let inv = db().invoices.find(x => x.customer_id === custId && x.cycle_id === cycleId);
  const isNew = !inv;
  if (isNew) {
    inv = {
      id: nextId("invoices"),
      invoice_num: nextInvoiceNum(),
      customer_id: custId,
      customer_name: cust.name,
      cycle_id: cycleId,
      cycle_label: cyc ? cyc.delivery_label : "",
      date_issued: today
    };
    db().invoices.push(inv);
  }

  // ----- apply customer credits (e.g. out-of-stock refunds) -----
  let creditTotal = 0;
  if (isNew) {
    // consume open credits oldest-first, up to the gross total
    let remaining = grossTotal;
    db().credits.filter(c => c.customer_id === custId && c.status === "open")
      .forEach(c => {
        if (remaining <= 0) return;
        const avail = round2(c.amount - (c.used || 0));
        if (avail <= 0) return;
        const applyAmt = round2(Math.min(avail, remaining));
        c.used = round2((c.used || 0) + applyAmt);
        c.applications = c.applications || [];
        c.applications.push({ invoice_id: inv.id, invoice_num: inv.invoice_num, amount: applyAmt, date: today });
        if (round2(c.amount - c.used) <= 0) { c.status = "applied"; c.applied_date = today; }
        creditTotal = round2(creditTotal + applyAmt);
        remaining = round2(remaining - applyAmt);
      });
  } else {
    // re-generate: keep whatever credits were already tied to this invoice (stable totals)
    db().credits.forEach(c => (c.applications || []).forEach(a => {
      if (a.invoice_id === inv.id) creditTotal = round2(creditTotal + a.amount);
    }));
  }
  const total = round2(grossTotal - creditTotal);
  Object.assign(inv, {
    lines: baseLines, subtotal, tax_rate: taxRate, tax,
    credit_total: creditTotal, total, freight_rate: s.freight
  });

  // payment-tracker row (created with the invoice; kept in sync if unpaid)
  let pay = db().payments.find(p => p.invoice_id === inv.id);
  if (!pay) {
    db().payments.push({
      id: nextId("payments"), invoice_id: inv.id, invoice_num: inv.invoice_num,
      customer_id: custId, customer_name: cust.name, amount: total,
      cycle: inv.cycle_label, date_issued: inv.date_issued,
      paid: false, date_paid: null, method: "", notes: "", reminders: 0
    });
  } else if (!pay.paid) {
    pay.amount = total;
  }
  // Inventory: when the invoice is first created, the stocked bags leave on_hand.
  if (isNew) fulfillInvoiceStock(inv, items.map(i => ({ product_id: i.product_id, qty: i.qty })));
  save();
  return inv;
}
function invoiceHtml(inv) {
  const s = db().settings;
  const rows = inv.lines.map((l, i) => `<tr class="${i % 2 ? "alt" : ""}"><td>${i + 1}</td><td>${esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${money(l.freight)}</td><td class="num">${money(l.total)}</td></tr>`).join("");
  const appliedCredits = (db().credits || []).reduce((arr, c) => {
    (c.applications || []).forEach(a => { if (a.invoice_id === inv.id) arr.push({ reason: c.reason || "Account credit", amount: a.amount }); });
    return arr;
  }, []);
  const creditRows = appliedCredits.length
    ? appliedCredits.map(c => `<tr><td style="color:#7a1f1f">Credit — ${esc(c.reason)}</td><td class="num" style="color:#7a1f1f">&minus;${money(c.amount)}</td></tr>`).join("")
    : (inv.credit_total ? `<tr><td>Credit applied</td><td class="num">&minus;${money(inv.credit_total)}</td></tr>` : "");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${inv.invoice_num}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;color:#3B2F1E;max-width:720px;margin:0 auto;padding:24px}
h1{color:#2F6B3A;font-size:22px;margin:0;font-family:'Zilla Slab',Georgia,serif} .muted{color:#7a6f5a;font-size:13px} hr{border:0;border-top:1px solid #e7ddc9;margin:14px 0}
.hdr{display:flex;align-items:center;gap:14px} .badge{width:50px;height:50px;flex-shrink:0}
.banner{color:#2F6B3A;font-size:18px;font-weight:bold;margin:6px 0} .meta{display:flex;justify-content:space-between;flex-wrap:wrap;font-size:13px;margin:10px 0}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px} th{background:#2F6B3A;color:#fff;text-align:left;padding:7px 9px} td{padding:7px 9px;border-bottom:1px solid #efe7d6}
tr.alt td{background:#F3EFE3} .num{text-align:right} .totals{margin-top:10px;width:100%;max-width:320px;margin-left:auto;font-size:13px}
.totals td{padding:5px 9px;border:0} .totals .due td{background:#EAF1E5;font-weight:bold;color:#2F6B3A;font-size:15px}
.pay{font-size:13px;margin-top:16px} .terms{font-size:11px;color:#8a7f6a;font-style:italic;margin-top:12px}
@media print{.noprint{display:none}} .noprint{margin-top:18px}
.btn{background:#2F6B3A;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer}</style></head><body>
<div class="hdr"><svg class="badge" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="23" fill="#2F6B3A"/><circle cx="24" cy="24" r="20.6" fill="none" stroke="#D9A441" stroke-width="1.4"/><circle cx="24" cy="24" r="18" fill="none" stroke="#D9A441" stroke-width="0.9"/><g transform="translate(12,11)" stroke="#F5EEDD" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></g></svg><div><h1>${esc(s.dealer_name)}</h1><div class="muted">${esc(s.address)}<br>${esc(s.phone)} • ${esc(s.email)}</div></div></div><hr>
<div class="banner">INVOICE</div>
<div class="meta"><div><b>Bill To:</b> ${esc(inv.customer_name)}</div><div><b>Invoice #:</b> ${inv.invoice_num}</div></div>
<div class="meta"><div><b>Cycle:</b> ${esc(inv.cycle_label)}</div><div><b>Invoice Date:</b> ${inv.date_issued}</div></div>
<table><thead><tr><th>#</th><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Freight</th><th class="num">Line Total</th></tr></thead><tbody>${rows}</tbody></table>
<table class="totals"><tr><td>Freight / bag</td><td class="num">${money(inv.freight_rate)}</td></tr>
<tr><td>Subtotal</td><td class="num">${money(inv.subtotal)}</td></tr>
<tr><td>Tax (${(inv.tax_rate * 100).toFixed(1)}%)</td><td class="num">${money(inv.tax)}</td></tr>
${creditRows}
<tr class="due"><td>TOTAL DUE</td><td class="num">${money(inv.total)}</td></tr></table>
${(function(){
  const pay = (db().payments || []).find(pp => pp.invoice_id === inv.id);
  const paid = pay && pay.paid;
  const pct = payments.effectiveSurchargePct(s, s.dealer_state);
  const sc = payments.surchargeAmount(inv.total, pct);
  const cardTotal = round2(inv.total + sc);
  const canPay = !inv.cancelled && !paid && inv.total > 0;
  if (paid) return '<div class="pay"><b>Paid</b> — thank you!' + (pay.method ? ' (' + esc(pay.method) + ')' : '') + '</div>';
  let h = '<div class="pay"><b>Payment options</b><br>&bull; Check — payable to ' + esc(s.payable_to) + '<br>&bull; Venmo — ' + esc(s.venmo);
  h += (pct > 0)
    ? '<br>&bull; Credit card — adds a ' + pct + '% ' + esc(s.surcharge_label || 'card processing fee') + ' (' + money(sc) + '); card total <b>' + money(cardTotal) + '</b>. ACH/check has no fee.'
    : '<br>&bull; Credit card accepted';
  h += '</div>';
  if (canPay) {
    h += '<div class="noprint" style="margin-top:12px"><button class="btn" id="cardbtn" onclick="payCard()">Pay by card' + (pct > 0 ? ' — ' + money(cardTotal) : '') + '</button></div>';
    h += '<script>function payCard(){var b=document.getElementById("cardbtn");b.disabled=true;b.textContent="Starting secure checkout\\u2026";fetch("/api/pay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({invoice_id:' + inv.id + '})}).then(function(r){return r.json();}).then(function(d){if(d&&d.url){window.location=d.url;}else{b.disabled=false;b.textContent="Pay by card";alert((d&&d.error)||"Could not start checkout.");}}).catch(function(){b.disabled=false;b.textContent="Pay by card";});}</script>';
  }
  return h;
})()}
<div class="terms">${esc(s.invoice_terms)}</div>
<div class="noprint"><button class="btn" onclick="window.print()">Print / Save PDF</button></div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Inventory (prototype) — DealerCycle OWNS the stock; QuickBooks would receive
// only the money. Optional per dealer via settings.inventory_enabled.
//   inventory_items : one row per product a dealer stocks
//   stock_movements : append-only ledger (receive/fulfill/return/adjust/write_off)
//   qbo_log         : preview of the transaction that WOULD post to QuickBooks
// Live numbers: available = on_hand - committed; committed = submitted orders
// this cycle that are not yet invoiced (once invoiced, stock leaves on_hand).
// ---------------------------------------------------------------------------
function ensureInventory() {
  const d = db();
  if (!d.inventory_items) d.inventory_items = [];
  if (!d.stock_movements) d.stock_movements = [];
  if (!d.receipts) d.receipts = [];
  if (!d.qbo_log) d.qbo_log = [];
}
function invItem(productId) { ensureInventory(); return db().inventory_items.find(i => i.product_id === productId); }
function committedQty(productId) {
  const s = db().settings; const cyc = getOrCreateCycle(s);
  let q = 0;
  db().orders.filter(o => o.cycle_id === cyc.id && o.status === "submitted").forEach(o => {
    const invoiced = db().invoices.find(v => v.customer_id === o.customer_id && v.cycle_id === cyc.id && !v.cancelled);
    if (invoiced) return; // invoiced => already pulled from on_hand, no longer "committed"
    orderItems(o.id).forEach(i => { if (i.product_id === productId) q += i.qty; });
  });
  return q;
}
function availableQty(productId) {
  const it = invItem(productId); if (!it) return 0;
  return Math.max(0, round2((it.on_hand || 0) - committedQty(productId)));
}
function logQbo(txn, detail, amount) {
  ensureInventory();
  db().qbo_log.push({ id: nextId("qbo_log"), txn, detail, amount: amount == null ? null : round2(amount), at: new Date().toISOString() });
}
// Apply a signed quantity change to on_hand and append a ledger row.
function recordMovement(productId, type, qtyDelta, opts) {
  ensureInventory();
  const it = invItem(productId);
  if (!it) return null;
  opts = opts || {};
  // weighted-average cost on stock-in
  if (qtyDelta > 0 && opts.unit_cost != null) {
    const prevQty = Math.max(0, it.on_hand || 0), prevVal = prevQty * (it.avg_cost || 0);
    const newVal = prevVal + qtyDelta * opts.unit_cost;
    const newQty = prevQty + qtyDelta;
    it.avg_cost = round2(newQty > 0 ? newVal / newQty : opts.unit_cost);
  }
  it.on_hand = round2((it.on_hand || 0) + qtyDelta);
  const mv = {
    id: nextId("stock_movements"), product_id: productId,
    product_name: (product(productId) || {}).name || productId,
    type, qty: round2(qtyDelta), balance_after: it.on_hand,
    reason: opts.reason || "", ref: opts.ref || "",
    unit_cost: opts.unit_cost != null ? round2(opts.unit_cost) : null,
    at: new Date().toISOString()
  };
  db().stock_movements.push(mv);
  return mv;
}
// On invoice creation, pull stocked products out of on_hand (the bags leave the
// shelf). Records what each invoice removed so a cancel can put it back exactly.
function fulfillInvoiceStock(inv, items) {
  if (!db().settings.inventory_enabled) return;
  ensureInventory();
  const fulfilled = [];
  items.forEach(i => {
    if (!invItem(i.product_id)) return;
    recordMovement(i.product_id, "fulfill", -i.qty, { reason: "Invoice " + inv.invoice_num, ref: "INV:" + inv.id });
    fulfilled.push({ product_id: i.product_id, qty: i.qty });
  });
  if (fulfilled.length) { inv.fulfilled_items = fulfilled; logQbo("Invoice", inv.invoice_num + " · " + inv.customer_name + " (income + A/R)", inv.total); }
}

// Record the dealer's own DealerCycle subscription (how this dealer pays us).
// This is OUR revenue, not the dealer's books, so it is NOT written to qbo_log.
function activateSubscription(method, ids) {
  const s = db().settings;
  db().subscription = {
    status: "active",
    method: method === "card" ? "card" : "ach",
    intro_price: Number(s.sub_intro_price) || 59.99,
    list_price: Number(s.sub_list_price) || 99,
    intro_months: Number(s.sub_intro_months) || 6,
    started_at: new Date().toISOString().slice(0, 10),
    stripe_customer_id: (ids && ids.stripe_customer_id) || null,
    stripe_subscription_id: (ids && ids.stripe_subscription_id) || null
  };
  save();
  return db().subscription;
}

// Stripe-style hosted-checkout look-alike for SIMULATED mode (no Stripe key) —
// real-looking card + US bank (ACH) entry with a live toggle, so the demo shows
// exactly what a payer fills in. opts: { mode:"invoice"|"subscription", merchant,
// invoiceNum, amount, surchargePct, introMonths, listPrice, action, payload, done, defaultMethod }
function simCheckoutPage(o) {
  const data = {
    mode: o.mode || "invoice", amount: round2(Number(o.amount) || 0),
    pct: Number(o.surchargePct) || 0, introMonths: o.introMonths || 6,
    listPrice: round2(Number(o.listPrice) || 99), action: o.action, done: o.done,
    payload: o.payload || {}, def: o.defaultMethod === "ach" ? "ach" : "card",
    invoiceNum: o.invoiceNum || "", merchant: o.merchant || "DealerCycle"
  };
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#F3EFE3;color:#30313d;margin:0;padding:20px}
.co{max-width:400px;margin:4vh auto;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.12);overflow:hidden}
.hd{padding:16px 20px 6px}.merch{font-size:13px;color:#6a7383}.amt{font-size:26px;font-weight:bold;margin:2px 0 0}.subln{font-size:12px;color:#8a909c}
.bd{padding:8px 20px 18px}.sim{background:#FFF6E6;color:#8a6d1f;font-size:11px;padding:6px 10px;border-radius:8px;margin:6px 0 12px;text-align:center}
.lbl{font-size:12px;color:#6a7383;margin:10px 0 4px}.fld{border:1px solid #e6e6ea;border-radius:8px;height:42px;display:flex;align-items:center;padding:0 12px;font-size:14px}
.fld input{border:0;outline:0;font-size:14px;width:100%;font-family:inherit;color:#30313d}
.two{display:flex;gap:10px}.two>div{flex:1}
.seg{display:flex;gap:8px;margin:10px 0 6px}.seg button{flex:1;background:#fff;border:1px solid #e6e6ea;border-radius:8px;padding:9px;font-size:12.5px;color:#30313d;cursor:pointer}
.seg button.on{border-color:#2F6B3A;box-shadow:0 0 0 1px #2F6B3A;color:#2F6B3A;font-weight:bold}
.brands{margin-left:auto;font-size:9px;color:#888}
.linkbox{border:1px solid #e6e6ea;border-radius:8px;padding:12px;margin-top:6px}.bankrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.bankrow span{font-size:11px;background:#f1f1f4;border-radius:6px;padding:5px 8px;color:#555}
.divider{display:flex;align-items:center;gap:10px;color:#9aa0ab;font-size:11px;margin:14px 0 4px}.divider:before,.divider:after{content:"";flex:1;height:1px;background:#ededf0}
.mandate{font-size:10.5px;line-height:1.5;color:#8a909c;margin-top:12px;background:#f7f7f9;border-radius:8px;padding:10px}
.btn{display:block;width:100%;background:#2F6B3A;color:#fff;border:0;border-radius:8px;height:44px;font-size:15px;font-weight:bold;cursor:pointer;margin-top:16px}.btn:disabled{opacity:.6}
.foot{text-align:center;font-size:11px;color:#8a909c;margin-top:12px}.hide{display:none}</style></head><body>
<div class="co"><div class="hd"><div class="merch" id="merch"></div><div class="amt" id="amt"></div><div class="subln" id="subln"></div></div>
<div class="bd">
<div class="sim">Simulated checkout — no real card is charged (add a Stripe key to go live).</div>
<div class="lbl">Email</div><div class="fld"><input placeholder="you@example.com"></div>
<div class="seg"><button id="mCard" onclick="setM('card')">Card</button><button id="mBank" onclick="setM('ach')">US bank account</button></div>
<div id="cardFields">
  <div class="lbl">Card number</div><div class="fld"><input placeholder="1234 1234 1234 1234"><span class="brands">VISA · MC · AMEX</span></div>
  <div class="two"><div><div class="lbl">Expiry</div><div class="fld"><input placeholder="MM / YY"></div></div><div><div class="lbl">CVC</div><div class="fld"><input placeholder="CVC"></div></div></div>
  <div class="lbl">Name on card</div><div class="fld"><input placeholder="Full name"></div>
  <div class="two"><div><div class="lbl">Country</div><div class="fld"><input value="United States"></div></div><div><div class="lbl">ZIP</div><div class="fld"><input placeholder="40011"></div></div></div>
</div>
<div id="bankFields" class="hide">
  <div class="linkbox"><div style="font-size:13px;font-weight:bold">⚡ Link your bank instantly</div><div style="font-size:12px;color:#6a7383;margin-top:3px">Log in to your bank to connect securely — recommended.</div><div class="bankrow"><span>Chase</span><span>Bank of America</span><span>Wells Fargo</span><span>US Bank</span><span>Search…</span></div></div>
  <div class="divider">or enter bank details manually</div>
  <div class="lbl">Account holder name</div><div class="fld"><input placeholder="Name on the account"></div>
  <div class="lbl">Routing number</div><div class="fld"><input placeholder="9 digits"></div>
  <div class="lbl">Account number</div><div class="fld"><input placeholder="Account number"></div>
  <div class="lbl">Account type</div><div class="fld"><input value="Checking"></div>
  <div class="mandate" id="mandate"></div>
</div>
<button class="btn" id="go" onclick="pay()">Pay</button>
<div class="foot">🔒 Powered by Stripe (simulated)</div>
</div></div>
<script>
var D=${JSON.stringify(data)};
function fmt(n){return "$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}
var method=D.def;
function sc(){ return method==="card"? Math.round(D.amount*D.pct/100*100)/100 : 0; }
function total(){ return Math.round((D.amount+sc())*100)/100; }
function render(){
  var sub=D.mode==="subscription";
  document.getElementById("merch").textContent=D.merchant;
  document.getElementById("amt").textContent=fmt(total())+(sub?"/mo":"");
  var sl;
  if(sub){ sl="Intro "+D.introMonths+" months, then "+fmt(D.listPrice)+"/mo — you save "+fmt(Math.round((D.listPrice-D.amount)*100)/100)+"/mo"; }
  else { sl="Invoice "+D.invoiceNum+(method==="card"&&D.pct>0?" · includes "+fmt(sc())+" card fee ("+D.pct+"%)":(method==="ach"?" · bank/ACH — no fee":"")); }
  document.getElementById("subln").textContent=sl;
  document.getElementById("mCard").className=method==="card"?"on":"";
  document.getElementById("mBank").className=method==="ach"?"on":"";
  document.getElementById("cardFields").className=method==="card"?"":"hide";
  document.getElementById("bankFields").className=method==="ach"?"":"hide";
  document.getElementById("mandate").textContent="By providing your bank account details and confirming, you authorize "+D.merchant+" and Stripe to debit your account for this"+(sub?" and future payments":"")+" per the displayed terms. You can cancel anytime.";
  document.getElementById("go").textContent=(sub?"Start subscription · "+fmt(total())+"/mo":"Pay "+fmt(total()))+(method==="ach"?" by bank":" by card");
}
function setM(m){ method=m; render(); }
function pay(){ var b=document.getElementById("go"); b.disabled=true; b.textContent="Processing…";
  var pl=Object.assign({},D.payload,{method:method,surcharge:sc()});
  fetch(D.action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pl)})
    .then(function(r){return r.json();}).then(function(d){ if(d&&d.ok){window.location=D.done;} else {b.disabled=false;render();alert((d&&d.error)||"Could not complete.");} })
    .catch(function(){b.disabled=false;render();}); }
render();
</script>
</body></html>`;
}
function simResultPage(title, msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#F3EFE3;color:#3B2F1E;margin:0;padding:24px;text-align:center}
.card{max-width:420px;margin:12vh auto;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.12);padding:32px 24px}
h1{color:#2F6B3A;font-size:22px;margin:0 0 10px} p{color:#555;font-size:14px}</style></head><body>
<div class="card"><div style="font-size:40px">&#10003;</div><h1>${esc(title)}</h1><p>${esc(msg)}</p></div></body></html>`;
}

// Mark an invoice paid from an online card payment (Stripe webhook or simulated
// completion). Idempotent. `surcharge` is the card fee the customer paid on top.
function markInvoicePaid(invoiceId, method, surcharge) {
  const pay = (db().payments || []).find(pp => pp.invoice_id === invoiceId);
  if (!pay) return false;
  if (pay.paid) return true;
  pay.paid = true;
  pay.date_paid = new Date().toISOString().slice(0, 10);
  pay.method = method || "Card";
  if (surcharge != null) pay.surcharge = round2(surcharge);
  const inv = db().invoices.find(v => v.id === invoiceId);
  logQbo("Payment", (pay.invoice_num || "") + " · " + (pay.customer_name || "") + " (" + pay.method + (surcharge ? ", incl. " + money(surcharge) + " card fee" : "") + ")", round2((pay.amount || 0) + (surcharge || 0)));
  save();
  return true;
}

// ---------------------------------------------------------------------------
// Email content builders — each returns { subject, text, html }
// ---------------------------------------------------------------------------
const NAVY = "#2F6B3A";
function wrapHtml(inner) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2332;max-width:560px;margin:auto">${inner}</div>`;
}
function emailOrderConfirmation(cust, order) {
  const s = db().settings;
  const cyc = db().cycles.find(c => c.id === order.cycle_id);
  const items = orderItems(order.id).filter(i => i.qty > 0);
  let total = 0; let bags = 0;
  const th = `style="background:${NAVY};color:#fff;padding:6px 10px;text-align:right;font-size:12px"`;
  const thL = `style="background:${NAVY};color:#fff;padding:6px 10px;text-align:left;font-size:12px"`;
  const td = `style="padding:6px 10px;border-bottom:1px solid #efe7d6;text-align:right"`;
  const tdL = `style="padding:6px 10px;border-bottom:1px solid #efe7d6;text-align:left"`;
  const rows = items.map(i => {
    const p = product(i.product_id);
    const unit = round2(basePrice(p, s));
    const freight = round2(i.qty * s.freight);
    const lt = round2(i.qty * unit + freight);
    total = round2(total + lt); bags += i.qty;
    return `<tr><td ${tdL}>${esc(p.name)}</td><td ${td}>${i.qty}</td><td ${td}>${money(unit)}</td><td ${td}>${money(freight)}</td><td ${td}>${money(lt)}</td></tr>`;
  }).join("");
  const subject = "Order received — " + s.payable_to + " (" + (cyc ? cyc.delivery_label : "") + ")";
  const html = wrapHtml(
    `<h2 style="color:${NAVY};margin:0 0 4px">Order received</h2><p style="color:#555;margin:0 0 6px">Thanks, ${esc(cust.name)}. Here is your order with ${esc(s.dealer_name)} for the ${esc(cyc ? cyc.delivery_label : "")} cycle.</p>` +
    `<table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0"><thead><tr><th ${thL}>Item</th><th ${th}>Qty</th><th ${th}>Unit</th><th ${th}>Freight</th><th ${th}>Line Total</th></tr></thead><tbody>${rows}` +
    `<tr><td colspan="4" style="padding:7px 10px;text-align:right;font-weight:bold;color:${NAVY};background:#EAF1E5">Estimated Total (${bags} bags)</td><td style="padding:7px 10px;text-align:right;font-weight:bold;color:${NAVY};background:#EAF1E5">${money(total)}</td></tr></tbody></table>` +
    `<p style="color:#777;font-size:12px;margin-top:8px">Prices include $${s.freight.toFixed(2)}/bag freight. Your itemized invoice follows after the cycle closes. Need to change something before ${esc(s.close_day)} ${esc(s.close_time)}? Open your order link or reply to this email.</p>`);
  const itemsText = items.map(i => {
    const p = product(i.product_id); const unit = round2(basePrice(p, s)); const freight = round2(i.qty * s.freight); const lt = round2(i.qty * unit + freight);
    return `  ${i.qty} x ${p.name} @ ${money(unit)} (+${money(freight)} frt) = ${money(lt)}`;
  }).join("\n");
  const text = `Thanks, ${cust.name}. Order received for the ${cyc ? cyc.delivery_label : ""} cycle.\n\n${itemsText}\n\nEstimated Total (${bags} bags): ${money(total)} (incl. $${s.freight.toFixed(2)}/bag freight)\n\nReply to change anything before ${s.close_day} ${s.close_time}.`;
  return { subject, text, html };
}
function emailCycleOpen(cust) {
  const s = db().settings; const cyc = getOrCreateCycle(s);
  const link = BASE_URL + "/o/" + cust.link_token;
  const subject = "Feed ordering is open — delivers " + cyc.delivery_label;
  const html = wrapHtml(
    `<h2 style="color:${NAVY};margin:0 0 6px">Feed ordering is open</h2><p style="color:#555">Hi ${esc(cust.name)}, the ${esc(cyc.delivery_label)} feed cycle is open. Tap your private link to place your order:</p>` +
    `<p style="margin:16px 0"><a href="${link}" style="background:${NAVY};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:bold">Place my order</a></p>` +
    `<p style="color:#777;font-size:12px">Orders close ${esc(s.close_day)} ${esc(s.close_time)}. This link is just for you and always opens your current order.</p>`);
  const text = `Hi ${cust.name}, feed ordering for ${cyc.delivery_label} is open. Place your order: ${link} (closes ${s.close_day} ${s.close_time}).`;
  return { subject, text, html };
}
function emailInvoice(inv) {
  const s = db().settings;
  const link = BASE_URL + "/invoice/" + inv.id;
  const subject = "Invoice " + inv.invoice_num + " — " + s.payable_to;
  const th = `style="background:${NAVY};color:#fff;padding:6px 10px;text-align:right;font-size:12px"`;
  const thL = `style="background:${NAVY};color:#fff;padding:6px 10px;text-align:left;font-size:12px"`;
  const td = `style="padding:6px 10px;border-bottom:1px solid #efe7d6;text-align:right"`;
  const tdL = `style="padding:6px 10px;border-bottom:1px solid #efe7d6;text-align:left"`;
  const lineRows = (inv.lines || []).map(l =>
    `<tr><td ${tdL}>${esc(l.description)}</td><td ${td}>${l.qty}</td><td ${td}>${money(l.unitPrice)}</td><td ${td}>${money(l.freight)}</td><td ${td}>${money(l.total)}</td></tr>`).join("");
  const itemsTable =
    `<table style="border-collapse:collapse;width:100%;font-size:13px;margin:12px 0">` +
    `<thead><tr><th ${thL}>Item</th><th ${th}>Qty</th><th ${th}>Unit</th><th ${th}>Freight</th><th ${th}>Line Total</th></tr></thead>` +
    `<tbody>${lineRows}</tbody></table>`;
  const appliedCredits = (db().credits || []).reduce((arr, c) => {
    (c.applications || []).forEach(a => { if (a.invoice_id === inv.id) arr.push({ reason: c.reason || "Account credit", amount: a.amount }); });
    return arr;
  }, []);
  const creditRowsHtml = appliedCredits.length
    ? appliedCredits.map(c => `<tr><td style="padding:4px 10px;color:#7a1f1f">Credit — ${esc(c.reason)}</td><td style="padding:4px 10px;text-align:right;color:#7a1f1f">&minus;${money(c.amount)}</td></tr>`).join("")
    : (inv.credit_total ? `<tr><td style="padding:4px 10px">Credit applied</td><td style="padding:4px 10px;text-align:right">&minus;${money(inv.credit_total)}</td></tr>` : "");
  const totals =
    `<table style="border-collapse:collapse;font-size:13px;margin:6px 0 6px auto">` +
    `<tr><td style="padding:4px 10px">Subtotal</td><td style="padding:4px 10px;text-align:right">${money(inv.subtotal)}</td></tr>` +
    (inv.tax ? `<tr><td style="padding:4px 10px">Tax</td><td style="padding:4px 10px;text-align:right">${money(inv.tax)}</td></tr>` : "") +
    creditRowsHtml +
    `<tr><td style="padding:7px 10px;font-weight:bold;color:${NAVY};background:#EAF1E5">Total Due</td><td style="padding:7px 10px;text-align:right;font-weight:bold;color:${NAVY};background:#EAF1E5">${money(inv.total)}</td></tr></table>`;
  const html = wrapHtml(
    `<h2 style="color:${NAVY};margin:0 0 6px">Your invoice</h2><p style="color:#555">Hi ${esc(inv.customer_name)}, here is your invoice for the ${esc(inv.cycle_label)} feed cycle.</p>` +
    `<p style="font-size:13px;color:#555;margin:0"><b>Invoice #:</b> ${inv.invoice_num} &nbsp;·&nbsp; <b>Date:</b> ${inv.date_issued} &nbsp;·&nbsp; <b>Cycle:</b> ${esc(inv.cycle_label)}</p>` +
    itemsTable + totals +
    `<p style="margin:16px 0"><a href="${link}" style="background:${NAVY};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:bold">View / print invoice</a></p>` +
    `<p style="color:#777;font-size:12px">Payment options: Check payable to ${esc(s.payable_to)} · Venmo ${esc(s.venmo)}. ${esc(s.invoice_terms)}</p>`);
  const itemsText = (inv.lines || []).map(l => `  ${l.qty} x ${l.description} @ ${money(l.unitPrice)} (+${money(l.freight)} frt) = ${money(l.total)}`).join("\n");
  const creditsText = appliedCredits.length
    ? "\n" + appliedCredits.map(c => `Credit — ${c.reason}: -${money(c.amount)}`).join("\n")
    : (inv.credit_total ? `\nCredit applied -${money(inv.credit_total)}` : "");
  const text = `Hi ${inv.customer_name},\nInvoice ${inv.invoice_num} — ${inv.cycle_label} cycle\n\n${itemsText}\n\nSubtotal ${money(inv.subtotal)}` +
    creditsText +
    `\nTotal Due ${money(inv.total)}\n\nView / print: ${link}\nPay by check to ${s.payable_to} or Venmo ${s.venmo}. ${s.invoice_terms}`;
  return { subject, text, html };
}
function emailReminder(pay) {
  const s = db().settings;
  const subject = (pay.reminders >= 1 ? "Reminder #" + (pay.reminders + 1) + " — " : "Friendly reminder — ") + "Invoice " + pay.invoice_num + " from " + s.dealer_name;
  const text = `Hi ${pay.customer_name},\n\nFriendly reminder that your invoice from the ${pay.cycle} feed cycle is still outstanding:\n\n  Invoice #: ${pay.invoice_num}\n  Amount Due: ${money(pay.amount)}\n\nPayment options:\n  - Check payable to ${s.payable_to}\n  - Venmo: ${s.venmo}\n\nIf you've already sent payment, please disregard. Questions? Reply or call ${s.phone}.\n\nThanks!\nDerek Evans\n${s.dealer_name}`;
  const html = wrapHtml(
    `<h2 style="color:${NAVY};margin:0 0 6px">Payment reminder</h2><p style="color:#555">Hi ${esc(pay.customer_name)}, a friendly reminder that your invoice from the ${esc(pay.cycle)} feed cycle is still outstanding:</p>` +
    `<table style="border-collapse:collapse;margin:12px 0;font-size:14px"><tr><td style="padding:6px 12px;border:1px solid #ddd"><b>Invoice #</b></td><td style="padding:6px 12px;border:1px solid #ddd">${pay.invoice_num}</td></tr><tr><td style="padding:6px 12px;border:1px solid #ddd"><b>Amount Due</b></td><td style="padding:6px 12px;border:1px solid #ddd">${money(pay.amount)}</td></tr></table>` +
    `<p style="color:#555">Payment options: Check payable to ${esc(s.payable_to)} · Venmo ${esc(s.venmo)}.</p>` +
    `<p style="color:#777;font-size:12px">If you've already sent payment, please disregard. Questions? Reply or call ${esc(s.phone)}.</p>`);
  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Outbox + queue. Records every message + delivery status; sends if a provider
// is configured, otherwise captures it for review ("outbox" mode).
// ---------------------------------------------------------------------------
function ensureOutbox() { if (!db().outbox) { db().outbox = []; save(); } }
async function queueMail(kind, to, toName, msg) {
  ensureOutbox();
  const s = db().settings;
  // CC the dealer on the mill order and on customer invoices, so they get a copy
  // the moment it goes out and can catch a bad address or wrong total early.
  // Controlled by settings.dealer_cc_email (falls back to the dealer's own email).
  let cc = msg.cc;
  if (!cc && (kind === "mill" || kind === "invoice")) {
    const ccRaw = ((s.dealer_cc_email !== undefined ? s.dealer_cc_email : s.email) || "").trim();
    if (ccRaw && ccRaw.toLowerCase() !== String(to || "").toLowerCase()) cc = ccRaw;
  }
  // Reply-To = the dealer's OWN email, so a customer (or the mill) who hits reply
  // reaches the LOCAL dealer, not the platform address we send from. This keeps every
  // dealer's customer conversations local to that dealer instead of funneling 400
  // dealers' questions into the platform inbox. settings.reply_to_email can override;
  // otherwise it falls back to the dealer's email.
  let replyTo = msg.replyTo;
  if (!replyTo) {
    const rt = ((s.reply_to_email !== undefined ? s.reply_to_email : s.email) || "").trim();
    if (rt && rt.toLowerCase() !== String(to || "").toLowerCase()) replyTo = rt;
  }
  const result = await mailer.send({ to, cc, replyTo, subject: msg.subject, text: msg.text, html: msg.html }, { dealerEmail: s.email, dealerName: s.dealer_name });
  const entry = {
    id: nextId("outbox"), kind, to: to || "", to_name: toName || "", cc: cc || "", reply_to: replyTo || "",
    subject: msg.subject, text: msg.text, html: msg.html,
    created_at: new Date().toISOString(), status: result.status, provider: result.provider, error: result.error || ""
  };
  db().outbox.push(entry); save();
  return entry;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json", "Cache-Control": "no-store" });
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), "application/json"); }
function readBody(req) {
  return new Promise(resolve => { let b = ""; req.on("data", c => b += c); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });
}
function readRaw(req) { // unparsed body string — Stripe webhook signature needs this
  return new Promise(resolve => { let b = ""; req.on("data", c => b += c); req.on("end", () => resolve(b)); });
}
function isAdmin(req) {
  const pass = req.headers["x-dc-pass"] || "";
  return pass === ADMIN_PASSCODE;
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
function serveStatic(res, file) {
  if (!STATIC_ALLOW.has(file)) return send(res, 404, "Not found", "text/plain");
  const full = path.join(PUBLIC, file);
  if (!fs.existsSync(full)) return send(res, 404, "Not found", "text/plain");
  send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || "application/octet-stream");
}

// ---------------------------------------------------------------------------
// Customer-facing payload
// ---------------------------------------------------------------------------
function bootstrapForCustomer(cust) {
  const s = db().settings;
  const cyc = getOrCreateCycle(s);
  const ws = windowState(s);
  const order = customerOrder(cust.id, cyc.id);
  const myItems = {};
  if (order) orderItems(order.id).forEach(i => { myItems[i.product_id] = i.qty; });
  const products = db().products.filter(p => p.active).map(p => ({
    id: p.id, name: p.name, category: p.category, size: p.size,
    bag_hex: p.bag_hex, bag_color_name: p.bag_color_name, allIn: round2(allIn(p, s))
  }));
  return {
    dealer: s.dealer_name, customer: { name: cust.name }, freight: s.freight,
    categoryOrder: db().categoryOrder, categoryColors: db().categoryColors,
    products, myItems, window: ws,
    cycle: { label: cyc.delivery_label, close_day: s.close_day, close_time: s.close_time },
    submitted: !!(order && order.status === "submitted")
  };
}

// ---------------------------------------------------------------------------
// Admin payload
// ---------------------------------------------------------------------------
function adminData() {
  const s = db().settings;
  const cyc = getOrCreateCycle(s);
  const tally = tallyCycle(cyc.id);
  const products = db().products;
  const orders = db().orders.filter(o => o.cycle_id === cyc.id && o.status === "submitted").map(o => {
    const cust = findCustomerById(o.customer_id);
    const items = orderItems(o.id).filter(i => i.qty > 0).map(i => ({ id: i.product_id, name: product(i.product_id).name, qty: i.qty }));
    const bags = items.reduce((a, i) => a + i.qty, 0);
    const total = items.reduce((a, i) => a + i.qty * allIn(product(i.id), s), 0);
    return { customer_id: o.customer_id, customer: cust ? cust.name : "?", items, bags, total: round2(total), updated_at: o.updated_at, has_invoice: !!db().invoices.find(v => v.customer_id === o.customer_id && v.cycle_id === cyc.id) };
  });
  const pricing = products.map(p => ({
    id: p.id, name: p.name, category: p.category, size: p.size, bag_hex: p.bag_hex, bag_color_name: p.bag_color_name,
    wholesale: p.wholesale, srp: p.srp, base: round2(basePrice(p, s)), preTax: round2(preTax(p, s)),
    allIn: round2(allIn(p, s)), margin: round2(marginBag(p, s))
  }));
  return {
    settings: s,
    cycle: cyc,
    window: windowState(s),
    categoryOrder: db().categoryOrder,
    categoryColors: db().categoryColors,
    customers: db().customers.map(c => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, address: c.address, payment_method: c.payment_method, payment_detail_label: c.payment_detail_label, link_token: c.link_token, source: c.source })),
    orders,
    tally: Object.keys(tally).map(pid => ({ id: pid, name: product(pid).name, category: product(pid).category, bags: tally[pid], revenue: round2(tally[pid] * allIn(product(pid), s)), bag_hex: product(pid).bag_hex })).sort((a, b) => b.bags - a.bags),
    pricing,
    invoices: db().invoices.map(v => ({ id: v.id, invoice_num: v.invoice_num, customer_id: v.customer_id, customer_name: v.customer_name, cycle_label: v.cycle_label, date_issued: v.date_issued, total: v.total, cancelled: !!v.cancelled, cancel_reason: v.cancel_reason || "", walk_in: !!v.walk_in, fulfilled: !!(v.fulfilled_items && v.fulfilled_items.length) })).sort((a, b) => b.id - a.id),
    payments: db().payments.map(p => ({ ...p })).sort((a, b) => Number(a.paid) - Number(b.paid) || b.id - a.id),
    credits: (db().credits || []).map(c => ({ ...c })).sort((a, b) => b.id - a.id),
    mail_provider: mailer.providerName(),
    outbox: (db().outbox || []).map(o => ({ id: o.id, kind: o.kind, to: o.to, to_name: o.to_name, cc: o.cc || "", subject: o.subject, text: o.text, created_at: o.created_at, status: o.status, provider: o.provider, error: o.error })).sort((a, b) => b.id - a.id),
    inventory_enabled: !!s.inventory_enabled,
    inventory: inventoryView(),
    bills: (db().bills || []).map(b => ({ ...b })).sort((a, b) => Number(a.status === "paid") - Number(b.status === "paid") || (a.due_date < b.due_date ? -1 : 1)),
    money: moneyPosition(),
    stock_movements: (db().stock_movements || []).slice().sort((a, b) => b.id - a.id).slice(0, 60),
    qbo_log: (db().qbo_log || []).slice().sort((a, b) => b.id - a.id).slice(0, 40),
    payments_provider: payments.providerName(),
    subscription: db().subscription || null
  };
}

// Money position for dealers without QuickBooks: A/R (customers owe you) vs
// A/P (you owe the mill/vendors). Simple cash tracker — not real accounting.
function moneyPosition() {
  const pays = db().payments || [];
  const bills = db().bills || [];
  const ar_out = round2(pays.filter(p => !p.paid).reduce((a, p) => a + (p.amount || 0), 0));
  const ar_in = round2(pays.filter(p => p.paid).reduce((a, p) => a + (p.amount || 0), 0));
  const ap_out = round2(bills.filter(b => b.status !== "paid").reduce((a, b) => a + (b.amount || 0), 0));
  const ap_paid = round2(bills.filter(b => b.status === "paid").reduce((a, b) => a + (b.amount || 0), 0));
  return { ar_out, ar_in, ap_out, ap_paid, net: round2(ar_out - ap_out) };
}

// Per-product live inventory for the dashboard (only carried products).
function inventoryView() {
  ensureInventory();
  const s = db().settings;
  return db().inventory_items.map(it => {
    const p = product(it.product_id) || {};
    const committed = committedQty(it.product_id);
    const onHand = round2(it.on_hand || 0);
    const available = Math.max(0, round2(onHand - committed));
    return {
      product_id: it.product_id, name: p.name || it.product_id, category: p.category || "",
      bag_hex: p.bag_hex || "#999", size: p.size || "",
      on_hand: onHand, committed, available,
      reorder_point: it.reorder_point || 0, reorder_qty: it.reorder_qty || 0,
      avg_cost: round2(it.avg_cost || 0), value: round2(onHand * (it.avg_cost || 0)),
      low: available <= (it.reorder_point || 0)
    };
  }).sort((a, b) => (a.low === b.low ? a.name.localeCompare(b.name) : (a.low ? -1 : 1)));
}

function millOrderText(cycArg) {
  const s = db().settings;
  const cyc = cycArg || getOrCreateCycle(s);
  const tally = tallyCycle(cyc.id);
  const order = db().categoryOrder;
  const rows = Object.keys(tally).map(pid => [product(pid), tally[pid]])
    .sort((a, b) => order.indexOf(a[0].category) - order.indexOf(b[0].category) || b[1] - a[1]);
  const codes = s.umbarger_codes || {};
  let total = 0; let body = "";
  rows.forEach(([p, bags]) => {
    const code = codes[p.id] || "—";
    body += `\n${code.padEnd(10)}${String(bags).padStart(3)}  ${p.name}`; total += bags;
  });
  return `Umbarger Order — ${s.dealer_name}\nDelivering ${cyc.delivery_label} · to ${s.mill_contact_name}\n${"=".repeat(46)}\nITEM       QTY  DESCRIPTION${body}\n${"=".repeat(46)}\nTOTAL: ${total} bags  (BAG)`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    // ----- customer order screen -----
    if (req.method === "GET" && p.startsWith("/o/")) {
      return serveStatic(res, "order.html");
    }
    // ----- public self-signup (gated by settings.public_signup; used by the demo) -----
    if (req.method === "GET" && p === "/start") {
      if (!db().settings.public_signup) return send(res, 404, "Not found", "text/plain");
      return serveStatic(res, "start.html");
    }
    if (req.method === "POST" && p === "/api/start") {
      if (!db().settings.public_signup) return json(res, 403, { error: "Sign-up is not open." });
      const body = await readBody(req);
      const name = (body.name || "").trim();
      if (!name) return json(res, 400, { error: "Please enter your name." });
      const c = { id: nextId("customers"), link_token: crypto.randomBytes(16).toString("hex"), source: "self", active: 1,
        name: name, email: (body.email || "").trim(), phone: (body.phone || "").trim(), payment_method: "Check", payment_detail_label: "" };
      db().customers.push(c); save();
      return json(res, 200, { ok: true, token: c.link_token });
    }
    if (req.method === "GET" && p === "/api/bootstrap") {
      const cust = findCustomerByToken(u.searchParams.get("token"));
      if (!cust) return json(res, 404, { error: "Invalid link." });
      return json(res, 200, bootstrapForCustomer(cust));
    }
    if (req.method === "POST" && p === "/api/order") {
      const body = await readBody(req);
      const cust = findCustomerByToken(body.token);
      if (!cust) return json(res, 404, { error: "Invalid link." });
      const s = db().settings;
      const ws = windowState(s);
      if (!ws.open) return json(res, 403, { error: "The ordering window is closed right now." });
      const cyc = getOrCreateCycle(s);
      let order = customerOrder(cust.id, cyc.id);
      if (!order) { order = { id: nextId("orders"), customer_id: cust.id, cycle_id: cyc.id, status: "submitted", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; db().orders.push(order); }
      order.status = "submitted"; order.updated_at = new Date().toISOString();
      db().order_items = db().order_items.filter(i => i.order_id !== order.id);
      let bags = 0;
      (body.items || []).forEach(it => { const q = Number(it.qty) || 0; if (q > 0 && product(it.id)) { db().order_items.push({ id: nextId("order_items"), order_id: order.id, product_id: it.id, qty: q }); bags += q; } });
      // update contact info if provided
      if (body.email) cust.email = body.email;
      if (body.phone) cust.phone = body.phone;
      save();
      // confirmation email (sends if a provider is set, else captured to the Outbox)
      let mail = null;
      if (cust.email) { try { mail = await queueMail("confirmation", cust.email, cust.name, emailOrderConfirmation(cust, order)); } catch (e) {} }
      // Optional: auto-generate + email the invoice a set number of minutes after the order
      // (gated by settings.auto_invoice_minutes; used by the demo to email the invoice ~1 min later).
      const aim = Number(db().settings.auto_invoice_minutes) || 0;
      if (aim > 0 && cust.email) {
        const cid = cust.id, cyid = cyc.id, em = cust.email, nm = cust.name;
        setTimeout(async () => {
          try { const inv = buildInvoiceForCustomer(cid, cyid); if (inv) await queueMail("invoice", em, nm, emailInvoice(inv)); }
          catch (e) { console.error("auto-invoice failed:", e); }
        }, aim * 60000);
      }
      return json(res, 200, { ok: true, bags, email: mail ? mail.status : "no-email" });
    }

    // ----- customer's own invoice history + per-year totals (via their link token) -----
    if (req.method === "GET" && p === "/api/my-history") {
      const cust = findCustomerByToken(u.searchParams.get("token"));
      if (!cust) return json(res, 404, { error: "Invalid link." });
      const payByInv = {}; db().payments.forEach(pp => { payByInv[pp.invoice_id] = pp; });
      const invs = db().invoices.filter(v => v.customer_id === cust.id);
      const invoices = invs.map(v => {
        const pay = payByInv[v.id];
        return { id: v.id, invoice_num: v.invoice_num, cycle_label: v.cycle_label, date_issued: v.date_issued, total: v.total, paid: pay ? !!pay.paid : false, date_paid: pay ? pay.date_paid : null };
      }).sort((a, b) => (a.date_issued < b.date_issued ? 1 : -1));
      const byYear = {};
      invs.forEach(v => {
        const y = String(v.date_issued || "").slice(0, 4); if (!y) return;
        byYear[y] = byYear[y] || { year: y, total: 0, count: 0, paid: 0, unpaid: 0 };
        byYear[y].total += v.total; byYear[y].count++;
        const pay = payByInv[v.id];
        if (pay && pay.paid) byYear[y].paid += v.total; else byYear[y].unpaid += v.total;
      });
      const years = Object.values(byYear).sort((a, b) => b.year.localeCompare(a.year))
        .map(y => ({ year: y.year, count: y.count, total: round2(y.total), paid: round2(y.paid), unpaid: round2(y.unpaid) }));
      return json(res, 200, { dealer: db().settings.dealer_name, customer: { name: cust.name }, invoices, years });
    }

    // ----- invoice view (public link, by invoice id) -----
    if (req.method === "GET" && p.startsWith("/invoice/")) {
      const inv = db().invoices.find(v => v.id === Number(p.split("/")[2]));
      if (!inv) return send(res, 404, "Invoice not found", "text/plain");
      return send(res, 200, invoiceHtml(inv), "text/html");
    }

    // ===================== PAYMENTS (Stripe + simulated) =====================
    // Stripe webhook — must read the RAW body for signature verification, and is
    // NOT behind the admin passcode (Stripe calls it directly).
    if (req.method === "POST" && p === "/api/stripe/webhook") {
      const raw = await readRaw(req);
      const evt = payments.verifyWebhook(raw, req.headers["stripe-signature"]);
      if (!evt) return send(res, 400, "bad signature", "text/plain");
      try {
        if (evt.type === "checkout.session.completed") {
          const sess = evt.data.object || {};
          const md = sess.metadata || {};
          if (md.kind === "invoice") {
            markInvoicePaid(Number(md.invoice_id), "Card", Number(md.surcharge || 0));
          } else if (md.kind === "subscription") {
            activateSubscription(md.method || "ach", { stripe_customer_id: sess.customer, stripe_subscription_id: sess.subscription });
          }
        }
      } catch (e) { console.error("webhook handler:", e); }
      return json(res, 200, { received: true });
    }
    // Customer starts paying an invoice by card -> returns a checkout URL.
    if (req.method === "POST" && p === "/api/pay") {
      const body = await readBody(req);
      const inv = db().invoices.find(v => v.id === Number(body.invoice_id));
      if (!inv) return json(res, 404, { error: "Invoice not found." });
      const pay = (db().payments || []).find(pp => pp.invoice_id === inv.id);
      if (inv.cancelled) return json(res, 400, { error: "This invoice was cancelled." });
      if (pay && pay.paid) return json(res, 400, { error: "This invoice is already paid." });
      const s = db().settings;
      const pct = payments.effectiveSurchargePct(s, s.dealer_state);
      const sc = payments.surchargeAmount(inv.total, pct);
      const cust = findCustomerById(inv.customer_id);
      try {
        const r = await payments.createInvoiceCheckout({
          invoiceId: inv.id, invoiceNum: inv.invoice_num, dealerName: s.dealer_name,
          amount: inv.total, surcharge: sc, surchargeLabel: s.surcharge_label,
          customerEmail: cust ? cust.email : "",
          successUrl: BASE_URL + "/pay/success?invoice=" + inv.id,
          cancelUrl: BASE_URL + "/invoice/" + inv.id
        });
        return json(res, 200, { url: r.url, provider: r.provider, surcharge: sc, card_total: round2(inv.total + sc) });
      } catch (e) { return json(res, 502, { error: "Payment setup failed: " + String(e.message || e) }); }
    }
    // Simulated card / ACH checkout page for an invoice (only used when no Stripe key).
    if (req.method === "GET" && p === "/pay/sim") {
      const id = Number(u.searchParams.get("invoice"));
      const inv = db().invoices.find(v => v.id === id);
      if (!inv) return send(res, 404, "Invoice not found", "text/plain");
      const s = db().settings;
      return send(res, 200, simCheckoutPage({
        mode: "invoice", merchant: s.dealer_name, invoiceNum: inv.invoice_num,
        amount: inv.total, surchargePct: payments.effectiveSurchargePct(s, s.dealer_state),
        action: "/api/pay/sim/complete", payload: { invoice_id: inv.id },
        done: "/pay/success?invoice=" + inv.id, defaultMethod: "card"
      }), "text/html");
    }
    if (req.method === "POST" && p === "/api/pay/sim/complete") {
      if (payments.isLive()) return json(res, 400, { error: "Live mode — use real Stripe." });
      const body = await readBody(req);
      markInvoicePaid(Number(body.invoice_id), body.method === "ach" ? "ACH" : "Card", Number(body.surcharge || 0));
      return json(res, 200, { ok: true });
    }
    // Simulated subscription checkout page (only used when no Stripe key).
    if (req.method === "GET" && p === "/pay/sim-sub") {
      const s = db().settings;
      const method = u.searchParams.get("method") === "card" ? "card" : "ach";
      return send(res, 200, simCheckoutPage({
        mode: "subscription", merchant: "DealerCycle subscription",
        amount: Number(s.sub_intro_price) || 59.99, surchargePct: payments.effectiveSurchargePct(s, s.dealer_state),
        introMonths: Number(s.sub_intro_months) || 6, listPrice: Number(s.sub_list_price) || 99,
        action: "/api/sub/sim/complete", payload: {}, done: "/admin", defaultMethod: method
      }), "text/html");
    }
    if (req.method === "POST" && p === "/api/sub/sim/complete") {
      if (payments.isLive()) return json(res, 400, { error: "Live mode — use real Stripe." });
      const body = await readBody(req);
      activateSubscription(body.method === "card" ? "card" : "ach", {});
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/pay/success") {
      return send(res, 200, simResultPage("Payment received", "Thank you — your payment is recorded. You can close this page."), "text/html");
    }

    // ----- admin app -----
    if (req.method === "GET" && (p === "/" || p === "/admin")) return serveStatic(res, "admin.html");

    // ----- phone-framed dealer preview (for the pitch) -----
    if (req.method === "GET" && (p === "/phone" || p === "/dealer-phone")) return serveStatic(res, "phone.html");

    // ----- admin API (passcode gated) -----
    if (p.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
      if (req.method === "GET" && p === "/api/admin/data") return json(res, 200, adminData());
      if (req.method === "GET" && p === "/api/admin/mill") return json(res, 200, { text: millOrderText() });
      if (req.method === "GET" && p === "/api/admin/export") {
        const rows = [["Invoice #", "Customer", "Cycle", "Date Issued", "Amount", "Paid", "Date Paid", "Method", "Reminders"]];
        db().payments.forEach(p2 => rows.push([p2.invoice_num, p2.customer_name, p2.cycle, p2.date_issued, p2.amount, p2.paid ? "YES" : "NO", p2.date_paid || "", p2.method, p2.reminders]));
        const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
        res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=dealercycle_payments.csv" });
        return res.end(csv);
      }
      const body = await readBody(req);
      if (req.method === "POST" && p === "/api/admin/customer") {
        let c = body.id ? findCustomerById(body.id) : null;
        if (!c) { c = { id: nextId("customers"), link_token: crypto.randomBytes(16).toString("hex"), source: body.source || "added", active: 1 }; db().customers.push(c); }
        ["name", "phone", "email", "address", "payment_method", "payment_detail_label"].forEach(k => { if (body[k] !== undefined) c[k] = body[k]; });
        save();
        return json(res, 200, { ok: true, customer: c });
      }
      if (req.method === "POST" && p === "/api/admin/customer/delete") {
        const id = body.id;
        const cust = findCustomerById(id);
        if (!cust) return json(res, 404, { error: "not found" });
        const orderIds = db().orders.filter(o => o.customer_id === id).map(o => o.id);
        const invIds = db().invoices.filter(v => v.customer_id === id).map(v => v.id);
        db().order_items = db().order_items.filter(i => !orderIds.includes(i.order_id));
        db().orders = db().orders.filter(o => o.customer_id !== id);
        db().payments = db().payments.filter(pp => !invIds.includes(pp.invoice_id));
        db().invoices = db().invoices.filter(v => v.customer_id !== id);
        db().customers = db().customers.filter(c => c.id !== id);
        save();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/admin/settings") {
        Object.assign(db().settings, body); save();
        return json(res, 200, { ok: true, settings: db().settings });
      }
      // ----- price-sheet import: preview (match by name) and apply (by id) -----
      if (req.method === "POST" && p === "/api/admin/prices/preview") {
        const norm = (x) => String(x || "").toLowerCase()
          .replace(/[®™•]/g, "").replace(/\b\d+(\.\d+)?\s*(%|lb|lbs|#|oz|gal|qt|g)\b/gi, " ")
          .replace(/\bw\/|\bwith\b|\bper\b|\bbag\b|\bcase\b|\bbucket\b|\bjug\b|\bmedicated\b/gi, " ")
          .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
        const prods = db().products.map(p2 => ({ p: p2, n: norm(p2.name) }));
        const matched = [], unmatched = [];
        (body.rows || []).forEach(r => {
          const rn = norm(r.name);
          if (!rn) return;
          let hit = prods.find(x => x.n === rn);
          if (!hit) hit = prods.find(x => x.n && (x.n.includes(rn) || rn.includes(x.n)) && Math.min(x.n.length, rn.length) >= 4);
          const wh = r.wholesale === undefined || r.wholesale === "" ? null : round2(Number(r.wholesale));
          const srp = r.srp === undefined || r.srp === "" ? null : round2(Number(r.srp));
          if (hit) matched.push({ id: hit.p.id, name: hit.p.name, category: hit.p.category, sheet_name: r.name, old_wholesale: hit.p.wholesale, old_srp: hit.p.srp, new_wholesale: wh, new_srp: srp });
          else unmatched.push({ sheet_name: r.name, wholesale: wh, srp: srp });
        });
        return json(res, 200, { ok: true, matched, unmatched });
      }
      if (req.method === "POST" && p === "/api/admin/prices/apply") {
        let applied = 0; const list = [];
        (body.updates || []).forEach(u => {
          const prod = db().products.find(x => x.id === u.id);
          if (!prod) return;
          const before = { wholesale: prod.wholesale, srp: prod.srp };
          if (u.wholesale !== undefined && u.wholesale !== null && u.wholesale !== "") prod.wholesale = round2(Number(u.wholesale));
          if (u.srp !== undefined && u.srp !== null && u.srp !== "") prod.srp = round2(Number(u.srp));
          if (prod.wholesale !== before.wholesale || prod.srp !== before.srp) { applied++; list.push({ id: prod.id, name: prod.name, wholesale: prod.wholesale, srp: prod.srp }); }
        });
        if (applied) save();
        return json(res, 200, { ok: true, applied, list });
      }
      if (req.method === "POST" && p === "/api/admin/invoices/generate") {
        const s = db().settings; const cyc = getOrCreateCycle(s);
        let made = 0; let emailed = 0; const list = [];
        const sendEmail = body.email !== false; // email newly-created invoices by default
        const targets = body.customer_id ? [body.customer_id] : db().orders.filter(o => o.cycle_id === cyc.id && o.status === "submitted").map(o => o.customer_id);
        for (const cid of targets) {
          const wasNew = !db().invoices.find(v => v.customer_id === cid && v.cycle_id === cyc.id);
          const inv = buildInvoiceForCustomer(cid, cyc.id);
          if (inv) {
            made++; list.push({ id: inv.id, customer: inv.customer_name, num: inv.invoice_num, total: inv.total });
            if (sendEmail && wasNew) { const cust = findCustomerById(cid); if (cust && cust.email) { await queueMail("invoice", cust.email, cust.name, emailInvoice(inv)); emailed++; } }
          }
        }
        return json(res, 200, { ok: true, made, emailed, list });
      }
      if (req.method === "POST" && p === "/api/admin/cycle-open") {
        let sent = 0; let captured = 0; let noEmail = 0;
        for (const c of db().customers.filter(x => x.active)) {
          if (!c.email) { noEmail++; continue; }
          const e = await queueMail("cycle-open", c.email, c.name, emailCycleOpen(c));
          if (e.status === "sent") sent++; else captured++;
        }
        return json(res, 200, { ok: true, sent, captured, noEmail });
      }
      if (req.method === "POST" && p === "/api/admin/mill/send") {
        const r = await emailMillOrder();
        return json(res, r.ok ? 200 : 400, r);
      }
      if (req.method === "POST" && p === "/api/admin/reset") {
        // Clear test activity but KEEP catalog, customers (and their link tokens), and settings.
        const d = db();
        d.orders = []; d.order_items = []; d.invoices = []; d.payments = []; d.outbox = []; d.cycles = []; d.credits = [];
        d.settings.invoice_counter = 0;
        save();
        return json(res, 200, { ok: true });
      }
      // One-time historical import: loads prior-system invoices + payment status as
      // native records (matched to customers by name). Idempotent on invoice_num.
      if (req.method === "POST" && p === "/api/admin/import-history") {
        const d = db();
        const recs = Array.isArray(body.records) ? body.records : [];
        let made = 0, skipped = 0, maxNum = d.settings.invoice_counter || 0;
        const unmatched = [];
        for (const r of recs) {
          if (d.invoices.find(v => v.invoice_num === r.invoice_num)) { skipped++; continue; }
          const nm = String(r.customer_name || "").trim().toLowerCase();
          const cust = d.customers.find(c => String(c.name).trim().toLowerCase() === nm);
          if (!cust) { unmatched.push(r.customer_name); continue; }
          let cyc = d.cycles.find(c => c.delivery_label === r.cycle_label);
          if (!cyc) { cyc = { id: nextId("cycles"), delivery_key: r.cycle_label, delivery_label: r.cycle_label, status: "closed" }; d.cycles.push(cyc); }
          const amt = round2(Number(r.amount) || 0);
          let lines, order = null;
          if (Array.isArray(r.items) && r.items.length) {
            lines = r.items.map(it => ({
              description: it.name,
              qty: Number(it.qty) || 0,
              unitPrice: round2(Number(it.unitPrice) || 0),
              freight: round2(Number(it.freight) || 0),
              total: round2(Number(it.total) || 0)
            }));
            // create an order + order_items so the cycle's order detail exists too
            order = { id: nextId("orders"), customer_id: cust.id, cycle_id: cyc.id, status: "submitted", created_at: (r.date_issued ? r.date_issued + "T12:00:00.000Z" : new Date().toISOString()), updated_at: new Date().toISOString(), imported: true };
            d.orders.push(order);
            r.items.forEach(it => {
              const prod = d.products.find(pp => String(pp.name).trim().toLowerCase() === String(it.name).trim().toLowerCase());
              if (prod) d.order_items.push({ id: nextId("order_items"), order_id: order.id, product_id: prod.id, qty: Number(it.qty) || 0 });
            });
          } else {
            lines = [{ description: "Prior order system invoice " + r.invoice_num + " (" + cyc.delivery_label + " cycle)", qty: 1, unitPrice: amt, freight: 0, total: amt }];
          }
          const inv = {
            id: nextId("invoices"),
            invoice_num: r.invoice_num,
            customer_id: cust.id,
            customer_name: cust.name,
            cycle_id: cyc.id,
            cycle_label: cyc.delivery_label,
            date_issued: r.date_issued || "",
            order_id: order ? order.id : undefined,
            lines,
            subtotal: amt, tax_rate: 0, tax: 0, total: amt, freight_rate: d.settings.freight,
            imported: true
          };
          d.invoices.push(inv);
          d.payments.push({
            id: nextId("payments"),
            invoice_id: inv.id,
            invoice_num: inv.invoice_num,
            customer_id: cust.id,
            customer_name: cust.name,
            amount: amt,
            cycle: cyc.delivery_label,
            date_issued: inv.date_issued,
            paid: !!r.paid,
            date_paid: r.date_paid || null,
            method: r.method || "",
            notes: r.notes || "",
            reminders: Number(r.reminders) || 0,
            imported: true
          });
          const m = /(\d+)\s*$/.exec(String(r.invoice_num));
          if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
          made++;
        }
        d.settings.invoice_counter = Math.max(d.settings.invoice_counter || 0, maxNum);
        save();
        return json(res, 200, { ok: true, made, skipped, unmatched });
      }
      if (req.method === "POST" && p === "/api/admin/outbox/resend") {
        ensureOutbox();
        const entry = db().outbox.find(x => x.id === body.id);
        if (!entry) return json(res, 404, { error: "Not found" });
        const s = db().settings;
        const r = await mailer.send({ to: entry.to, cc: entry.cc || undefined, replyTo: entry.reply_to || undefined, subject: entry.subject, text: entry.text, html: entry.html }, { dealerEmail: s.email, dealerName: s.dealer_name });
        entry.status = r.status; entry.provider = r.provider; entry.error = r.error || ""; entry.created_at = new Date().toISOString();
        save();
        return json(res, 200, { ok: true, entry });
      }
      if (req.method === "POST" && p === "/api/admin/payment/toggle") {
        const pay = db().payments.find(x => x.id === body.id);
        if (!pay) return json(res, 404, { error: "Not found" });
        pay.paid = !pay.paid; pay.date_paid = pay.paid ? new Date().toISOString().slice(0, 10) : null;
        save(); return json(res, 200, { ok: true, payment: pay });
      }
      if (req.method === "POST" && p === "/api/admin/payment/update") {
        const pay = db().payments.find(x => x.id === body.id);
        if (!pay) return json(res, 404, { error: "Not found" });
        if (body.method !== undefined) pay.method = body.method;
        if (body.notes !== undefined) pay.notes = body.notes;
        save(); return json(res, 200, { ok: true, payment: pay });
      }
      // Issue a customer credit (e.g. out-of-stock refund). It auto-applies to
      // the customer's next generated invoice.
      if (req.method === "POST" && p === "/api/admin/credit/add") {
        if (!db().credits) db().credits = [];
        const cust = findCustomerById(body.customer_id);
        if (!cust) return json(res, 404, { error: "Customer not found" });
        const amt = round2(Number(body.amount) || 0);
        if (amt <= 0) return json(res, 400, { error: "Amount must be greater than 0" });
        const c = {
          id: nextId("credits"), customer_id: cust.id, customer_name: cust.name,
          amount: amt, used: 0, reason: (body.reason || "").trim(),
          source_invoice_num: body.source_invoice_num || "", status: "open",
          created_at: new Date().toISOString().slice(0, 10), applications: []
        };
        db().credits.push(c); save();
        return json(res, 200, { ok: true, credit: c });
      }
      if (req.method === "POST" && p === "/api/admin/credit/void") {
        if (!db().credits) db().credits = [];
        const c = db().credits.find(x => x.id === body.id);
        if (!c) return json(res, 404, { error: "Not found" });
        if (c.status === "applied") return json(res, 400, { error: "Already applied to an invoice" });
        c.status = "void"; save();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/admin/reminders") {
        // Send a reminder for each unpaid invoice (max 4 each); records to the Outbox.
        const results = [];
        for (const pay of db().payments.filter(x => !x.paid && x.reminders < 4)) {
          const cust = findCustomerById(pay.customer_id);
          const e = await queueMail("reminder", cust ? cust.email : "", pay.customer_name, emailReminder(pay));
          pay.reminders += 1;
          results.push({ customer: pay.customer_name, email: cust ? cust.email : "", status: e.status, subject: e.subject });
        }
        save();
        return json(res, 200, { ok: true, results });
      }
      // ----- INVENTORY (prototype) -----
      // Start carrying a product / update its reorder rule (+ optional opening stock).
      if (req.method === "POST" && p === "/api/admin/inventory/item") {
        ensureInventory();
        const prod = product(body.product_id);
        if (!prod) return json(res, 404, { error: "Product not found" });
        let it = invItem(body.product_id);
        if (!it) { it = { product_id: body.product_id, on_hand: 0, avg_cost: 0, reorder_point: 0, reorder_qty: 0 }; db().inventory_items.push(it); }
        if (body.reorder_point !== undefined) it.reorder_point = Math.max(0, Number(body.reorder_point) || 0);
        if (body.reorder_qty !== undefined) it.reorder_qty = Math.max(0, Number(body.reorder_qty) || 0);
        const opening = Number(body.opening_qty) || 0;
        if (opening > 0) {
          const cost = body.unit_cost != null ? Number(body.unit_cost) : prod.wholesale;
          recordMovement(body.product_id, "receive", opening, { unit_cost: cost, reason: "Opening count" });
          logQbo("Bill", opening + " × " + prod.name + " received (opening)", opening * cost);
        }
        save();
        return json(res, 200, { ok: true });
      }
      // Stop carrying a product.
      if (req.method === "POST" && p === "/api/admin/inventory/remove") {
        ensureInventory();
        db().inventory_items = db().inventory_items.filter(i => i.product_id !== body.product_id);
        save();
        return json(res, 200, { ok: true });
      }
      // Receive a shipment from the mill (stock in).
      if (req.method === "POST" && p === "/api/admin/inventory/receive") {
        ensureInventory();
        const lines = Array.isArray(body.items) ? body.items : [];
        let count = 0, value = 0;
        lines.forEach(l => {
          const it = invItem(l.product_id); const prod = product(l.product_id);
          const qty = Number(l.qty) || 0;
          if (!it || !prod || qty <= 0) return;
          const cost = l.unit_cost != null ? Number(l.unit_cost) : (it.avg_cost || prod.wholesale);
          recordMovement(l.product_id, "receive", qty, { unit_cost: cost, reason: body.reason || "Mill shipment" });
          count += qty; value += qty * cost;
        });
        if (count) {
          db().receipts.push({ id: nextId("receipts"), at: new Date().toISOString(), count, value: round2(value), note: body.reason || "Mill shipment" });
          // Native payable (for dealers without QuickBooks): you now owe the mill.
          if (!db().bills) db().bills = [];
          const today = new Date().toISOString().slice(0, 10);
          const net = Number(db().settings.payable_net_days) || 15;
          db().bills.push({
            id: nextId("bills"), vendor: body.vendor || "Umbarger Feeds",
            description: count + " bags · " + (body.reason || "Mill shipment"),
            amount: round2(value), date_created: today,
            due_date: new Date(Date.now() + net * 86400000).toISOString().slice(0, 10),
            status: "open", date_paid: null, method: "", ref: "RECEIVE", auto: true
          });
          logQbo("Bill", count + " bags received from mill", value);
        }
        save();
        return json(res, 200, { ok: true, count, value: round2(value) });
      }
      // Manual quantity correction (count / shrink) — not a sale.
      if (req.method === "POST" && p === "/api/admin/inventory/adjust") {
        ensureInventory();
        const it = invItem(body.product_id);
        if (!it) return json(res, 404, { error: "Not carried" });
        const newQty = Number(body.new_qty);
        if (!(newQty >= 0)) return json(res, 400, { error: "Enter a valid count" });
        const delta = round2(newQty - (it.on_hand || 0));
        if (delta !== 0) {
          recordMovement(body.product_id, "adjust", delta, { reason: (body.reason || "Count correction") });
          logQbo("Inventory Adjustment", (product(body.product_id) || {}).name + " set to " + newQty, null);
        }
        save();
        return json(res, 200, { ok: true });
      }
      // Walk-in / counter sale — HARD-GATED to available stock. Records a paid
      // Sales Receipt (so it shows in Invoices/Payments) and pulls stock.
      if (req.method === "POST" && p === "/api/admin/inventory/quicksale") {
        ensureInventory();
        const s = db().settings;
        const lines = (Array.isArray(body.items) ? body.items : []).filter(l => (Number(l.qty) || 0) > 0);
        if (!lines.length) return json(res, 400, { error: "Add at least one item." });
        // gate every line against live availability
        for (const l of lines) {
          const prod = product(l.product_id); const it = invItem(l.product_id);
          if (!it || !prod) return json(res, 400, { error: "Item not carried: " + l.product_id });
          if ((Number(l.qty) || 0) > availableQty(l.product_id)) return json(res, 400, { error: "Only " + availableQty(l.product_id) + " available of " + prod.name });
        }
        const today = new Date().toISOString().slice(0, 10);
        const baseLines = lines.map(l => {
          const prod = product(l.product_id); const qty = Number(l.qty);
          const unit = round2(basePrice(prod, s)); const freight = round2(qty * s.freight);
          return { description: prod.name, qty, unitPrice: unit, freight, total: round2(qty * unit + freight) };
        });
        const subtotal = round2(baseLines.reduce((a, l) => a + l.total, 0));
        const taxRate = s.tax_enabled ? s.tax_pct / 100 : 0;
        const tax = round2(subtotal * taxRate);
        const total = round2(subtotal + tax);
        const inv = {
          id: nextId("invoices"), invoice_num: nextInvoiceNum(),
          customer_id: body.customer_id || null,
          customer_name: (body.customer_name || "").trim() || "Counter sale",
          cycle_id: null, cycle_label: "Walk-in", date_issued: today,
          lines: baseLines, subtotal, tax_rate: taxRate, tax, credit_total: 0, total, freight_rate: s.freight,
          walk_in: true
        };
        db().invoices.push(inv);
        // pull stock + record what to restore on cancel
        const fulfilled = [];
        lines.forEach(l => { recordMovement(l.product_id, "fulfill", -Number(l.qty), { reason: "Walk-in " + inv.invoice_num, ref: "INV:" + inv.id }); fulfilled.push({ product_id: l.product_id, qty: Number(l.qty) }); });
        inv.fulfilled_items = fulfilled;
        // paid Sales Receipt
        db().payments.push({ id: nextId("payments"), invoice_id: inv.id, invoice_num: inv.invoice_num, customer_id: inv.customer_id, customer_name: inv.customer_name, amount: total, cycle: "Walk-in", date_issued: today, paid: true, date_paid: today, method: body.method || "Cash", notes: "Counter sale", reminders: 0 });
        logQbo("Sales Receipt", inv.invoice_num + " · " + inv.customer_name + " (paid " + (body.method || "Cash") + ")", total);
        save();
        return json(res, 200, { ok: true, invoice_num: inv.invoice_num, total });
      }
      // Cancel an invoice (no-show) and either restock or write off the bags.
      if (req.method === "POST" && p === "/api/admin/invoice/cancel") {
        ensureInventory();
        const inv = db().invoices.find(v => v.id === body.id);
        if (!inv) return json(res, 404, { error: "Invoice not found" });
        if (inv.cancelled) return json(res, 400, { error: "Already cancelled" });
        const mode = body.mode === "writeoff" ? "writeoff" : "restock";
        (inv.fulfilled_items || []).forEach(f => {
          if (!invItem(f.product_id)) return;
          if (mode === "restock") recordMovement(f.product_id, "return", f.qty, { reason: "Cancel " + inv.invoice_num + (body.reason ? " — " + body.reason : ""), ref: "INV:" + inv.id });
          else recordMovement(f.product_id, "write_off", 0, { reason: "Write-off " + inv.invoice_num + (body.reason ? " — " + body.reason : ""), ref: "INV:" + inv.id });
        });
        inv.cancelled = true; inv.cancel_reason = (body.reason || "Not picked up");
        inv.cancel_mode = mode; inv.cancelled_date = new Date().toISOString().slice(0, 10);
        // void the money: remove the payment so it leaves the outstanding/collected tallies
        db().payments = db().payments.filter(pp => pp.invoice_id !== inv.id);
        logQbo(mode === "restock" ? "Void Invoice" : "Write-off", inv.invoice_num + " · " + inv.customer_name + (mode === "restock" ? " (restocked, A/R cleared)" : " (loss to COGS)"), mode === "restock" ? -inv.total : null);
        save();
        return json(res, 200, { ok: true, mode });
      }
      // ----- PAYABLES / BILLS (native books for dealers without QuickBooks) -----
      if (req.method === "POST" && p === "/api/admin/bill") {
        if (!db().bills) db().bills = [];
        let b = body.id ? db().bills.find(x => x.id === body.id) : null;
        if (!b) { b = { id: nextId("bills"), status: "open", date_paid: null, method: "", auto: false, date_created: new Date().toISOString().slice(0, 10) }; db().bills.push(b); }
        ["vendor", "description", "due_date"].forEach(k => { if (body[k] !== undefined) b[k] = body[k]; });
        if (body.amount !== undefined) b.amount = round2(Number(body.amount) || 0);
        if (!b.vendor) return json(res, 400, { error: "Vendor is required." });
        if (!(b.amount > 0)) return json(res, 400, { error: "Amount must be greater than 0." });
        save();
        return json(res, 200, { ok: true, bill: b });
      }
      if (req.method === "POST" && p === "/api/admin/bill/toggle") {
        const b = (db().bills || []).find(x => x.id === body.id);
        if (!b) return json(res, 404, { error: "Not found" });
        b.status = b.status === "paid" ? "open" : "paid";
        b.date_paid = b.status === "paid" ? new Date().toISOString().slice(0, 10) : null;
        if (body.method !== undefined) b.method = body.method;
        logQbo(b.status === "paid" ? "Bill Payment" : "Bill", b.vendor + " · " + (b.description || ""), b.status === "paid" ? -b.amount : b.amount);
        save();
        return json(res, 200, { ok: true, bill: b });
      }
      if (req.method === "POST" && p === "/api/admin/bill/delete") {
        db().bills = (db().bills || []).filter(x => x.id !== body.id);
        save();
        return json(res, 200, { ok: true });
      }
      // ----- DEALERCYCLE SUBSCRIPTION (how this dealer pays us) -----
      if (req.method === "POST" && p === "/api/admin/subscribe") {
        const method = body.method === "card" ? "card" : "ach";
        const s = db().settings;
        try {
          const r = await payments.createSubscriptionCheckout({
            dealerEmail: s.email, method,
            successUrl: BASE_URL + "/admin", cancelUrl: BASE_URL + "/admin"
          });
          return json(res, 200, { url: r.url, provider: r.provider });
        } catch (e) { return json(res, 502, { error: "Subscription setup failed: " + String(e.message || e) }); }
      }
      if (req.method === "POST" && p === "/api/admin/subscription/cancel") {
        if (db().subscription) { db().subscription.status = "canceled"; save(); }
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "Unknown admin route" });
    }

    // static assets (styles + favicon; HTML is served by the routes above)
    if (req.method === "GET" && (p === "/styles.css" || p === "/favicon.svg" || p === "/manifest.webmanifest" || p === "/dc-icon-192.png" || p === "/dc-icon-512.png" || p === "/dc-icon-180.png")) return serveStatic(res, p.replace(/^\//, ""));

    return send(res, 404, "Not found", "text/plain");
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Scheduler — runs the cycle automatically on the dealer's clock:
//   Saturday open_time   → open ordering + email each customer their link
//   Monday   close_time  → close ordering
//   Monday   mill_time   → email the consolidated order to the mill contact
//   Wednesday invoice_time → generate + email invoices for the cycle
// All gated by settings.automation_enabled. Idempotent per cycle via
// settings.schedule_state. Times honor settings.timezone (default Eastern).
// ---------------------------------------------------------------------------
function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const o = {}; f.formatToParts(date).forEach(p => { o[p.type] = p.value; }); return o;
}
function zonedToUTC(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const o = tzParts(new Date(guess), tz);
  const asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute);
  return guess - (asUTC - guess);
}
function parseHM(t) { const m = String(t).match(/(\d+):(\d+)\s*(AM|PM)?/i); if (!m) return { h: 0, mi: 0 }; let h = +m[1]; const mi = +m[2]; const ap = (m[3] || "").toUpperCase(); if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0; return { h, mi }; }
function isoUTC(d) { return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0"); }
function currentCycleSaturday(s, tz, nowMs) {
  const now = tzParts(new Date(nowMs == null ? Date.now() : nowMs), tz);
  const today = Date.UTC(+now.year, +now.month - 1, +now.day);
  const anchor = Date.UTC(...s.cycle_anchor.split("-").map((v, i) => i === 1 ? +v - 1 : +v));
  const freq = (Number(s.frequency_days) || 14) * 86400000;
  if (today < anchor) return null;
  const k = Math.floor((today - anchor) / freq);
  return new Date(anchor + k * freq); // UTC-midnight of the most recent cycle Saturday (dealer's tz)
}
// The cycle a moment belongs to: stays on the just-opened cycle through its order
// week (Sat..Thu) so a Sat→Mon order window all lands on one cycle; otherwise the
// upcoming cycle. Used for both order placement and the scheduler so they agree.
function cycleSaturdayForNow(s, nowMs) {
  const tz = s.timezone || "America/New_York";
  const cur = currentCycleSaturday(s, tz, nowMs);
  if (!cur) return nextCycleSaturday(s);
  const now = tzParts(new Date(nowMs == null ? Date.now() : nowMs), tz);
  const today = Date.UTC(+now.year, +now.month - 1, +now.day);
  if (today <= cur.getTime() + 5 * 86400000) return cur;                          // within this cycle's order week
  return new Date(cur.getTime() + (Number(s.frequency_days) || 14) * 86400000);    // else the upcoming cycle
}
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
function dealerNudge(subject, body) {
  const link = (process.env.BASE_URL || "") + "/admin";
  return { subject, text: body + "\n\nOpen your back office: " + link,
    html: wrapHtml('<h2 style="color:#2F6B3A;margin:0 0 8px">' + esc(subject) + '</h2><p style="color:#555">' + esc(body) + '</p><p style="margin:14px 0"><a href="' + link + '" style="background:#2F6B3A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold">Open back office</a></p>') };
}
async function emailMillOrder(keyIso) {
  const cyc = keyIso ? db().cycles.find(c => c.delivery_key === keyIso) : getOrCreateCycle(db().settings);
  if (!cyc) return { ok: false, reason: "no orders this cycle" };
  const s = db().settings; const to = (s.mill_contact_email || "").trim(); if (!to) return { ok: false, reason: "no mill email set" };
  const text = millOrderText(cyc);
  const msg = { subject: "Umbarger Order — " + s.dealer_name + " (" + cyc.delivery_label + ")", text, html: "<pre style=\"font-family:Menlo,Consolas,monospace;font-size:13px;white-space:pre-wrap\">" + esc(text) + "</pre>" };
  const e = await queueMail("mill", to, s.mill_contact_name || "Mill", msg);
  return { ok: true, to, cc: e.cc || null, status: e.status };
}
async function genAndSendInvoices(keyIso) {
  const cyc = db().cycles.find(c => c.delivery_key === keyIso); if (!cyc) return { made: 0 };
  let made = 0;
  for (const o of db().orders.filter(x => x.cycle_id === cyc.id && x.status === "submitted")) {
    const wasNew = !db().invoices.find(v => v.customer_id === o.customer_id && v.cycle_id === cyc.id);
    const inv = buildInvoiceForCustomer(o.customer_id, cyc.id);
    if (inv && wasNew) { const cust = findCustomerById(o.customer_id); if (cust && cust.email) { try { await queueMail("invoice", cust.email, cust.name, emailInvoice(inv)); } catch (e) {} } made++; }
  }
  return { made };
}
async function schedJobOpen(mode) {
  const s = db().settings; s.order_window = "open"; save();
  if (mode === "auto") {
    let sent = 0;
    for (const c of db().customers.filter(x => x.active)) { if (c.email) { try { const e = await queueMail("cycle-open", c.email, c.name, emailCycleOpen(c)); if (e.status === "sent") sent++; } catch (e) {} } }
    console.log(`[scheduler] OPENED + order links sent (${sent})`);
  } else {
    if (s.email) { try { await queueMail("nudge", s.email, s.dealer_name, dealerNudge("Ordering is open — send order links", "The order window just opened for this cycle. Review your roster, then tap “Email order link to all customers.”")); } catch (e) {} }
    console.log("[scheduler] OPENED (review mode — dealer nudged)");
  }
}
async function schedJobMill(keyIso, mode) {
  const s = db().settings;
  if (mode === "auto") { const r = await emailMillOrder(keyIso); console.log("[scheduler] mill auto-sent:", JSON.stringify(r)); }
  else { if (s.email) { try { await queueMail("nudge", s.email, s.dealer_name, dealerNudge("Mill order ready to send", "It’s time to send the consolidated order to " + (s.mill_contact_name || "the mill") + ". Review it and tap “Email mill order.”")); } catch (e) {} } console.log("[scheduler] mill ready (review mode — dealer nudged)"); }
}
async function schedJobInvoices(keyIso, mode) {
  const s = db().settings;
  if (mode === "auto") { const r = await genAndSendInvoices(keyIso); console.log(`[scheduler] invoices generated + emailed (${r.made})`); }
  else { if (s.email) { try { await queueMail("nudge", s.email, s.dealer_name, dealerNudge("Invoice day — generate & send", "It’s invoice day for this cycle. Open the back office and tap “Generate invoices for this cycle” to create and email them.")); } catch (e) {} } console.log("[scheduler] invoices due (review mode — dealer nudged)"); }
}
async function runScheduler(nowMs) {
  try {
    if (nowMs == null) nowMs = Date.now();
    const s = db().settings;
    if (!s.automation_enabled) return;
    const mode = (s.automation_mode === "auto") ? "auto" : "review";
    const tz = s.timezone || "America/New_York";
    const sat = currentCycleSaturday(s, tz, nowMs); if (!sat) return;
    const key = isoUTC(sat);
    s.schedule_state = s.schedule_state || {};
    const due = (job, dateObj, hm) => {
      const t = parseHM(hm);
      const utc = zonedToUTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth() + 1, dateObj.getUTCDate(), t.h, t.mi, tz);
      return nowMs >= utc && nowMs <= utc + 12 * 3600000 && s.schedule_state[job] !== key; // fire once, never >12h late
    };
    if (due("open", sat, s.open_time || "7:00 AM")) { s.schedule_state.open = key; save(); await schedJobOpen(mode); }
    if (due("close", addDays(sat, 2), s.close_time || "10:00 AM")) { s.order_window = "closed"; s.schedule_state.close = key; save(); console.log("[scheduler] ordering CLOSED"); }
    if (due("mill", addDays(sat, 2), s.mill_time || "10:30 AM")) { s.schedule_state.mill = key; save(); await schedJobMill(key, mode); }
    if (due("invoice", addDays(sat, 4), s.invoice_time || "8:00 AM")) { s.schedule_state.invoice = key; save(); await schedJobInvoices(key, mode); }
  } catch (e) { console.error("[scheduler] error:", e); }
}
module.exports = { runScheduler, cycleSaturdayForNow, currentCycleSaturday, emailMillOrder };

server.listen(PORT, () => {
  reload();
  setInterval(runScheduler, 60000); runScheduler();
  console.log(`DealerCycle running → http://localhost:${PORT}`);
  console.log(`  Dealer back office: http://localhost:${PORT}/admin  (passcode: ${ADMIN_PASSCODE})`);
  console.log(`  Email mode: ${mailer.providerName()}${mailer.providerName() === "outbox" ? " (preview — messages captured in the Outbox tab; set RESEND_API_KEY to send for real)" : ""}`);
  const c = db().customers[0];
  if (c) console.log(`  Example customer link: http://localhost:${PORT}/o/${c.link_token}  (${c.name})`);
});
