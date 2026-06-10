// X25519 sealed-box helpers shared by the agent and tests.
// payload layout: nonce(24) | ephemeralPub(32) | ciphertext
const nacl = require("tweetnacl");

const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const unhex = (h) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));

function sealTo(pubkey32, plaintextU8) {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box(plaintextU8, nonce, pubkey32, eph.secretKey);
  const out = new Uint8Array(24 + 32 + ct.length);
  out.set(nonce, 0); out.set(eph.publicKey, 24); out.set(ct, 56);
  return out;
}

function openWith(secretKey32, payloadU8) {
  const nonce = payloadU8.slice(0, 24);
  const ephPub = payloadU8.slice(24, 56);
  const ct = payloadU8.slice(56);
  const pt = nacl.box.open(ct, nonce, ephPub, secretKey32);
  if (!pt) throw new Error("decryption failed");
  return pt;
}

module.exports = { sealTo, openWith, hex, unhex };
