# FairBazaar

**A digital goods marketplace where fairness is enforced by OPN Chain, not by a company.**

Built for IOPn Builders Growth Programme · Season 1 · DeFi & Open Finance.

## Live deployment (OPN Testnet, chainId 984)

- Contract: [`0xd083d72298429CadF536F29278a06f7c0dC22391`](https://testnet.iopn.tech/address/0xd083d72298429CadF536F29278a06f7c0dC22391)
- Live demo: https://style-printers-essex-victor.trycloudflare.com (tunnel URL, may rotate — see repo issues for the current one)
- Deployer / agent / arbiter: `0x7b4742D13De8E518B7cf7888E821f69650e3C128`
- Already on-chain: listings, purchases, automated deliveries, disputes and published AI verdicts — browse the contract's transactions.
- Arbiter brain: Groq llama-3.3-70b (swappable to Claude or any OpenAI-compatible API via .env)

## The problem

Buying digital goods (license keys, vouchers, access codes, files) from a stranger is a trust deadlock: the buyer won't pay first, the seller won't deliver first, and the platforms that solve this take 10–30% and own both your money and the dispute process.

## What FairBazaar does

| Step | What happens | Where |
|------|-------------|-------|
| List | Seller encrypts the goods **in the browser** to the delivery agent's key; only ciphertext + the canonical description go on-chain | on-chain |
| Buy | One click. Funds lock in escrow — never sent to the seller directly | on-chain |
| Deliver | The agent re-encrypts the goods to the **buyer's** key and publishes them in a transaction. The tx hash *is* the proof of delivery. Works 24/7, seller can be asleep | on-chain |
| No delivery? | After `deliveryWindow` the buyer claims a refund. No permission needed | on-chain |
| Dispute | Buyer stakes 10% and states a reason. An **AI arbiter (LLM)** judges the goods against the description fixed *before* the sale, and publishes verdict + full reasoning in a transaction — an auditable court | on-chain |
| Reputation | Every sale and every lost dispute moves the seller's **soulbound score**. It cannot be bought, sold, or transferred | on-chain |

## Why OPN Chain is load-bearing (not decorative)

1. **Escrow & atomic settlement** — the contract holds the money.
2. **Proof of delivery** — key handover is a transaction, not a claim.
3. **Auditable AI court** — every verdict + reasoning is permanent public record.
4. **Soulbound reputation** — sybil-resistant seller history.
5. **Trustless timeouts** — refunds and payouts execute without anyone's consent.

Remove the chain and nothing remains.

## Architecture

```
web/            browser app: ethers.js + tweetnacl, secrets en/decrypted locally
contracts/      FairBazaar.sol — escrow, disputes, verdicts, reputation
agent/          one Node process:
                  · delivery bot   (watches paid orders -> deliver() on-chain)
                  · AI arbiter     (watches disputes -> LLM -> resolveDispute())
                  · static server  (serves web/ + /api/info)
scripts/        compile / deploy / unit tests / crypto e2e
```

Encryption: X25519 sealed boxes (`nonce | ephemeralPub | ciphertext`). The plaintext goods exist only in the seller's browser, the agent's memory, and the buyer's browser. The chain carries only ciphertext.

## Run it

```bash
npm install
npm run compile
npx hardhat run --no-compile scripts/test.js   # unit tests
npx hardhat run --no-compile scripts/e2e.js    # full crypto round-trip + dispute court

cp .env.example .env              # fill in keys
npm run deploy                    # deploys to OPN testnet (chainId 984)
node agent/index.js               # delivery bot + arbiter + web UI on :8390
```

`.env`:
```
RPC_URL=https://testnet-rpc.iopn.tech
DEPLOYER_PRIVATE_KEY=0x...
AGENT_PRIVATE_KEY=0x...
CONTRACT_ADDRESS=0x...        # after deploy
GROQ_API_KEY=gsk_...          # or ANTHROPIC_API_KEY / any OpenAI-compatible LLM_API_URL+LLM_API_KEY
                              # without any key the arbiter runs in labelled mock mode
```

## Trust model, honestly

The delivery agent and AI arbiter are today single off-chain actors (their *actions* are fully on-chain and auditable, their liveness is not). This is the same trust shape as an oracle. The roadmap removes it step by step:

1. **Season 1 (now):** auditable single agent — every action is a public transaction.
2. **Arbiter panel:** N independent AI arbiters with different models vote; majority rules; stake-slashed for deviation.
3. **TEE delivery:** agent key sealed in a TEE so even the operator can't read the goods.
4. **Season 2 synergy (Identity & Reputation):** seller scores become portable soulbound credentials usable as collateral across OPN — reputation-gated trading limits, undercollateralized seller advances.

## Scoring criteria mapping

- **OPN Chain Integration (30%)** — five load-bearing uses listed above.
- **Technical Quality (25%)** — tested contracts, deterministic agent keys, crash-safe idempotent loop, e2e crypto tests.
- **Product & UX (20%)** — one-click buying, instant delivery, local-only decryption, human-readable verdicts.
- **Innovation (15%)** — first on-chain AI dispute court on OPN Chain.
- **Builder Commitment (10%)** — roadmap above; the Season 2 bridge is designed in from day one.
