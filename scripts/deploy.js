// Deploys FairBazaar to OPN Chain. Reads config from ../.env:
//   RPC_URL, DEPLOYER_PRIVATE_KEY, AGENT_ADDRESS?, ARBITER_ADDRESS?,
//   DELIVERY_WINDOW?, DISPUTE_WINDOW?, DISPUTE_STAKE_BPS?, FEE_BPS?
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "FairBazaar.json")));

async function main() {
  const rpc = process.env.RPC_URL || "https://testnet-rpc.iopn.tech";
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const net = await provider.getNetwork();
  const bal = await provider.getBalance(wallet.address);
  console.log("network  :", rpc, "chainId", net.chainId.toString());
  console.log("deployer :", wallet.address, "balance", ethers.formatEther(bal), "OPN");
  if (bal === 0n) throw new Error("Deployer has no funds. Use https://faucet.iopn.tech");

  const agent = process.env.AGENT_ADDRESS || wallet.address;
  const arbiter = process.env.ARBITER_ADDRESS || wallet.address;
  const deliveryWindow = Number(process.env.DELIVERY_WINDOW || 600);   // 10 min
  const disputeWindow = Number(process.env.DISPUTE_WINDOW || 900);     // 15 min
  const stakeBps = Number(process.env.DISPUTE_STAKE_BPS || 1000);      // 10%
  const feeBps = Number(process.env.FEE_BPS || 200);                   // 2%

  const f = new ethers.ContractFactory(ART.abi, ART.bytecode, wallet);
  const c = await f.deploy(agent, arbiter, deliveryWindow, disputeWindow, stakeBps, feeBps);
  console.log("deploy tx:", c.deploymentTransaction().hash);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("deployed :", addr);
  fs.writeFileSync(path.join(__dirname, "..", "deployment.json"), JSON.stringify({
    contract: addr, chainId: Number(net.chainId), rpc,
    deployer: wallet.address, agent, arbiter,
    deliveryWindow, disputeWindow, stakeBps, feeBps,
    deployTx: c.deploymentTransaction().hash, at: new Date().toISOString(),
  }, null, 2));
  console.log("saved deployment.json");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
