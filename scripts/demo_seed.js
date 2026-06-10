// Seeds demo listings on the live deployment and exercises one full purchase
// so the chain shows real activity: listing -> buy -> auto-delivery by the agent.
// Run on the host that has .env: node scripts/demo_seed.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const nacl = require("tweetnacl");
const { sealTo, openWith, hex, unhex } = require("../agent/crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "FairBazaar.json")));

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const seller = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const c = new ethers.Contract(process.env.CONTRACT_ADDRESS, ART.abi, seller);
  const info = await (await fetch(`http://localhost:${process.env.PORT || 8390}/api/info`)).json();
  const agentPub = unhex(info.agentNaclPub);

  const demos = [
    ["E-book: Building on OPN Chain", "PDF download link, 120 pages. Covers contracts, tooling and deployment on OPN. Link stays valid forever.", "0.05", "https://example.com/opn-book-download?token=DEMO-7f3a"],
    ["Premium API key — demo", "Demo API key for ExampleService. 30 days, 10k requests. Activates instantly.", "0.1", "EXSVC-30D-A1B2-C3D4-DEMO"],
    ["Game voucher (demo)", "Region-free voucher code for IndieGame Deluxe Edition. Redeem on the official store.", "0.08", "IGDX-REDEEM-9Z8Y-7X6W-DEMO"],
  ];

  const nextL = Number(await c.nextListingId());
  if (nextL === 1) {
    for (const [title, desc, price, secret] of demos) {
      const sealed = sealTo(agentPub, new TextEncoder().encode(secret));
      const tx = await c.createListing(title, desc, ethers.parseEther(price), hex(sealed));
      await tx.wait();
      console.log("listed:", title, tx.hash);
    }
  } else console.log("listings already exist:", nextL - 1);

  // demo purchase from a second wallet
  const buyerKeyFile = path.join(__dirname, "..", ".buyer.demo.json");
  let buyer;
  if (fs.existsSync(buyerKeyFile)) {
    buyer = new ethers.Wallet(JSON.parse(fs.readFileSync(buyerKeyFile)).pk, provider);
  } else {
    buyer = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync(buyerKeyFile, JSON.stringify({ pk: buyer.privateKey, address: buyer.address }));
    const tx = await seller.sendTransaction({ to: buyer.address, value: ethers.parseEther("0.4") });
    await tx.wait();
    console.log("funded demo buyer:", buyer.address);
  }

  const box = nacl.box.keyPair();
  const cb = c.connect(buyer);
  const l = await c.getListing(2);
  const tx = await cb.buy(2, hex(box.publicKey), { value: l.price });
  await tx.wait();
  const orderId = Number(await c.nextOrderId()) - 1;
  console.log("bought listing 2, order", orderId, tx.hash);

  process.stdout.write("waiting for agent auto-delivery");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const o = await c.getOrder(orderId);
    if (Number(o.status) === 2) {
      const evs = await c.queryFilter(c.filters.Delivered(orderId), 0, "latest");
      const pt = openWith(box.secretKey, unhex(evs[evs.length - 1].args.encSecretForBuyer));
      console.log("\nAUTO-DELIVERED on OPN testnet:", Buffer.from(pt).toString());
      return;
    }
    process.stdout.write(".");
  }
  throw new Error("agent did not deliver in 90s — check agent.log");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
