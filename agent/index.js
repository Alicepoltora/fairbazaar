/**
 * FairBazaar agent — one process, three jobs:
 *   1. HTTP server: serves the web UI + exposes /api/info (agent's encryption pubkey).
 *   2. Delivery bot: watches for paid orders, re-encrypts the goods secret to the
 *      buyer's key and publishes it on-chain (the tx IS the proof of delivery).
 *   3. AI arbiter: watches for disputes, asks Claude to judge the case against the
 *      on-chain listing description, publishes verdict + reasoning on-chain.
 *
 * Design note: instead of fragile event subscriptions, the loop polls contract
 * state (orders are a public mapping) — idempotent, crash-safe, no missed events.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { ethers } = require("ethers");
const nacl = require("tweetnacl");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "FairBazaar.json")));
const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.iopn.tech";
const CONTRACT = process.env.CONTRACT_ADDRESS;
const PORT = Number(process.env.PORT || 8390);
const POLL_MS = Number(process.env.POLL_MS || 4000);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
// Any OpenAI-compatible endpoint works as the arbiter brain (Groq, OpenRouter,
// Gemini's OpenAI mode, ...). Groq is auto-wired when GROQ_API_KEY is set.
const LLM_URL = process.env.LLM_API_URL || (process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "");
const LLM_KEY = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "llama-3.3-70b-versatile";
const AI_ENABLED = !!(ANTHROPIC_KEY || (LLM_URL && LLM_KEY));
const AI_NAME = ANTHROPIC_KEY ? "Claude (" + (process.env.ARBITER_MODEL || "claude-sonnet-4-6") + ")" : AI_ENABLED ? LLM_MODEL : "MOCK MODE";

if (!CONTRACT || !process.env.AGENT_PRIVATE_KEY) {
  console.error("Set CONTRACT_ADDRESS and AGENT_PRIVATE_KEY in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const agentWallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
const arbiterWallet = process.env.ARBITER_PRIVATE_KEY
  ? new ethers.Wallet(process.env.ARBITER_PRIVATE_KEY, provider)
  : agentWallet;
const contract = new ethers.Contract(CONTRACT, ART.abi, provider);

// ---------------------------------------------------------------- crypto
// Agent's X25519 box keypair, deterministically derived from its eth key so a
// restart never loses the ability to decrypt listing secrets.
const { sealTo, openWith, hex, unhex } = require("./crypto");
const store = require("./db");
const seed = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes("fairbazaar-nacl:" + process.env.AGENT_PRIVATE_KEY)));
const agentBox = nacl.box.keyPair.fromSecretKey(seed);
const openAsAgent = (payloadU8) => openWith(agentBox.secretKey, payloadU8);

// ---------------------------------------------------------------- arbiter
async function judge(listing, reason, goodsPlaintext) {
  if (!AI_ENABLED) {
    // Mock mode for local demos without an API key. Clearly labelled on-chain.
    return { verdict: 3, reasoning: "[MOCK ARBITER] No AI key configured; defaulting to a 50/50 split pending human review." };
  }
  const prompt = `You are the neutral arbiter of an on-chain digital goods marketplace.
A buyer disputes a delivered order. Decide strictly from the evidence.

EVIDENCE
1. Listing title (seller's promise): ${listing.title}
2. Listing description (the canonical promise, fixed on-chain BEFORE the sale): ${listing.description}
3. The actual delivered goods (decrypted secret): ${goodsPlaintext}
4. Buyer's dispute reason: ${reason}

RULES
- BuyerWins: goods clearly do not match the description (empty, garbage, revoked, mismatched).
- SellerWins: goods plausibly match the description and the dispute looks frivolous or unproven.
- Split: genuine ambiguity, partial mismatch, or evidence insufficient either way.
- You cannot verify external claims (e.g. "the key was already used") — weigh plausibility.

Reply with ONLY a JSON object: {"verdict": "BuyerWins"|"SellerWins"|"Split", "reasoning": "<3-5 sentences, neutral tone>"}`;

  let text;
  if (ANTHROPIC_KEY) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ARBITER_MODEL || "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error("anthropic api " + res.status + ": " + (await res.text()).slice(0, 200));
    const data = await res.json();
    text = data.content.map((b) => b.text || "").join("");
  } else {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + LLM_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: LLM_MODEL, max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error("llm api " + res.status + ": " + (await res.text()).slice(0, 200));
    const data = await res.json();
    text = data.choices[0].message.content;
  }
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m[0]);
  const map = { BuyerWins: 1, SellerWins: 2, Split: 3 };
  if (!map[parsed.verdict]) throw new Error("bad verdict: " + parsed.verdict);
  return { verdict: map[parsed.verdict], reasoning: parsed.reasoning.slice(0, 1900) };
}

// ---------------------------------------------------------------- listing cache
// Mirrors on-chain listings + reputations into SQLite so the storefront renders
// instantly from /api/listings instead of N chain calls through a public RPC.
let lastFullSync = 0;
async function syncListings() {
  const next = Number(await contract.nextListingId());
  const known = store.maxListingId();
  const full = Date.now() - lastFullSync > 30000; // refresh active/sales every 30s
  const sellers = new Set();
  for (let id = 1; id < next; id++) {
    if (id <= known && !full) continue;
    const l = await contract.getListing(id);
    store.upsertListing({ id, seller: l.seller, price: l.price.toString(), active: l.active, title: l.title, description: l.description, sales: Number(l.salesCount) });
    sellers.add(l.seller);
  }
  if (full) {
    for (const s of sellers) {
      const [rep, score] = await Promise.all([contract.reputation(s), contract.sellerScore(s)]);
      store.upsertRep(s, rep.sales, rep.disputesWon, rep.disputesLost, score);
    }
    lastFullSync = Date.now();
  }
}

// ---------------------------------------------------------------- main loop
const handled = new Set(); // in-flight guard; chain state is the real source of truth

async function tick() {
  const nextOrderId = Number(await contract.nextOrderId());
  for (let id = 1; id < nextOrderId; id++) {
    const o = await contract.getOrder(id);
    const status = Number(o.status);
    const key = id + ":" + status; // an order re-enters the queue on every status change
    if (handled.has(key)) continue;

    if (status === 1) { // Paid -> deliver
      handled.add(key);
      try {
        const l = await contract.getListing(o.listingId);
        const goods = openAsAgent(unhex(l.encSecretForAgent));
        const payload = sealTo(unhex(o.buyerPubKey), goods);
        const tx = await contract.connect(agentWallet).deliver(id, hex(payload));
        await tx.wait();
        console.log(`[delivery] order ${id} delivered, tx ${tx.hash}`);
      } catch (e) {
        console.error(`[delivery] order ${id} FAILED:`, e.message);
        handled.delete(key); // retry next tick
      }
    } else if (status === 3) { // Disputed -> judge
      handled.add(key);
      try {
        const l = await contract.getListing(o.listingId);
        const reason = (await contract.getDispute(id)).reason || "(reason unavailable)";
        let goodsPlaintext = "(could not decrypt)";
        try { goodsPlaintext = Buffer.from(openAsAgent(unhex(l.encSecretForAgent))).toString("utf8"); } catch {}
        const { verdict, reasoning } = await judge(l, reason, goodsPlaintext);
        const tx = await contract.connect(arbiterWallet).resolveDispute(id, verdict, reasoning);
        await tx.wait();
        console.log(`[arbiter] order ${id} resolved: verdict=${verdict}, tx ${tx.hash}`);
      } catch (e) {
        console.error(`[arbiter] order ${id} FAILED:`, e.message);
        handled.delete(key);
      }
    } else if (status === 2) { // Delivered -> finalize when window passed
      try {
        const dw = Number(await contract.disputeWindow());
        const now = Math.floor(Date.now() / 1000);
        if (now > Number(o.deliveredAt) + dw + 5) {
          const tx = await contract.connect(agentWallet).finalize(id);
          await tx.wait();
          console.log(`[settle] order ${id} finalized, tx ${tx.hash}`);
        }
      } catch (e) { /* someone else may have finalized — fine */ }
    }
  }
}

