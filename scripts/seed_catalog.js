// Seeds a varied demo catalog: text-secret products and encrypted file products.
// Run on the host with .env: node scripts/seed_catalog.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const nacl = require("tweetnacl");
const { sealTo, hex, unhex } = require("../agent/crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "FairBazaar.json")));
const PORT = process.env.PORT || 8390;

const TEXT_PRODUCTS = [
  ["Lifetime Pro license — PixelForge editor", "One lifetime activation key for PixelForge Pro (vector + raster editor). Activates offline, includes all 5.x updates. One machine at a time, transferable.", "0.25", "PXLF-PRO-LIFE-4F7A-DEMO"],
  ["Steam key: Nebula Drift — Deluxe Edition", "Region-free Steam key for Nebula Drift Deluxe: base game + soundtrack + 2 DLC packs. Redeem in any region, no VPN needed.", "0.15", "NBLD-DLX-9K2M-77QX-DEMO"],
  ["WeatherPro REST API — 1M calls package", "API key for WeatherPro v3: 1,000,000 calls, 12 months, all endpoints (forecast, history, radar tiles). Docs at weatherpro.example/docs. Key activates within a minute of purchase.", "0.2", "WPRO-1M-API-B3C9-DEMO"],
  ["1000+ AI Prompt Library for Marketers", "Curated Notion database: 1,000+ tested prompts for ads, SEO, email and social, organised by funnel stage, with output examples. Link gives permanent duplicate access.", "0.06", "https://notion.example/prompt-library-DEMO-ACCESS"],
  ["Notion Startup OS — full template", "The exact operating system we run a 6-person startup on: roadmap, CRM, hiring pipeline, investor CRM, weekly review dashboards. Duplicate to your workspace in one click.", "0.09", "https://notion.example/startup-os-DEMO-DUPLICATE"],
  ["Lo-fi beats sample pack vol. 2 (WAV)", "60 royalty-free lo-fi loops and one-shots, 24-bit WAV, 80–92 BPM, tagged by key. Cleared for commercial use, no attribution required. Download link, no expiry.", "0.1", "https://cdn.example/lofi-vol2.zip?token=DEMO-DL"],
  ["E-mail course: Launch on OPN in 7 days", "Seven daily lessons on shipping a dApp on OPN Chain: tooling, contracts, verification, going live. Includes code repos and a private Q&A channel invite.", "0.04", "https://course.example/opn-7days/join?code=DEMO-SEAT"],
];

const FILE_PRODUCTS = [
  ["The Solidity Patterns Handbook (PDF)", "120-page handbook of production Solidity patterns: escrow, timeouts, pull-payments, soulbound tokens, upgrade-safety. Code-first, every pattern with a deployed example on OPN testnet.", "0.12",
    "solidity-patterns-handbook.pdf", "application/pdf",
    "%PDF-DEMO\n" + "The Solidity Patterns Handbook — demo copy.\n".repeat(400)],
  ["Icon pack: 120 crypto & DeFi icons (SVG)", "120 hand-drawn SVG icons: wallets, chains, swaps, vaults, governance. Stroke + filled variants, 24px grid, MIT licence for commercial use.", "0.07",
    "crypto-icons-pack.svg", "image/svg+xml",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>crypto icon pack — demo sample</title><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12h8M12 8v8" stroke="currentColor" stroke-width="2"/></svg>\n' + "<!-- demo pack filler -->\n".repeat(300)],
  ["WireGuard VPN config — 12 months (NL)", "Pre-provisioned WireGuard config, Amsterdam exit node, 1 Gbps port, unlimited traffic, valid 12 months from purchase. Works on every WireGuard client.", "0.18",
    "wg-nl-demo.conf", "text/plain",
    "[Interface]\nPrivateKey = DEMO-KEY-NOT-REAL\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = DEMO-PEER-NOT-REAL\nEndpoint = nl.vpn.example:51820\nAllowedIPs = 0.0.0.0/0\n"],
];

async function main() {
  const info = await (await fetch(`http://localhost:${PORT}/api/info`)).json();
  const agentPub = unhex(info.agentNaclPub);
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const seller = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const c = new ethers.Contract(process.env.CONTRACT_ADDRESS, ART.abi, seller);

  for (const [title, desc, price, secret] of TEXT_PRODUCTS) {
    const sealed = sealTo(agentPub, new TextEncoder().encode(secret));
    const tx = await c.createListing(title, desc, ethers.parseEther(price), hex(sealed));
    await tx.wait();
    console.log("listed:", title);
  }

  for (const [title, desc, price, fname, mime, content] of FILE_PRODUCTS) {
    const fileBytes = Buffer.from(content);
    const key = nacl.randomBytes(32), nonce = nacl.randomBytes(24);
    const ct = nacl.secretbox(fileBytes, nonce, key);
    const up = await fetch(`http://localhost:${PORT}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(fname), "x-file-mime": mime },
      body: Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]),
    });
    const { fileId } = await up.json();
    const secretString = `FILE:${fileId}:${hex(key)}:${fname}`;
    const sealed = sealTo(agentPub, new TextEncoder().encode(secretString));
    const tx = await c.createListing(title, desc, ethers.parseEther(price), hex(sealed));
    await tx.wait();
    console.log("listed (file):", title);
  }
  console.log("catalog seeded");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
