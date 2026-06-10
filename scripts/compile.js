// Compiles contracts/FairBazaar.sol with solc and writes ABI + bytecode to build/
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "contracts", "FairBazaar.sol"), "utf8");

const input = {
  language: "Solidity",
  sources: { "FairBazaar.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
for (const w of (out.errors || [])) console.warn(w.formattedMessage);

const c = out.contracts["FairBazaar.sol"]["FairBazaar"];
fs.mkdirSync(path.join(root, "build"), { recursive: true });
fs.writeFileSync(
  path.join(root, "build", "FairBazaar.json"),
  JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
);
console.log("compiled OK, bytecode size:", c.evm.bytecode.object.length / 2, "bytes");
