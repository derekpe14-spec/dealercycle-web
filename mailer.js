// Email transport. Provider chosen by environment variables:
//
//   Google Workspace / Gmail (orders@dealercycle.app):
//     EMAIL_PROVIDER=workspace   (or "gmail")
//     GMAIL_USER=orders@dealercycle.app
//     GMAIL_APP_PASSWORD=<16-char app password from the Google account>
//     EMAIL_FROM=DealerCycle — Evans Cattle <orders@dealercycle.app>   (optional display name)
//
//   Resend:
//     RESEND_API_KEY=...         (zero install, uses built-in fetch)
//
//   Generic SMTP (any host):
//     EMAIL_PROVIDER=smtp + SMTP_HOST + SMTP_PORT + SMTP_USER + SMTP_PASS
//
//   (nothing set) -> "outbox" mode: nothing leaves the building; every message is
//                    captured so you can review it and tap "open in email".
//
// The Workspace/Gmail and SMTP paths require the `nodemailer` package (in package.json;
// Render installs it on deploy). send() always RESOLVES with a result object — it never
// throws — so an email problem can never break an order or invoice.

function providerName() {
  if (process.env.EMAIL_PROVIDER) return process.env.EMAIL_PROVIDER.toLowerCase();
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.GMAIL_USER || process.env.SMTP_USER) return "workspace";
  return "outbox";
}
function isSmtpProvider(p) { return p === "workspace" || p === "gmail" || p === "smtp"; }

function fromAddress(dealerEmail, dealerName) {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  const p = providerName();
  if (p === "resend") return (dealerName ? dealerName + " " : "") + "<onboarding@resend.dev>";
  if (isSmtpProvider(p)) {
    const addr = process.env.GMAIL_USER || process.env.SMTP_USER || dealerEmail || "no-reply@dealercycle.app";
    return dealerName ? `${dealerName} <${addr}>` : addr;
  }
  return dealerEmail || "no-reply@dealercycle.app";
}

async function sendViaResend(msg, from) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }, msg.cc ? { cc: Array.isArray(msg.cc) ? msg.cc : [msg.cc] } : {}, msg.replyTo ? { reply_to: msg.replyTo } : {}, (msg.attachments && msg.attachments.length) ? { attachments: msg.attachments.map(a => ({ filename: a.filename, content: a.content })) } : {}))
    });
    if (!res.ok) { const t = await res.text(); return { status: "failed", provider: "resend", error: "Resend " + res.status + ": " + t.slice(0, 200) }; }
    const data = await res.json();
    return { status: "sent", provider: "resend", id: data.id };
  } catch (e) {
    return { status: "failed", provider: "resend", error: String(e) };
  }
}

// Workspace/Gmail (smtp.gmail.com) or any generic SMTP host. Uses nodemailer.
async function sendViaSmtp(msg, from, provider) {
  let nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch { return { status: "failed", provider, error: "Email selected but 'nodemailer' is not installed. Run: npm install" }; }
  try {
    const user = process.env.GMAIL_USER || process.env.SMTP_USER;
    const pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;
    let transport;
    if (process.env.SMTP_HOST) {
      const port = Number(process.env.SMTP_PORT || 587);
      transport = { host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user, pass } };
    } else {
      // Google Workspace + Gmail both use the "gmail" service (smtp.gmail.com).
      transport = { service: "gmail", auth: { user, pass } };
    }
    const t = nodemailer.createTransport(transport);
    const info = await t.sendMail(Object.assign({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html }, msg.cc ? { cc: msg.cc } : {}, msg.replyTo ? { replyTo: msg.replyTo } : {}, (msg.attachments && msg.attachments.length) ? { attachments: msg.attachments.map(a => ({ filename: a.filename, content: a.content, encoding: "base64" })) } : {}));
    return { status: "sent", provider, id: info.messageId };
  } catch (e) {
    return { status: "failed", provider, error: String(e) };
  }
}

// msg = { to, subject, text, html, cc, replyTo }; cfg = { dealerEmail, dealerName }
// replyTo lets the platform send FROM its own domain (deliverability) while routing
// replies to the dealer's own address (so customer questions stay with the dealer).
async function send(msg, cfg) {
  cfg = cfg || {};
  const provider = providerName();
  const from = fromAddress(cfg.dealerEmail, cfg.dealerName);
  if (!msg.to) return { status: "captured", provider, error: "no recipient email on file" };
  if (provider === "resend") return await sendViaResend(msg, from);
  if (isSmtpProvider(provider)) return await sendViaSmtp(msg, from, provider);
  return { status: "captured", provider: "outbox" }; // preview mode
}

module.exports = { send, providerName, fromAddress };
