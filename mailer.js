// Email transport. Provider chosen by environment variables:
//   RESEND_API_KEY=...           -> sends via Resend (zero install, uses built-in fetch)
//   EMAIL_PROVIDER=gmail + GMAIL_USER + GMAIL_APP_PASSWORD  -> sends via Gmail (needs `nodemailer`)
//   (nothing set)                -> "outbox" mode: nothing leaves the building; every message
//                                   is captured so you can review it and tap "open in email".
// EMAIL_FROM overrides the From address (default: Resend onboarding sender or the dealer email).
//
// send() always RESOLVES with a result object; it never throws, so a mail problem
// can never break an order or invoice.

function providerName() {
  if (process.env.EMAIL_PROVIDER) return process.env.EMAIL_PROVIDER;
  if (process.env.RESEND_API_KEY) return "resend";
  return "outbox";
}

function fromAddress(dealerEmail, dealerName) {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  if (providerName() === "resend") return (dealerName ? dealerName + " " : "") + "<onboarding@resend.dev>";
  return dealerEmail || "no-reply@dealercycle.app";
}

async function sendViaResend(msg, from) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text })
    });
    if (!res.ok) { const t = await res.text(); return { status: "failed", provider: "resend", error: "Resend " + res.status + ": " + t.slice(0, 200) }; }
    const data = await res.json();
    return { status: "sent", provider: "resend", id: data.id };
  } catch (e) {
    return { status: "failed", provider: "resend", error: String(e) };
  }
}

async function sendViaGmail(msg, from) {
  let nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch { return { status: "failed", provider: "gmail", error: "Gmail selected but 'nodemailer' is not installed. Run: npm install nodemailer" }; }
  try {
    const t = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
    const info = await t.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    return { status: "sent", provider: "gmail", id: info.messageId };
  } catch (e) {
    return { status: "failed", provider: "gmail", error: String(e) };
  }
}

// msg = { to, subject, text, html }; cfg = { dealerEmail, dealerName }
async function send(msg, cfg) {
  cfg = cfg || {};
  const provider = providerName();
  const from = fromAddress(cfg.dealerEmail, cfg.dealerName);
  if (!msg.to) return { status: "captured", provider, error: "no recipient email on file" };
  if (provider === "resend") return await sendViaResend(msg, from);
  if (provider === "gmail") return await sendViaGmail(msg, from);
  return { status: "captured", provider: "outbox" }; // preview mode
}

module.exports = { send, providerName, fromAddress };