// ---------------------------------------------------------------- http
const WEB_DIR = path.join(__dirname, "..", "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

const MAX_UPLOAD = 25 * 1024 * 1024; // 25 MB ciphertext cap

const server = http.createServer((req, res) => {
  // -- product file upload: body is ciphertext (encrypted in the seller's browser)
  if (req.method === "POST" && req.url === "/api/upload") {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { res.writeHead(413); res.end("too large"); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size === 0 || size > MAX_UPLOAD) return;
      const id = require("crypto").randomBytes(12).toString("hex");
      const name = decodeURIComponent(req.headers["x-file-name"] || "file.bin").slice(0, 200);
      const mime = (req.headers["x-file-mime"] || "application/octet-stream").slice(0, 100);
      store.saveFile(id, name, mime, Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fileId: id, size }));
    });
    return;
  }
  // -- encrypted product file download (buyer decrypts locally with the delivered key)
  if (req.url.startsWith("/api/file/")) {
    const f = store.getFile(req.url.slice("/api/file/".length).split("?")[0]);
    if (!f) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(f.name), "x-file-mime": f.mime, "access-control-expose-headers": "x-file-name, x-file-mime" });
    res.end(Buffer.from(f.data));
    return;
  }
  // -- instant storefront: listings mirrored from chain into SQLite
  if (req.url === "/api/listings") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ listings: store.listings() }));
    return;
  }
  if (req.url === "/api/info") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({
      contract: CONTRACT,
      chainId: 984,
      rpcUrl: RPC_URL,
      agentNaclPub: hex(agentBox.publicKey),
      agentAddress: agentWallet.address,
      arbiterAddress: arbiterWallet.address,
      aiEnabled: AI_ENABLED,
      aiModel: AI_NAME,
    }));
    return;
  }
  if (req.url === "/abi.json") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ abi: ART.abi }));
    return;
  }
  let file = req.url.split("?")[0];
  if (file === "/") file = "/index.html";
  const fp = path.normalize(path.join(WEB_DIR, file));
  if (!fp.startsWith(WEB_DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});

async function main() {
  console.log("FairBazaar agent");
  console.log("  contract :", CONTRACT);
  console.log("  agent    :", agentWallet.address);
  console.log("  arbiter  :", arbiterWallet.address);
  console.log("  nacl pub :", hex(agentBox.publicKey));
  console.log("  AI judge :", AI_NAME);
  server.listen(PORT, () => console.log("  http     : listening on :" + PORT));
  while (true) {
    try { await tick(); } catch (e) { console.error("[tick]", e.message); }
    try { await syncListings(); } catch (e) { console.error("[sync]", e.message); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
main();
