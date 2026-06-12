/* Seller studio. Files are encrypted with a random symmetric key in the browser
 * (nacl.secretbox); the server receives ciphertext only. The symmetric key rides
 * inside the existing sealed-box delivery pipeline:
 *   secret string = FILE:<fileId>:<keyHex>:<fileName>
 * which is sealed to the delivery agent and re-sealed to each buyer on purchase. */

const $ = (id) => document.getElementById(id);
const toast = (msg, ms = 4500) => { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = "none"), ms); };
const hex = (u8) => "0x" + Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array((h.replace(/^0x/, "").match(/.{2}/g) || []).map((x) => parseInt(x, 16)));
const sealTo = (pub, msgU8) => { const e = nacl.box.keyPair(), n = nacl.randomBytes(24); const ct = nacl.box(msgU8, n, pub, e.secretKey); const o = new Uint8Array(56 + ct.length); o.set(n); o.set(e.publicKey, 24); o.set(ct, 56); return o; };
const err = (e) => (e.shortMessage || e.message || String(e)).slice(0, 140);
const MAX_FILE = 20 * 1024 * 1024;

let INFO, ABI, contract, me, kind = "file", pickedFile = null;

async function init() {
  INFO = await (await fetch("/api/info")).json();
  ABI = (await (await fetch("/abi.json")).json()).abi;
  $("connectBtn").addEventListener("click", connect);
  $("createBtn").addEventListener("click", createListing);
  $("kindFile").addEventListener("click", () => setKind("file"));
  $("kindText").addEventListener("click", () => setKind("text"));
  $("drop").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", () => {
    pickedFile = $("file").files[0] || null;
    if (pickedFile && pickedFile.size > MAX_FILE) { toast("File too large (max 20 MB)."); pickedFile = null; $("file").value = ""; return; }
    $("drop").classList.toggle("has", !!pickedFile);
    $("drop").textContent = pickedFile ? `${pickedFile.name} · ${(pickedFile.size / 1024).toFixed(1)} KB — will be encrypted locally` : "Click to choose a file (up to 20 MB)";
  });
  // auto-reconnect if the wallet already authorised this site
  if (window.ethereum) {
    const accs = await window.ethereum.request({ method: "eth_accounts" });
    if (accs.length) await connect();
  }
}

function setKind(k) {
  kind = k;
  $("kindFile").classList.toggle("on", k === "file");
  $("kindText").classList.toggle("on", k === "text");
  $("fileZone").style.display = k === "file" ? "" : "none";
  $("textZone").style.display = k === "text" ? "" : "none";
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
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  me = await signer.getAddress();
  contract = new ethers.Contract(INFO.contract, ABI, signer);
  $("connectBtn").textContent = me.slice(0, 6) + "…" + me.slice(-4);
  renderMine();
}

const progress = (s) => { $("progress").innerHTML = s; };

async function createListing() {
  if (!contract) return toast("Connect your wallet first.");
  const title = $("sTitle").value.trim(), desc = $("sDesc").value.trim(), price = $("sPrice").value;
  if (!title || !desc || !price || Number(price) <= 0) return toast("Fill in title, description and price.");

  let secretString;
  try {
    if (kind === "file") {
      if (!pickedFile) return toast("Choose a file first.");
      progress("<b>1/3</b> Encrypting in your browser…");
      const buf = new Uint8Array(await pickedFile.arrayBuffer());
      const key = nacl.randomBytes(32);
      const nonce = nacl.randomBytes(24);
      const ct = nacl.secretbox(buf, nonce, key);
      const blob = new Uint8Array(24 + ct.length);
      blob.set(nonce); blob.set(ct, 24);

      progress("<b>2/3</b> Uploading ciphertext…");
      const up = await fetch("/api/upload", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(pickedFile.name), "x-file-mime": pickedFile.type || "application/octet-stream" },
        body: blob,
      });
      if (!up.ok) throw new Error("upload failed: " + up.status);
      const { fileId } = await up.json();
      secretString = `FILE:${fileId}:${hex(key)}:${pickedFile.name}`;
    } else {
      secretString = $("sSecret").value.trim();
      if (!secretString) return toast("Paste the goods first.");
      progress("<b>1/2</b> Sealing the secret…");
    }

    progress((kind === "file" ? "<b>3/3</b>" : "<b>2/2</b>") + " Publishing the listing on OPN Chain — confirm in your wallet…");
    const sealed = sealTo(unhex(INFO.agentNaclPub), new TextEncoder().encode(secretString));
    const tx = await contract.createListing(title, desc, ethers.parseEther(price), hex(sealed));
    await tx.wait();
    progress("");
    toast("Listed! It's already visible on the market.");
    $("sTitle").value = $("sDesc").value = $("sPrice").value = ""; if ($("sSecret")) $("sSecret").value = "";
    pickedFile = null; $("file").value = ""; $("drop").classList.remove("has");
    $("drop").textContent = "Click to choose a file (up to 20 MB)";
    setTimeout(renderMine, 1500);
  } catch (e) { progress(""); toast(err(e)); }
}

async function renderMine() {
  if (!me) return;
  const { listings } = await (await fetch("/api/listings")).json();
  const mine = listings.filter((l) => l.seller.toLowerCase() === me.toLowerCase());
  $("mineEmpty").style.display = mine.length ? "none" : "";
  $("mineEmpty").textContent = "No listings yet — create your first one.";
  const box = $("mine"); box.innerHTML = "";
  for (const l of mine) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="row"><h3></h3><span style="flex:1"></span><span class="badge ${l.active ? "" : "off"}">${l.active ? "active" : "hidden"}</span></div>
      <div class="row" style="margin-top:6px">
        <span class="price">${ethers.formatEther(BigInt(l.price))} OPN</span>
        <span class="muted">· ${l.sales} sales · listing #${l.id}</span>
        <span style="flex:1"></span>
        <button class="btn ghost small">${l.active ? "Hide" : "Show"}</button>
      </div>`;
    card.querySelector("h3").textContent = l.title;
    card.querySelector("button").addEventListener("click", async () => {
      try { await (await contract.setListingActive(l.id, !l.active)).wait(); toast(l.active ? "Hidden." : "Visible again."); setTimeout(renderMine, 1500); }
      catch (e) { toast(err(e)); }
    });
    box.appendChild(card);
  }
}

init().catch((e) => toast("Init failed: " + err(e)));
