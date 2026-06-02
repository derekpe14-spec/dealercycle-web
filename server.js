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

const PORT = process.env.PORT || 3000;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "evans";
const BASE_URL = process.env.BASE_URL || ("http://localhost:" + PORT);
// Front-end files live alongside the server (flat, single folder). Only these are
// ever served as static assets — server code/data are never exposed.
const PUBLIC = __dirname;
const STATIC_ALLOW = new Set(["order.html", "admin.html", "styles.css", "favicon.svg"]);

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
  const sat = nextCycleSaturday(s);
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

  const lines = items.map(i => {
    const p = product(i.product_id);
    const unit = round2(basePrice(p, s));
    const freight = round2(i.qty * s.freight);
    const total = round2(i.qty * unit + freight);
    return { description: p.name, qty: i.qty, unitPrice: unit, freight, total };
  });
  const subtotal = round2(lines.reduce((a, l) => a + l.total, 0));
  const taxRate = s.tax_enabled ? s.tax_pct / 100 : 0;
  const tax = round2(subtotal * taxRate);
  const total = round2(subtotal + tax);

  // idempotent per (customer, cycle): reuse existing invoice if present
  let inv = db().invoices.find(x => x.customer_id === custId && x.cycle_id === cycleId);
  if (inv) {
    Object.assign(inv, { lines, subtotal, tax_rate: taxRate, tax, total, freight_rate: s.freight });
    const pay = db().payments.find(p => p.invoice_id === inv.id);
    if (pay && !pay.paid) pay.amount = total;
    save();
    return inv;
  }
  inv = {
    id: nextId("invoices"),
    invoice_num: nextInvoiceNum(),
    customer_id: custId,
    customer_name: cust.name,
    cycle_id: cycleId,
    cycle_label: cyc ? cyc.delivery_label : "",
    date_issued: new Date().toISOString().slice(0, 10),
    lines, subtotal, tax_rate: taxRate, tax, total, freight_rate: s.freight
  };
  db().invoices.push(inv);
  // register a payment-tracker row
  db().payments.push({
    id: nextId("payments"),
    invoice_id: inv.id,
    invoice_num: inv.invoice_num,
    customer_id: custId,
    customer_name: cust.name,
    amount: total,
    cycle: inv.cycle_label,
    date_issued: inv.date_issued,
    paid: false, date_paid: null, method: "", notes: "", reminders: 0
  });
  save();
  return inv;
}
function invoiceHtml(inv) {
  const s = db().settings;
  const rows = inv.lines.map((l, i) => `<tr class="${i % 2 ? "alt" : ""}"><td>${i + 1}</td><td>${esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${money(l.freight)}</td><td class="num">${money(l.total)}</td></tr>`).join("");
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
<tr class="due"><td>TOTAL DUE</td><td class="num">${money(inv.total)}</td></tr></table>
<div class="pay"><b>Payment options</b><br>• Check — payable to ${esc(s.payable_to)}<br>• Venmo — ${esc(s.venmo)}</div>
<div class="terms">${esc(s.invoice_terms)}</div>
<div class="noprint"><button class="btn" onclick="window.print()">Print / Save PDF</button></div>
</body></html>`;
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
  const rows = items.map(i => {
    const p = product(i.product_id); const line = i.qty * allIn(p, s); total += line; bags += i.qty;
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(p.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${i.qty}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${money(line)}</td></tr>`;
  }).join("");
  const subject = "Order received — " + s.payable_to + " (" + (cyc ? cyc.delivery_label : "") + ")";
  const html = wrapHtml(
    `<h2 style="color:${NAVY};margin:0 0 4px">Order received</h2><p style="color:#555;margin:0 0 14px">Thanks, ${esc(cust.name)}. Here is your order with ${esc(s.dealer_name)} for the ${esc(cyc ? cyc.delivery_label : "")} cycle.</p>` +
    `<table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid ${NAVY}">Product</th><th style="text-align:center;padding:6px 10px;border-bottom:2px solid ${NAVY}">Bags</th><th style="text-align:right;padding:6px 10px;border-bottom:2px solid ${NAVY}">Total</th></tr></thead><tbody>${rows}<tr><td colspan="2" style="padding:8px 10px;text-align:right;font-weight:bold">Total (${bags} bags)</td><td style="padding:8px 10px;text-align:right;font-weight:bold">${money(total)}</td></tr></tbody></table>` +
    `<p style="color:#777;font-size:12px;margin-top:14px">Prices include $${s.freight.toFixed(2)}/bag freight. Need to change something before ${esc(s.close_day)} ${esc(s.close_time)}? Open your order link or reply to this email.</p>`);
  const text = `Thanks, ${cust.name}. Order received for the ${cyc ? cyc.delivery_label : ""} cycle — ${bags} bags, total ${money(total)} (incl. $${s.freight.toFixed(2)}/bag freight). Reply to change anything.`;
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
  const html = wrapHtml(
    `<h2 style="color:${NAVY};margin:0 0 6px">Your invoice</h2><p style="color:#555">Hi ${esc(inv.customer_name)}, here is your invoice for the ${esc(inv.cycle_label)} feed cycle.</p>` +
    `<table style="border-collapse:collapse;margin:12px 0;font-size:14px"><tr><td style="padding:6px 12px;border:1px solid #ddd"><b>Invoice #</b></td><td style="padding:6px 12px;border:1px solid #ddd">${inv.invoice_num}</td></tr><tr><td style="padding:6px 12px;border:1px solid #ddd"><b>Total Due</b></td><td style="padding:6px 12px;border:1px solid #ddd">${money(inv.total)}</td></tr></table>` +
    `<p style="margin:16px 0"><a href="${link}" style="background:${NAVY};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:bold">View / print invoice</a></p>` +
    `<p style="color:#777;font-size:12px">Payment options: Check payable to ${esc(s.payable_to)} · Venmo ${esc(s.venmo)}. ${esc(s.invoice_terms)}</p>`);
  const text = `Hi ${inv.customer_name}, invoice ${inv.invoice_num} for the ${inv.cycle_label} cycle — Total Due ${money(inv.total)}. View: ${link}. Pay by check to ${s.payable_to} or Venmo ${s.venmo}.`;
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
  const result = await mailer.send({ to, subject: msg.subject, text: msg.text, html: msg.html }, { dealerEmail: s.email, dealerName: s.dealer_name });
  const entry = {
    id: nextId("outbox"), kind, to: to || "", to_name: toName || "",
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
function isAdmin(req) {
  const pass = req.headers["x-dc-pass"] || "";
  return pass === ADMIN_PASSCODE;
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
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
    invoices: db().invoices.map(v => ({ id: v.id, invoice_num: v.invoice_num, customer_id: v.customer_id, customer_name: v.customer_name, cycle_label: v.cycle_label, date_issued: v.date_issued, total: v.total })).sort((a, b) => b.id - a.id),
    payments: db().payments.map(p => ({ ...p })).sort((a, b) => Number(a.paid) - Number(b.paid) || b.id - a.id),
    mail_provider: mailer.providerName(),
    outbox: (db().outbox || []).map(o => ({ id: o.id, kind: o.kind, to: o.to, to_name: o.to_name, subject: o.subject, text: o.text, created_at: o.created_at, status: o.status, provider: o.provider, error: o.error })).sort((a, b) => b.id - a.id)
  };
}

