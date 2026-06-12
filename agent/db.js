// SQLite storage (built-in node:sqlite, zero native deps).
// Holds: encrypted product files (ciphertext only — the key never touches the
// server unencrypted) and a fast cache of on-chain listings for instant UI.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "..", "fairbazaar.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY,
    seller TEXT NOT NULL,
    price TEXT NOT NULL,
    active INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    sales INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reputation (
    seller TEXT PRIMARY KEY,
    sales INTEGER NOT NULL,
    won INTEGER NOT NULL,
    lost INTEGER NOT NULL,
    score TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const stmts = {
  insertFile: db.prepare("INSERT INTO files (id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  getFile: db.prepare("SELECT * FROM files WHERE id = ?"),
  upsertListing: db.prepare(`INSERT INTO listings (id, seller, price, active, title, description, sales, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET active=excluded.active, sales=excluded.sales, updated_at=excluded.updated_at`),
  allListings: db.prepare("SELECT * FROM listings ORDER BY id DESC"),
  maxListingId: db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM listings"),
  upsertRep: db.prepare(`INSERT INTO reputation (seller, sales, won, lost, score, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(seller) DO UPDATE SET sales=excluded.sales, won=excluded.won, lost=excluded.lost, score=excluded.score, updated_at=excluded.updated_at`),
  allReps: db.prepare("SELECT * FROM reputation"),
};

module.exports = {
  saveFile(id, name, mime, data) {
    stmts.insertFile.run(id, name, mime, data.length, data, Date.now());
  },
  getFile(id) {
    return stmts.getFile.get(id);
  },
  upsertListing(l) {
    stmts.upsertListing.run(l.id, l.seller, l.price, l.active ? 1 : 0, l.title, l.description, l.sales, Date.now());
  },
  listings() {
    const reps = Object.fromEntries(stmts.allReps.all().map((r) => [r.seller, r]));
    return stmts.allListings.all().map((l) => ({ ...l, rep: reps[l.seller] || null }));
  },
  maxListingId() {
    return stmts.maxListingId.get().m;
  },
  upsertRep(seller, sales, won, lost, score) {
    stmts.upsertRep.run(seller, Number(sales), Number(won), Number(lost), String(score), Date.now());
  },
};
