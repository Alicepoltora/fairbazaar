/* FairBazaar web app — talks to the contract directly; the agent only serves
 * this page and runs delivery/arbitration. Buyer encryption keys are generated
 * and stored locally; plaintext goods never touch any server. */

const $ = (id) => document.getElementById(id);
const toast = (msg, ms = 4200) => { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = "none"), ms); };

let INFO, ABI, provider, signer, me, contract, ro; // ro = read-only contract

const STATUS = ["None", "Paid", "Delivered", "Disputed", "Completed", "Refunded", "Resolved"];
const SCLASS = ["", "b-paid", "b-delivered", "b-disputed", "b-completed", "b-refunded", "b-resolved"];
const VERDICT = ["", "Buyer wins", "Seller wins", "50/50 split"];

// ---------- local buyer keypair (X25519) ----------
function myBox() {
  let kp = localStorage.getItem("fb_box");
  if (kp) { const o = JSON.parse(kp); return { publicKey: unhex(o.p), secretKey: unhex(o.s) }; }
  const fresh = nacl.box.keyPair();
  localStorage.setItem("fb_box", JSON.stringify({ p: hex(fresh.publicKey), s: hex(fresh.secretKey) }));
  return fresh;
}
const hex = (u8) => "0x" + Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array((h.replace(/^0x/, "").match(/.{2}/g) || []).map((x) => parseInt(x, 16)));
const sealTo = (pub, msgU8) => { const e = nacl.box.keyPair(), n = nacl.randomBytes(24); const ct = nacl.box(msgU8, n, pub, e.secretKey); const o = new Uint8Array(56 + ct.length); o.set(n); o.set(e.publicKey, 24); o.set(ct, 56); return o; };
const openMine = (payload) => { const n = payload.slice(0, 24), ep = payload.slice(24, 56), ct = payload.slice(56); return nacl.box.open(ct, n, ep, myBox().secretKey); };

// ---------- bootstrap ----------
async function init() {
  INFO = await (await fetch("/api/info")).json();
  ABI = (await (await fetch("/abi.json")).json()).abi;
  $("contractAddr").textContent = INFO.contract;
  $("arbiterAddr").textContent = INFO.arbiterAddress;
  $("aiMode").textContent = INFO.aiEnabled ? "Arbiter: Claude AI." : "Arbiter: mock mode (demo).";
  ro = new ethers.Contract(INFO.contract, ABI, new ethers.JsonRpcProvider(INFO.rpcUrl));
  renderMarket();
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
  $("connectBtn").addEventListener("click", connect);
  $("createBtn").addEventListener("click", createListing);
}

function switchView(v) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  for (const s of ["market", "orders", "sell"]) $("view-" + s).style.display = s === v ? "" : "none";
  if (v === "market") renderMarket();
  if (v === "orders") renderOrders();
}

async function connect() {
  if (!window.ethereum) return toast("Install MetaMask (or any EVM wallet) first.");
  const chainHex = "0x" + (984).toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: chainHex, chainName: "OPN Testnet", nativeCurrency: { name: "OPN", symbol: "OPN", decimals: 18 }, rpcUrls: [INFO.rpcUrl], blockExplorerUrls: ["https://testnet.iopn.tech"] }] });
    } else throw e;
  }
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  me = await signer.getAddress();
  contract = new ethers.Contract(INFO.contract, ABI, signer);
  $("connectBtn").textContent = me.slice(0, 6) + "…" + me.slice(-4);
  toast("Wallet connected.");
}
const needWallet = () => { if (!contract) { toast("Connect your wallet first."); return true; } return false; };

