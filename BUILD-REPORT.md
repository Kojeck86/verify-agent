# Build Report — Verify Agent (zkVerify Agent Games, Wildcard track)

**Date:** 2026-11-14
**Repo:** `~/workspace/zkverify/wildcard-agent/`
**Status:** Built and tested locally. NOT deployed, NOT pushed to GitHub,
NOT registered — deployment and submission are handled by the parent.

## What was built

A read-only on-chain verification agent on Cloudflare Workers (TypeScript,
zero runtime dependencies). Before a user signs a transaction, it checks
the target contract's source verification (Sourcify v2) and simulates the
exact call (`eth_call` on a public BSC RPC), then returns a
`SAFE | RISKY | BLOCKED` verdict with per-check detail. It never holds
keys, never signs, and never sends a transaction.

### Files

| File | What it is |
| ---- | ---------- |
| `src/index.ts` | Workers entrypoint: `GET /`, `GET /health`, `POST /verify`, CORS, error mapping (400 bad input / 502 upstream down) |
| `src/verify.ts` | Core logic: Sourcify v2 check, `eth_call` simulation (dataseed1 → dataseed2 retry), safety checks, verdict rules |
| `src/keccak.ts` | Dependency-free Keccak-256 + 4-byte function selectors (BigInt lanes) |
| `test/verify.test.ts` | Keccak vectors + live on-chain verdict tests (Node 24, `npm test`) |
| `wrangler.toml` | Worker name `verify-agent`, `compatibility_date = "2026-11-14"` |
| `package.json` | Zero runtime deps; `wrangler` as devDependency only |
| `README.md` | Problem, how it works, endpoint docs + curl example, limits, zkVerify note |
| `BUILD-REPORT.md` | This file |

## Test results — all real, all from live calls run 2026-11-14

### Keccak-256 vectors — 7/7 PASS

`keccak256("")`, `keccak256("abc")`, and selectors for
`transfer(address,uint256)` → `0xa9059cbb`, `name()` → `0x06fdde03`,
`balanceOf(address)` → `0x70a08231`, `totalSupply()` → `0x18160ddd`,
`owner()` → `0x8da5cb5b` — all match the known values.

### Live on-chain verdicts (Sourcify + BSC public RPC, read-only)

| Test | Verdict | Key facts |
| ---- | ------- | --------- |
| CLAF Eye NFT `name()` — `0x1c759C4e075103b5B250DB5114B832b17B99C456` | **SAFE** | verified, `exact_match`; simulation succeeded; name = `"The Claf Eye"` |
| CLAF `totalSupply()` | **SAFE** | totalSupply = 7102 |
| CLAF bogus selector `0xdeadbeef` | **BLOCKED** | selector absent from verified ABI; simulation reverted |
| HOPKIN market `owner()` — `0x7966Ef62E34772bf9f2Eba62fb37b2979e61a1BF` | **RISKY** | NOT verified on Sourcify; simulation succeeded; owner = `0x4ee94abf93d1728ca2f97ab4dedd21cc9ff48061` |
| CLAF `mint(1)` with exact cost 0.0003 BNB (from the wallet holding 1 Eye; `costFor` confirmed 300000000000000 wei first) | **RISKY** | verified + simulation succeeded, but the call carries value |
| CLAF `name()` with value 0.001 BNB | **BLOCKED** | non-payable function rejects value; simulation reverted |
| CLAF contract, HOPKIN destination (`owner()`) | **RISKY** | destination differs from the verified contract |

Final run: **ALL TESTS PASSED** (7 keccak + 7 live verdict checks).

### Worker entrypoint smoke test — 8/8 PASS

Drove `src/index.ts` directly in Node with real `Request` objects:
`GET /health` → `{ok: true}`; `GET /` → info; `POST /verify` CLAF
`name()` → `SAFE` with `Access-Control-Allow-Origin: *`; missing fields
→ 400; bad address → 400; unknown route → 404; `OPTIONS` → 204 + CORS.

## Known limits (honest)

- **Simulation is BSC-only (chainId 56).** Other chains return `BLOCKED`
  with the reason stated, not a guessed verdict.
- **Depends on two public services.** If Sourcify or both BSC dataseeds
  are unreachable, the endpoint returns `502` instead of a verdict.
  (Fail loudly, never fake a verdict.)
- **Selector check needs a verified ABI.** Unverified contracts cannot be
  selector-checked; that is reported as a failed check, not skipped silently.
- **A successful simulation is not a guarantee.** State can change between
  simulation and execution; the agent does not estimate gas, check
  allowances or prices, or judge whether verified code is a good deal.
- **Wrangler deploy was NOT run here** (no deployment in this task), so
  `wrangler.toml` is provided but unproven against the live Workers
  runtime. The worker code itself was exercised end-to-end in Node
  (see smoke test above), and the core logic passes all live tests.

## Exact next steps for deployment (parent)

1. `cd ~/workspace/zkverify/wildcard-agent && npm install` (wrangler only).
2. `npx wrangler login` (Cloudflare account).
3. `npx wrangler deploy` → note the public URL
   (`https://verify-agent.<subdomain>.workers.dev`).
4. Smoke-test live: `GET /health`, then the `POST /verify` CLAF example
   in `README.md` (expect `SAFE`).
5. Create the public GitHub repo and push this code (commit already made
   locally as kojeck).
6. Submit to the Wildcard track with: repo link, public endpoint URL,
   use case (pre-sign verification for BSC users/agents), and build
   context from `README.md`.
