# Verify Agent

A **read-only on-chain verification agent**. Before you sign a transaction,
it checks the target contract and simulates the call, then returns a verdict:

- **SAFE** — verified contract, simulation succeeds, every check passes.
- **RISKY** — something is off (unverified contract, funds move, or the
  destination is not the contract that was verified). Think before signing.
- **BLOCKED** — the call cannot execute as proposed (simulation reverts, or
  the function selector is absent from the verified ABI). Do not sign.

It **never holds keys, never signs, and never sends a transaction**. It only
reads public data. That is the whole point: the agent that tells you
"don't sign this" has no ability to move your funds even if it is wrong.

Built for the **zkVerify Agent Games — Wildcard track** (Season 01).

## The problem

Most wallet drains and bad mints do not start with a hack — they start with
a user signing a call they did not verify. The site said "free", the contract
was unverified, the destination was not the contract shown on the page, or
the `value` field quietly carried funds. A clean simulation plus a decoded
function name is not a check; the contract source has to be independently
readable, and the exact call has to be simulated before anyone signs.

## Who it helps

Anyone about to sign a contract call on BSC — free-mint hunters, airdrop
claimers, and agents that transact on a user's behalf. The agent answers
one question, in one HTTP call: *is this exact call safe to sign?*

## How it works

`POST /verify` with `{chainId, contract, to, data, from, value}`:

1. **Source verification** — `GET https://sourcify.dev/server/v2/contract/{chainId}/{contract}?fields=abi`.
   Verified means the deployed bytecode matches published source
   (records `exact_match` / `partial` when present). Unverified means
   nobody can independently read what the contract does.
2. **Simulation** — `eth_call` against a public BSC RPC
   (`bsc-dataseed1.binance.org`, one retry against `bsc-dataseed2` if the
   first flakes; browser-like User-Agent, since public dataseeds sometimes
   reject non-browser clients). Records success/revert plus the return data
   or the decoded revert reason (`Error(string)`).
3. **Safety checks**
   - `value` vs. the claimed cost — flags any call that moves funds
     (e.g. a "free" mint whose `value` is above 0).
   - Destination (`to`) vs. the contract address that was verified.
   - The 4-byte selector in `data` vs. the functions in the verified ABI
     (selectors are computed with a dependency-free Keccak-256 in
     `src/keccak.ts`).
4. **Verdict**
   - `BLOCKED` — simulation reverts, or the selector is absent from a
     verified ABI.
   - `RISKY` — contract unverified, `value > 0`, or any other failed check.
   - `SAFE` — only when verified + simulation succeeds + every check passes.

## Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/` | Agent info + a worked example |
| GET | `/health` | Liveness probe, `{"ok": true}` |
| POST | `/verify` | Verify one proposed call |

`POST /verify` accepts any origin (CORS `Access-Control-Allow-Origin: *`).

### Example

```bash
curl -X POST https://verify-agent.<your-subdomain>.workers.dev/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "chainId": 56,
    "contract": "0x1c759C4e075103b5B250DB5114B832b17B99C456",
    "to": "0x1c759C4e075103b5B250DB5114B832b17B99C456",
    "data": "0x06fdde03",
    "from": "0x0000000000000000000000000000000000000000",
    "value": "0"
  }'
```

That is `name()` on the CLAF Eye NFT — a verified contract, read-only call.
Expected verdict: `SAFE` (live test returns `"name": "The Claf Eye"`).

### Response shape

```json
{
  "verdict": "SAFE",
  "verified": true,
  "match": "exact_match",
  "simulation": {
    "success": true,
    "returnData": "0x0000...000c54686520436c616620457965...",
    "revertReason": null
  },
  "checks": [
    { "name": "contract-verified", "pass": true, "detail": "source verified on Sourcify (exact_match)" },
    { "name": "destination-matches-contract", "pass": true, "detail": "call destination is the verified contract" },
    { "name": "value-is-zero", "pass": true, "detail": "value is 0 (no funds move with this call)" },
    { "name": "selector-in-abi", "pass": true, "detail": "selector 0x06fdde03 = name()" },
    { "name": "simulation-succeeded", "pass": true, "detail": "eth_call succeeded, return data 194 chars" }
  ],
  "reasons": []
}
```

Errors: `400` for malformed input (bad address, bad hex, missing fields),
`502` when Sourcify or the BSC RPC is unreachable (the agent fails loudly
instead of returning a fake verdict).

## What it can and cannot do

**Can:** verify BSC contract source via Sourcify; simulate any call with
`eth_call`; detect unverified contracts, value-carrying "free" calls,
destination mismatches, and selectors absent from the ABI; decode
`Error(string)` revert reasons.

**Cannot:** simulate chains other than BSC (chainId 56) — anything else is
reported `BLOCKED` with the reason, not guessed. It does not estimate gas,
check token allowances or prices, or judge whether a verified contract's
logic is honest — a verified contract can still be a bad deal; the agent
only proves *what the code is* and *whether this exact call executes*.
A simulation that succeeds can still fail at execution time (state changes,
front-running). A verdict is a pre-sign check, not a guarantee.

## The zkVerify connection

zkVerify exists because a claim about an agent ("my agent followed its
strategy", "this result is correct") is only as good as the proof behind
it. This agent works the same idea from the other side: before a user
trusts a contract call, the agent makes the claim *checkable* — the
source is independently verifiable on Sourcify, and the exact call is
simulated on-chain before anyone signs. Verification makes a claim
checkable; that is the same trust problem zkVerify proofs solve, applied
to the moment before a signature. A future version could attach a
zkVerify proof to each verdict so a third party can check the verdict
itself without re-running it.

## Local testing

Zero runtime dependencies; Node 24 runs the TypeScript directly.

```bash
npm test          # node test/verify.test.ts — keccak vectors + live on-chain verdicts
```

The live tests hit Sourcify and the public BSC RPC (read-only). See
`BUILD-REPORT.md` for the actual verdicts recorded.

## Deployment

```bash
npm install       # wrangler (devDependency only)
npx wrangler login
npx wrangler deploy   # -> https://verify-agent.<subdomain>.workers.dev
```

Then smoke-test the live endpoint: `GET /health` and the `POST /verify`
CLAF example above.

## Repo layout

```
src/
  index.ts    # Cloudflare Workers entrypoint (routes, CORS, error mapping)
  verify.ts   # core verification logic (Sourcify + eth_call + checks + verdict)
  keccak.ts   # dependency-free Keccak-256 + function selectors
test/
  verify.test.ts   # keccak vectors + live on-chain verdict tests (Node 24)
wrangler.toml      # name "verify-agent"
package.json
README.md
BUILD-REPORT.md
```