function millOrderText() {
  const s = db().settings;
  const cyc = getOrCreateCycle(s);
  const tally = tallyCycle(cyc.id);
  const order = db().categoryOrder;
  const rows = Object.keys(tally).map(pid => [product(pid), tally[pid]])
    .sort((a, b) => order.indexOf(a[0].category) - order.indexOf(b[0].category) || b[1] - a[1]);
  let total = 0; let body = "";
  let lastCat = "";
  rows.forEach(([p, bags]) => {
    if (p.category !== lastCat) { body += `\n${p.category}\n`; lastCat = p.category; }
    body += `  ${bags} × ${p.name}\n`; total += bags;
  });
  return `Consolidated Umbarger Order — ${s.dealer_name}\nCycle delivering ${cyc.delivery_label} · to ${s.mill_contact_name}\n${"=".repeat(46)}${body}\n${"=".repeat(46)}\nTOTAL: ${total} bags`;
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

    // ----- admin app -----
    if (req.method === "GET" && (p === "/" || p === "/admin")) return serveStatic(res, "admin.html");

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
      if (req.method === "POST" && p === "/api/admin/reset") {
        // Clear test activity but KEEP catalog, customers (and their link tokens), and settings.
        const d = db();
        d.orders = []; d.order_items = []; d.invoices = []; d.payments = []; d.outbox = []; d.cycles = [];
        d.settings.invoice_counter = 0;
        save();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/admin/outbox/resend") {
        ensureOutbox();
        const entry = db().outbox.find(x => x.id === body.id);
        if (!entry) return json(res, 404, { error: "Not found" });
        const s = db().settings;
        const r = await mailer.send({ to: entry.to, subject: entry.subject, text: entry.text, html: entry.html }, { dealerEmail: s.email, dealerName: s.dealer_name });
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
      return json(res, 404, { error: "Unknown admin route" });
    }

    // static assets (styles + favicon; HTML is served by the routes above)
    if (req.method === "GET" && (p === "/styles.css" || p === "/favicon.svg")) return serveStatic(res, p.replace(/^\//, ""));

    return send(res, 404, "Not found", "text/plain");
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  reload();
  console.log(`DealerCycle running → http://localhost:${PORT}`);
  console.log(`  Dealer back office: http://localhost:${PORT}/admin  (passcode: ${ADMIN_PASSCODE})`);
  console.log(`  Email mode: ${mailer.providerName()}${mailer.providerName() === "outbox" ? " (preview — messages captured in the Outbox tab; set RESEND_API_KEY to send for real)" : ""}`);
  const c = db().customers[0];
  if (c) console.log(`  Example customer link: http://localhost:${PORT}/o/${c.link_token}  (${c.name})`);
});
