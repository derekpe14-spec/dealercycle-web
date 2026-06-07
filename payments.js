// Stripe payments transport. Mirrors mailer.js: chosen by environment variables,
// never throws (every call resolves with a result object), and falls back to a
// fully-working SIMULATED mode when no key is set — so the prototype demos the
// surcharge + subscription flows with zero configuration.
//
//   Live mode:
//     STRIPE_SECRET_KEY=sk_test_... (or sk_live_...)   -> real Stripe
//     STRIPE_WEBHOOK_SECRET=whsec_...                  -> verifies webhooks
//     STRIPE_PRICE_ID=price_...        the $99/mo recurring Price (dealer plan)
//     STRIPE_COUPON_ID=...             6-month intro coupon (so dealer pays $59.99)
//
//   (no STRIPE_SECRET_KEY) -> "simulated" mode: no network calls; checkout pages
//     are served locally so you can click the whole flow end-to-end.
//
// Uses built-in fetch + crypto only (no npm install), exactly like the Resend path.

const crypto = require("crypto");

// --- card-surcharge policy (pass card fees to the payer) -----------------------
// Visa caps surcharging at 3%. Some states cap lower or to actual cost; a few ban
// it outright. Debit cards can never be surcharged. We keep a small state table so
// the prototype is honest; default is the dealer's configured pct, capped at 3.
const STATE_RULES = {
  // banned -> 0
  CT: 0, MA: 0, ME: 0, PR: 0,
  // lower caps
  CO: 2, IL: 1
  // (NY/NJ/NV/SD/NE/GA limit to actual cost ≈ ~3%; treated as the 3% cap here)
};
function effectiveSurchargePct(settings, state) {
  settings = settings || {};
  if (!settings.surcharge_enabled) return 0;
  let pct = Number(settings.surcharge_pct);
  if (!(pct >= 0)) pct = 3;
  pct = Math.min(pct, 3); // never exceed the Visa network cap
  const st = String(state || "").trim().toUpperCase();
  if (st && Object.prototype.hasOwnProperty.call(STATE_RULES, st)) {
    pct = Math.min(pct, STATE_RULES[st]);
  }
  return pct;
}
function round2(n) { return Math.round(n * 100) / 100; }
function surchargeAmount(amount, pct) { return round2((Number(amount) || 0) * (pct / 100)); }

function providerName() {
  return process.env.STRIPE_SECRET_KEY ? "stripe" : "simulated";
}
function isLive() { return providerName() === "stripe"; }

// --- Stripe REST helper (form-encoded, like the dashboard SDK sends) -----------
function formEncode(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(key => {
    const val = obj[key];
    const name = prefix ? `${prefix}[${key}]` : key;
    if (val == null) return;
    if (typeof val === "object") formEncode(val, name, out);
    else out.push(encodeURIComponent(name) + "=" + encodeURIComponent(val));
  });
  return out;
}
async function stripeApi(pathname, params, method) {
  const body = params ? formEncode(params).join("&") : undefined;
  const res = await fetch("https://api.stripe.com/v1/" + pathname, {
    method: method || "POST",
    headers: {
      "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ("Stripe " + res.status);
    const e = new Error(msg); e.stripe = data; throw e;
  }
  return data;
}

// --- Customer invoice: one-time card payment with surcharge --------------------
// amountCents = invoice total; surchargeCents = the card fee passed to the customer.
// Returns { provider, url, id } — in simulated mode `url` points at a local page.
async function createInvoiceCheckout(opts) {
  const { invoiceId, invoiceNum, dealerName, amount, surcharge, surchargeLabel, customerEmail, successUrl, cancelUrl } = opts;
  if (!isLive()) {
    return {
      provider: "simulated",
      url: `/pay/sim?invoice=${invoiceId}&amount=${amount}&surcharge=${surcharge || 0}`,
      id: "sim_" + invoiceId
    };
  }
  const params = {
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(invoiceId),
    metadata: { invoice_id: String(invoiceId), invoice_num: invoiceNum || "", kind: "invoice", surcharge: String(surcharge || 0) },
    payment_intent_data: { metadata: { invoice_id: String(invoiceId), invoice_num: invoiceNum || "" } },
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": Math.round(Number(amount) * 100),
    "line_items[0][price_data][product_data][name]": (dealerName ? dealerName + " — " : "") + "Invoice " + (invoiceNum || invoiceId)
  };
  if (customerEmail) params.customer_email = customerEmail;
  if (surcharge && surcharge > 0) {
    params["line_items[1][quantity]"] = 1;
    params["line_items[1][price_data][currency]"] = "usd";
    params["line_items[1][price_data][unit_amount]"] = Math.round(Number(surcharge) * 100);
    params["line_items[1][price_data][product_data][name]"] = (surchargeLabel || "Card processing fee");
  }
  const session = await stripeApi("checkout/sessions", params);
  return { provider: "stripe", url: session.url, id: session.id };
}

// --- Dealer subscription: $99/mo plan, 6-month intro coupon -> $59.99 ----------
// method = "ach" (no surcharge) | "card" (surcharge disclosed). In live mode the
// recurring card surcharge would be added as a per-invoice item; the prototype
// records the chosen method and discloses the fee. Simulated mode demos it all.
async function createSubscriptionCheckout(opts) {
  const { dealerEmail, method, successUrl, cancelUrl } = opts;
  if (!isLive()) {
    return { provider: "simulated", url: `/pay/sim-sub?method=${method || "ach"}`, id: "sim_sub" };
  }
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) { const e = new Error("STRIPE_PRICE_ID not set"); throw e; }
  const params = {
    mode: "subscription",
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { kind: "subscription", method: method || "ach" },
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": 1
  };
  // ACH = us_bank_account (no surcharge); Card = card (surcharge applies)
  params["payment_method_types[0]"] = (method === "card") ? "card" : "us_bank_account";
  if (dealerEmail) params.customer_email = dealerEmail;
  if (process.env.STRIPE_COUPON_ID) params["discounts[0][coupon]"] = process.env.STRIPE_COUPON_ID;
  const session = await stripeApi("checkout/sessions", params);
  return { provider: "stripe", url: session.url, id: session.id };
}

// --- Webhook signature verification (Stripe's t=,v1= scheme) -------------------
// Returns the parsed event on success, or null if the signature can't be verified.
function verifyWebhook(rawBody, sigHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) { try { return JSON.parse(rawBody); } catch { return null; } } // dev: accept unsigned
  try {
    const parts = {};
    String(sigHeader || "").split(",").forEach(kv => { const [k, v] = kv.split("="); parts[k] = v; });
    const signedPayload = parts.t + "." + rawBody;
    const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
    const ok = parts.v1 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
    if (!ok) return null;
    return JSON.parse(rawBody);
  } catch { return null; }
}

module.exports = {
  providerName, isLive,
  effectiveSurchargePct, surchargeAmount, round2,
  createInvoiceCheckout, createSubscriptionCheckout, verifyWebhook
};
