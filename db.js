// Zero-dependency JSON datastore. One file = the whole database.
// Atomic writes (write temp + rename) so a crash can't corrupt data.
// The access surface is intentionally small so Phase 2 can swap this for
// SQLite/Postgres without touching server.js.
const fs = require("fs");
const path = require("path");

// Data lives next to the app by default; on a host, set DATA_DIR to a persistent
// disk (e.g. /var/data on Render) so orders/invoices survive restarts & deploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error("data.json not found — run `node seed.js` first.");
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

let _cache = null;
function db() {
  if (!_cache) _cache = load();
  return _cache;
}

function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function nextId(collection) {
  const arr = db()[collection] || [];
  return arr.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
}

function reload() { _cache = null; return db(); }

module.exports = { db, save, nextId, reload, DATA_FILE };
