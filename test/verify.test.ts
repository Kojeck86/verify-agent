// verify.test.ts — Local tests for the Verify Agent.
// Run with: node test/verify.test.ts   (Node 24, zero dependencies.)
//
// Every on-chain test hits the live Sourcify API and the public BSC RPC
// (read-only eth_call — nothing is signed or sent). If the public RPC
// flakes, the agent retries once against the second dataseed; if both
// are down, the test fails loudly instead of reporting a fake verdict.

import { keccak256Hex, selector } from "../src/keccak.ts";
import { verifyCall } from "../src/verify.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    console.log(`  PASS ${name}${extra ? " — " + extra : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";
// CLAF Eye NFT — Sourcify exact_match on BSC (verified).
const CLAF = "0x1c759C4e075103b5B250DB5114B832b17B99C456";
// HOPKIN market — NOT Sourcify-verified (unverified).
const HOPKIN_MARKET = "0x7966Ef62E34772bf9f2Eba62fb37b2979e61a1BF";

/** Decode an ABI-encoded string return value (for readable test output). */
function decodeAbiString(hex: string): string | null {
  try {
    const pairs = hex.slice(2).match(/../g);
    if (!pairs || pairs.length < 64) return null;
    const b = new Uint8Array(pairs.map((h) => parseInt(h, 16)));
    const lenHex = [...b.slice(32, 64)]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const len = Number(BigInt("0x" + lenHex));
    return new TextDecoder().decode(b.slice(64, 64 + len));
  } catch {
    return null;
  }
}

// --- 1. Keccak-256 known vectors (proves the selector math is right) ---
console.log("keccak-256 vectors");
check(
  'keccak256("")',
  keccak256Hex(new Uint8Array(0)) ===
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
);
check(
  'keccak256("abc")',
  keccak256Hex(new TextEncoder().encode("abc")) ===
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
);
check(
  "selector transfer(address,uint256)",
  selector("transfer(address,uint256)") === "0xa9059cbb",
);
check("selector name()", selector("name()") === "0x06fdde03");
check(
  "selector balanceOf(address)",
  selector("balanceOf(address)") === "0x70a08231",
);
check("selector totalSupply()", selector("totalSupply()") === "0x18160ddd");
check("selector owner()", selector("owner()") === "0x8da5cb5b");

// --- 2. Live on-chain verdicts ---
console.log("\nlive on-chain tests (Sourcify + BSC RPC, read-only)");

const clafName = await verifyCall({
  chainId: 56,
  contract: CLAF,
  to: CLAF,
  data: "0x06fdde03", // name()
  from: ZERO,
  value: "0",
});
console.log("CLAF name() result:", JSON.stringify(clafName, null, 2));
check("CLAF name() verified", clafName.verified === true);
check("CLAF name() match exact_match", clafName.match === "exact_match");
check(
  "CLAF name() simulation succeeded",
  clafName.simulation.success === true,
  `name = ${JSON.stringify(decodeAbiString(clafName.simulation.returnData))}`,
);
check("CLAF name() verdict SAFE", clafName.verdict === "SAFE");

const clafSupply = await verifyCall({
  chainId: 56,
  contract: CLAF,
  to: CLAF,
  data: "0x18160ddd", // totalSupply()
  from: ZERO,
  value: "0",
});
check(
  "CLAF totalSupply() verdict SAFE",
  clafSupply.verdict === "SAFE",
  `totalSupply = ${parseInt(clafSupply.simulation.returnData, 16)}`,
);

const clafBogus = await verifyCall({
  chainId: 56,
  contract: CLAF,
  to: CLAF,
  data: "0xdeadbeef", // selector absent from the ABI
  from: ZERO,
  value: "0",
});
check(
  "CLAF bogus selector verdict BLOCKED",
  clafBogus.verdict === "BLOCKED",
  clafBogus.reasons.join(" | "),
);

const hopkinOwner = await verifyCall({
  chainId: 56,
  contract: HOPKIN_MARKET,
  to: HOPKIN_MARKET,
  data: "0x8da5cb5b", // owner()
  from: ZERO,
  value: "0",
});
console.log("HOPKIN owner() result:", JSON.stringify(hopkinOwner, null, 2));
check("HOPKIN owner() NOT verified", hopkinOwner.verified === false);
check(
  "HOPKIN owner() simulation succeeded",
  hopkinOwner.simulation.success === true,
  `owner = ${hopkinOwner.simulation.returnData.slice(0, 42)}`,
);
check("HOPKIN owner() verdict RISKY", hopkinOwner.verdict === "RISKY");

const clafMintPaid = await verifyCall({
  chainId: 56,
  contract: CLAF,
  to: CLAF,
  // mint(1) — payable; costFor(wallet, 1) = 0.0003 BNB, simulated from
  // the wallet that already holds 1 Eye (so this is mint #2, exact price).
  data: "0xa0712d680000000000000000000000000000000000000000000000000000000000000001",
  from: "0xf6C8bFDB891fde393EbE65Fd53437d8199011164",
  value: "300000000000000", // 0.0003 BNB
});
check(
  "CLAF mint(1) with exact cost 0.0003 BNB verdict RISKY",
  clafMintPaid.verdict === "RISKY",
  clafMintPaid.reasons.join(" | "),
);

// Same idea, wrong construction: sending value to a non-payable view
// function reverts, so the call as proposed cannot execute at all.
const clafNamePaid = await verifyCall({
  chainId: 56,
  contract: CLAF,
  to: CLAF,
  data: "0x06fdde03", // name()
  from: ZERO,
  value: "1000000000000000", // 0.001 BNB to a non-payable function
});
check(
  "CLAF name() with value verdict BLOCKED (non-payable rejects value)",
  clafNamePaid.verdict === "BLOCKED",
  clafNamePaid.reasons.join(" | "),
);

const clafWrongDest = await verifyCall({
  chainId: 56,
  contract: CLAF, // the contract we verified...
  to: HOPKIN_MARKET, // ...is not the destination of this call
  data: "0x8da5cb5b", // owner() — exists in CLAF's ABI and succeeds on HOPKIN
  from: ZERO,
  value: "0",
});
check(
  "CLAF contract but HOPKIN destination verdict RISKY",
  clafWrongDest.verdict === "RISKY",
  clafWrongDest.reasons.join(" | "),
);

console.log(
  failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
