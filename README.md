# DealerCycle — Phase 1 Web Ordering System

A real, deployable web app for an Umbarger feed dealer. Built on the FeedCycle prototype's
structure, with the live system's **Invoices** and **Payment Tracker** added and made
mobile-friendly. **Zero dependencies** — runs on plain Node.js (18+), no `npm install`,
no database server.

## Run it (on the Mac)

First install Node.js once (nodejs.org → LTS). Then either:

- **Double-click `Start DealerCycle.command`** — it builds the data on first run, starts the app, and opens your browser. (First time, macOS may say it's from an unidentified developer: right-click the file → **Open** → **Open**. After that, double-click works.)
- **Or in Terminal:** `cd` into this folder and run **`node server.js`**. That's it — it sets up its own data automatically the first time.

Then it opens / you visit:
- **Dealer back office:** http://localhost:3000/admin  (passcode: `evans` — change it, see below)
- **A customer's order screen:** http://localhost:3000/o/<their-token> (each customer's link is on the **Customers** tab → "Copy link")

To change the dealer passcode: `ADMIN_PASSCODE=yourcode node server.js`.

> **Note:** `localhost` links only work on *this* computer. To text links to real customers, the app must be deployed to a public URL (see "Deploying" below).

## What's inside

**Customer side** — a per-customer private link opens straight to *their* order screen
(no roster, no login): catalog of 95 products in 9 categories, real feed-tag bag colors,
all-in prices (matches your Google form to the penny), cart → review → confirm, and
**edit-on-return** until the cycle closes.

**Dealer back office** (7 tabs):
- **Dashboard** — KPIs, orders by product / by customer, consolidated mill order to Hannah, "generate invoices."
- **Customers** — roster + each customer's private link + add/edit.
- **Pricing** — basis (% off SRP *or* markup on cost), margin, freight, tax → live customer prices + margin/bag.
- **Invoices** — generate per cycle or per customer; every invoice lives here, viewable/printable (Print → Save as PDF).
- **Payments** — mobile payment tracker: tap to mark paid (auto-dates), set method, track reminders, export CSV, prepare reminder emails.
- **Setup** — company info + cycle/schedule + ordering-window control.
- **Umbarger** — network demand dashboard (Evans live + sample dealers; becomes real in Phase 2).

## Files
- `server.js` — the whole server (HTTP, API, pricing engine, invoices, payments).
- `db.js` — tiny JSON datastore (one file: `data.json`).
- `seed.js` / `seed-raw.json` — seeds the real catalog, bag colors, config, and 31-name roster.
- `public/` — `order.html` (customer), `admin.html` (dealer), `styles.css`.

## Email

The app sends four emails: **order confirmation** (on submit), the **cycle-open order link**
(Dashboard → "Email order link to all customers"), the **invoice** (on generate), and **payment
reminders** (Payments → "Send reminders"). How they go out depends on how you start it:

**Preview (default):** `node server.js` — nothing is sent; every message is captured in the **Outbox**
tab to read and send yourself.

**Google Workspace (orders@dealercycle.app) — the planned setup:** set these env vars (on Render, or
locally), then it sends automatically:
```
EMAIL_PROVIDER=workspace
GMAIL_USER=orders@dealercycle.app
GMAIL_APP_PASSWORD=<16-char app password from the Google account>
EMAIL_FROM=DealerCycle — Evans Cattle <orders@dealercycle.app>
```
(Needs `nodemailer`, which is in package.json — `npm install` / Render installs it automatically.)

**Resend (alternative):** `RESEND_API_KEY=your_key` instead.

Set `BASE_URL=https://dealercycle.app` (or the onrender URL) so links inside emails are clickable.

Every email — sent or captured — is logged in the **Outbox** with its status, and failed ones can be retried.

## Data & safety
- `data.json` is your database — **back it up** (copy the file). It holds orders, invoices, payments, customers.
- **No bank/card numbers are stored** — payment is a label only ("Check", "Venmo @handle"). Don't add raw account numbers.
- This app is **separate from the live Google system** — it never touches `OrderSystem.gs`, the "auto order form" sheet, or the June 13 cycle.

## Deploying to a public URL (later)
Push this folder to GitHub, create a Render Web Service (start command `node server.js`),
add a persistent disk so `data.json` survives restarts, set `ADMIN_PASSCODE` as an env var,
and point `app.dealercycle.app` at it. Email confirmations/reminders auto-send once you wire
in a provider (Resend/Postmark) — until then the app prepares ready-to-send drafts + mailto links.

## Re-seeding
- `node seed.js` — refresh catalog/prices/colors, **keep** customers/orders/invoices/payments.
- `node seed.js --fresh` — wipe and start clean (new customer link tokens).
