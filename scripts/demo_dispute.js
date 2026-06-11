// Live dispute demo: demo buyer purchases a listing, waits for auto-delivery,
// opens a dispute, and waits for the AI arbiter's on-chain verdict.
// Run on the host with .env: node scripts/demo_dispute.js [listingId] ["dispute reason"]
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const nacl = require("tweetnacl");
const { sealTo, openWith, hex, unhex } = require("../agent/crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "FairBazaar.json")));

async function main() {
  const listingId = Number(process.argv[2] || 3);
  const reason = process.argv[3] || "The voucher code was already redeemed by someone else, the store rejects it";
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const buyer = new ethers.Wallet(JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".buyer.demo.json"))).pk, provider);
  const c = new ethers.Contract(process.env.CONTRACT_ADDRESS, ART.abi, buyer);

  const box = nacl.box.keyPair();
  const l = await c.getListing(listingId);
  console.log("buying:", l.title, ethers.formatEther(l.price), "OPN");
  await (await c.buy(listingId, hex(box.publicKey), { value: l.price })).wait();
  const orderId = Number(await c.nextOrderId()) - 1;
  console.log("order", orderId, "paid, waiting for delivery...");

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (Number((await c.getOrder(orderId)).status) === 2) break;
  }
  const goods = openWith(box.secretKey, unhex(await c.getDelivered(orderId)));
  console.log("delivered:", Buffer.from(goods).toString());

  const stake = (l.price * BigInt(await c.disputeStakeBps())) / 10000n;
  await (await c.openDispute(orderId, reason, { value: stake })).wait();
  console.log("dispute opened, stake", ethers.formatEther(stake), "OPN. Waiting for AI verdict...");

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const d = await c.getDispute(orderId);
    if (Number(d.verdict) > 0) {
      console.log("VERDICT:", ["", "BuyerWins", "SellerWins", "Split"][Number(d.verdict)]);
      console.log("REASONING:", d.reasoning);
      return;
    }
  }
  throw new Error("no verdict in 120s — check agent.log");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
