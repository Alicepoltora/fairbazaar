// E2E: full crypto + contract round-trip exactly as production does it.
// seller encrypts goods to agent -> buyer pays -> agent re-encrypts to buyer ->
// buyer decrypts from the Delivered event -> dispute -> arbiter verdict on-chain.
// Run: npx hardhat run scripts/e2e.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = require("ethers");
const nacl = require("tweetnacl");
const { sealTo, openWith, hex, unhex } = require("../agent/crypto");

const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "FairBazaar.json")));

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  const [owner, agentS, arbiterS, sellerS, buyerS] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));

  const factory = new ethers.ContractFactory(ART.abi, ART.bytecode, owner);
  const c = await factory.deploy(agentS.address, arbiterS.address, 3600, 3600, 1000, 200);
  await c.waitForDeployment();

  // identities
  const agentBox = nacl.box.keyPair();
  const buyerBox = nacl.box.keyPair();
  const GOODS = "LICENSE-KEY-A1B2-C3D4-E5F6 (lifetime, 100k req/mo)";

  // 1. seller lists: goods encrypted to the agent
  const encForAgent = sealTo(agentBox.publicKey, new TextEncoder().encode(GOODS));
  await (await c.connect(sellerS).createListing("Premium API key", "Lifetime API key, 100k req/mo", ethers.parseEther("1"), hex(encForAgent))).wait();

  // 2. buyer pays, leaving their encryption pubkey
  await (await c.connect(buyerS).buy(1, hex(buyerBox.publicKey), { value: ethers.parseEther("1") })).wait();

  // 3. agent: decrypt listing secret, re-encrypt to the buyer, deliver on-chain
  const l = await c.getListing(1);
  const o = await c.getOrder(1);
  const goodsPlain = openWith(agentBox.secretKey, unhex(l.encSecretForAgent));
  assert.equal(Buffer.from(goodsPlain).toString(), GOODS, "agent decrypts listing secret");
  const encForBuyer = sealTo(unhex(o.buyerPubKey), goodsPlain);
  await (await c.connect(agentS).deliver(1, hex(encForBuyer))).wait();

  // 4. buyer: read the Delivered event, decrypt locally
  const evs = await c.queryFilter(c.filters.Delivered(1), 0, "latest");
  const received = openWith(buyerBox.secretKey, unhex(evs[0].args.encSecretForBuyer));
  assert.equal(Buffer.from(received).toString(), GOODS, "buyer decrypts delivered goods");
  console.log("crypto round-trip OK — buyer received:", Buffer.from(received).toString());

  // 5. dispute + on-chain verdict with reasoning
  const stake = ethers.parseEther("0.1");
  await (await c.connect(buyerS).openDispute(1, "Key looks fine actually, but testing the court", { value: stake })).wait();
  await (await c.connect(arbiterS).resolveDispute(1, 2, "Goods match the description exactly; dispute unsubstantiated. Seller wins.")).wait();
  const res = await c.queryFilter(c.filters.DisputeResolved(1), 0, "latest");
  assert.equal(Number(res[0].args.verdict), 2);
  console.log("on-chain verdict OK:", res[0].args.reasoning);

  console.log("\nE2E PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
