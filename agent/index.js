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
const seed = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes("fairbazaar-nacl:" + process.env.AGENT_PRIVATE_KEY)));
const agentBox = nacl.box.keyPair.fromSecretKey(seed);
const openAsAgent = (payloadU8) => openWith(agentBox.secretKey, payloadU8);

// ---------------------------------------------------------------- arbiter
async function judge(listing, reason, goodsPlaintext) {
  if (!ANTHROPIC_KEY) {
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

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.ARBITER_MODEL || "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error("anthropic api " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = data.content.map((b) => b.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m[0]);
  const map = { BuyerWins: 1, SellerWins: 2, Split: 3 };
  if (!map[parsed.verdict]) throw new Error("bad verdict: " + parsed.verdict);
  return { verdict: map[parsed.verdict], reasoning: parsed.reasoning.slice(0, 1900) };
}

// ---------------------------------------------------------------- main loop
const handled = new Set(); // in-flight guard; chain state is the real source of truth

async function tick() {
  const nextOrderId = Number(await contract.nextOrderId());
  for (let id = 1; id < nextOrderId; id++) {
    if (handled.has(id)) continue;
    const o = await contract.getOrder(id);
    const status = Number(o.status);

    if (status === 1) { // Paid -> deliver
      handled.add(id);
      try {
        const l = await contract.getListing(o.listingId);
        const goods = openAsAgent(unhex(l.encSecretForAgent));
        const payload = sealTo(unhex(o.buyerPubKey), goods);
        const tx = await contract.connect(agentWallet).deliver(id, hex(payload));
        await tx.wait();
        console.log(`[delivery] order ${id} delivered, tx ${tx.hash}`);
      } catch (e) {
        console.error(`[delivery] order ${id} FAILED:`, e.message);
        handled.delete(id); // retry next tick
      }
    } else if (status === 3) { // Disputed -> judge
      handled.add(id);
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
        handled.delete(id);
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

const server = http.createServer((req, res) => {
  if (req.url === "/api/info") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({
      contract: CONTRACT,
      chainId: 984,
      rpcUrl: RPC_URL,
      agentNaclPub: hex(agentBox.publicKey),
      agentAddress: agentWallet.address,
      arbiterAddress: arbiterWallet.address,
      aiEnabled: !!ANTHROPIC_KEY,
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
  console.log("  AI judge :", ANTHROPIC_KEY ? "Claude (" + (process.env.ARBITER_MODEL || "claude-sonnet-4-6") + ")" : "MOCK MODE");
  server.listen(PORT, () => console.log("  http     : listening on :" + PORT));
  while (true) {
    try { await tick(); } catch (e) { console.error("[tick]", e.message); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
main();
