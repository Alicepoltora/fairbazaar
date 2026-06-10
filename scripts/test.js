// End-to-end tests for FairBazaar on hardhat's in-process EVM.
// Run: npx hardhat run scripts/test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = require("ethers");

const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "FairBazaar.json")));

async function main() {
  // cacheTimeout: -1 — otherwise ethers caches identical RPC requests for 250ms,
  // which poisons tests that jump EVM time without real time passing.
  const provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  const [owner, agent, arbiter, seller, buyer] = await Promise.all(
    [0, 1, 2, 3, 4].map((i) => provider.getSigner(i))
  );

  const DELIVERY_WINDOW = 3600, DISPUTE_WINDOW = 3600, STAKE_BPS = 1000, FEE_BPS = 200;
  const factory = new ethers.ContractFactory(ART.abi, ART.bytecode, owner);
  const c = await factory.deploy(agent.address, arbiter.address, DELIVERY_WINDOW, DISPUTE_WINDOW, STAKE_BPS, FEE_BPS);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("deployed at", addr);

  const PRICE = ethers.parseEther("1");
  const pubkey = ethers.hexlify(ethers.randomBytes(32));
  const skip = async (s) => {
    await hre.network.provider.send("evm_increaseTime", [s]);
    await hre.network.provider.send("evm_mine");
  };
  const expectRevert = async (fn, label) => {
    let reverted = false;
    try { const tx = await fn(); if (tx && tx.wait) await tx.wait(); }
    catch (e) { reverted = true; }
    if (!reverted) throw new Error("expected revert but succeeded: " + label);
  };

  // ---------- 1. happy path: list -> buy -> deliver -> finalize
  let tx = await c.connect(seller).createListing("Premium API key", "Lifetime API key for ExampleService, 100k req/mo", PRICE, "0xdeadbeef");
  await tx.wait();
  tx = await c.connect(buyer).buy(1, pubkey, { value: PRICE });
  await tx.wait();
  await expectRevert(() => c.connect(buyer).buy(1, pubkey, { value: PRICE / 2n }), "wrong price");

  tx = await c.connect(agent).deliver(1, "0xbeef01");
  await tx.wait();
  await expectRevert(() => c.finalize(1), "window open");
  await skip(DISPUTE_WINDOW + 1);

  const sellerBefore = await provider.getBalance(seller.address);
  await (await c.finalize(1)).wait();
  const sellerAfter = await provider.getBalance(seller.address);
  const expectedPayout = PRICE - (PRICE * BigInt(FEE_BPS)) / 10000n;
  assert.equal(sellerAfter - sellerBefore, expectedPayout, "seller payout");
  let rep = await c.reputation(seller.address);
  assert.equal(rep.sales, 1n);
  console.log("happy path OK — seller paid", ethers.formatEther(expectedPayout), "OPN, rep.sales =", rep.sales);

  // ---------- 2. dispute path: buyer wins
  await (await c.connect(buyer).buy(1, pubkey, { value: PRICE })).wait();
  await (await c.connect(agent).deliver(2, "0xbeef02")).wait();
  const stake = (PRICE * BigInt(STAKE_BPS)) / 10000n;
  await expectRevert(() => c.connect(buyer).openDispute(2, "junk", { value: stake / 2n }), "wrong stake");
  await (await c.connect(buyer).openDispute(2, "The key is already revoked, does not match the description", { value: stake })).wait();
  await expectRevert(() => c.connect(seller).resolveDispute(2, 1, "I am not the arbiter"), "not arbiter");

  const buyerBefore = await provider.getBalance(buyer.address);
  await (await c.connect(arbiter).resolveDispute(2, 1, "Key was revoked before sale; listing promised a working lifetime key. Buyer wins.")).wait();
  const buyerAfter = await provider.getBalance(buyer.address);
  assert.equal(buyerAfter - buyerBefore, PRICE + stake, "refund + stake");
  rep = await c.reputation(seller.address);
  assert.equal(rep.disputesLost, 1n);
  console.log("dispute path OK — buyer refunded + stake back, rep.disputesLost =", rep.disputesLost);

  // ---------- 3. no-delivery refund path
  await (await c.connect(buyer).buy(1, pubkey, { value: PRICE })).wait();
  await expectRevert(() => c.connect(buyer).claimRefund(3), "too early");
  await skip(DELIVERY_WINDOW + 1);
  const b1 = await provider.getBalance(buyer.address);
  const rcpt = await (await c.connect(buyer).claimRefund(3)).wait();
  const gas = rcpt.gasUsed * rcpt.gasPrice;
  const b2 = await provider.getBalance(buyer.address);
  assert.equal(b2 - b1 + gas, PRICE, "timeout refund");
  console.log("timeout refund OK");

  // ---------- 4. score sanity
  const score = await c.sellerScore(seller.address);
  console.log("seller score:", score, "(1 sale=10, 1 lost dispute=-40 => 0 floor)");
  assert.equal(score, 0n);

  console.log("\nALL TESTS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