// ---------- market ----------
async function renderMarket() {
  const n = Number(await ro.nextListingId());
  const grid = $("listings"); grid.innerHTML = "";
  let shown = 0;
  for (let i = n - 1; i >= 1; i--) {
    const l = await ro.getListing(i);
    if (!l.active) continue;
    shown++;
    const rep = await ro.reputation(l.seller);
    const score = await ro.sellerScore(l.seller);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="row"><h3></h3><span class="spacer"></span><span class="price">${ethers.formatEther(l.price)} OPN</span></div>
      <div class="desc"></div>
      <div class="rep">Seller <b class="mono">${l.seller.slice(0, 6)}…${l.seller.slice(-4)}</b> · score <b>${score}</b> · ${rep.sales} sales · ${rep.disputesLost} lost disputes</div>
      <div class="row"><button class="btn small">Buy now</button><span class="muted">escrow + auto-delivery</span></div>`;
    card.querySelector("h3").textContent = l.title;
    card.querySelector(".desc").textContent = l.description;
    card.querySelector("button").addEventListener("click", () => buy(i, l.price));
    grid.appendChild(card);
  }
  $("marketEmpty").style.display = shown ? "none" : "";
}

async function buy(listingId, price) {
  if (needWallet()) return;
  try {
    const pub = hex(myBox().publicKey);
    const tx = await contract.buy(listingId, pub, { value: price });
    toast("Payment sent to escrow…");
    await tx.wait();
    toast("Paid! The agent is delivering your goods — check My orders.");
    switchView("orders");
  } catch (e) { toast(err(e)); }
}

// ---------- orders ----------
async function renderOrders() {
  if (!me) { $("ordersEmpty").style.display = ""; $("ordersEmpty").textContent = "Connect your wallet to see orders."; return; }
  const n = Number(await ro.nextOrderId());
  const grid = $("orders"); grid.innerHTML = "";
  let shown = 0;
  for (let i = n - 1; i >= 1; i--) {
    const o = await ro.getOrder(i);
    if (o.buyer.toLowerCase() !== me.toLowerCase()) continue;
    shown++;
    const l = await ro.getListing(o.listingId);
    const st = Number(o.status);
    const card = document.createElement("div");
    card.className = "card";
    let inner = `
      <div class="row"><h3></h3><span class="spacer"></span><span class="badge ${SCLASS[st]}">${STATUS[st]}</span></div>
      <div class="muted">Order #${i} · ${ethers.formatEther(o.price)} OPN</div>`;
    card.innerHTML = inner;
    card.querySelector("h3").textContent = l.title;

    if (st >= 2 && st !== 5) {
      // fetch the delivered secret from the Delivered event and decrypt locally
      try {
        const evs = await ro.queryFilter(ro.filters.Delivered(i), 0, "latest");
        if (evs.length) {
          const pt = openMine(unhex(evs[evs.length - 1].args.encSecretForBuyer));
          if (pt) {
            const box = document.createElement("div");
            box.className = "secret-box";
            box.textContent = new TextDecoder().decode(pt);
            card.appendChild(box);
          }
        }
      } catch (_) {}
    }
    if (st === 1) {
      const dw = Number(await ro.deliveryWindow());
      const eta = Number(o.paidAt) + dw;
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<span class="muted">Waiting for delivery… auto-refund available after ${new Date(eta * 1000).toLocaleTimeString()}</span>`;
      const b = document.createElement("button"); b.className = "btn small ghost"; b.textContent = "Claim refund";
      b.addEventListener("click", async () => { if (needWallet()) return; try { await (await contract.claimRefund(i)).wait(); toast("Refunded."); renderOrders(); } catch (e) { toast(err(e)); } });
      row.appendChild(b); card.appendChild(row);
    }
    if (st === 2) {
      const dw = Number(await ro.disputeWindow());
      const until = (Number(o.deliveredAt) + dw) * 1000;
      const row = document.createElement("div"); row.className = "row";
      const b = document.createElement("button"); b.className = "btn small ghost"; b.textContent = "Open dispute";
      b.addEventListener("click", () => openDispute(i, o.price));
      row.appendChild(b);
      const m = document.createElement("span"); m.className = "muted"; m.textContent = "until " + new Date(until).toLocaleString();
      row.appendChild(m); card.appendChild(row);
    }
    if (st === 3) {
      const v = document.createElement("div"); v.className = "verdict";
      v.innerHTML = "<b>AI arbiter is reviewing the case…</b> verdict will appear here and on-chain.";
      card.appendChild(v);
    }
    if (st === 6) {
      const evs = await ro.queryFilter(ro.filters.DisputeResolved(i), 0, "latest");
      if (evs.length) {
        const { verdict, reasoning } = evs[evs.length - 1].args;
        const v = document.createElement("div"); v.className = "verdict";
        v.innerHTML = `<b>Verdict: ${VERDICT[Number(verdict)]}</b><br>`;
        v.appendChild(document.createTextNode(reasoning));
        card.appendChild(v);
      }
    }
    grid.appendChild(card);
  }
  $("ordersEmpty").style.display = shown ? "none" : "";
  $("ordersEmpty").textContent = "No orders yet.";
}

async function openDispute(orderId, price) {
  if (needWallet()) return;
  const reason = prompt("Describe what's wrong (the AI arbiter reads this):");
  if (!reason) return;
  try {
    const bps = Number(await ro.disputeStakeBps());
    const stake = (price * BigInt(bps)) / 10000n;
    const tx = await contract.openDispute(orderId, reason, { value: stake });
    toast("Dispute opened — stake " + ethers.formatEther(stake) + " OPN locked.");
    await tx.wait();
    renderOrders();
  } catch (e) { toast(err(e)); }
}

// ---------- sell ----------
async function createListing() {
  if (needWallet()) return;
  const title = $("sTitle").value.trim(), desc = $("sDesc").value.trim(), secret = $("sSecret").value.trim();
  const price = $("sPrice").value;
  if (!title || !desc || !secret || !price) return toast("Fill in every field.");
  try {
    const payload = sealTo(unhex(INFO.agentNaclPub), new TextEncoder().encode(secret));
    const tx = await contract.createListing(title, desc, ethers.parseEther(price), hex(payload));
    toast("Creating listing…");
    await tx.wait();
    toast("Listed! Buyers get it auto-delivered while you sleep.");
    $("sTitle").value = $("sDesc").value = $("sSecret").value = $("sPrice").value = "";
    switchView("market");
  } catch (e) { toast(err(e)); }
}

const err = (e) => (e.shortMessage || e.message || String(e)).slice(0, 140);
init().catch((e) => toast("Init failed: " + err(e)));
