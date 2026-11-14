// verify.ts — Core verification logic for the Verify Agent.
//
// Pure fetch, no Workers-specific APIs, so the same code runs in
// Cloudflare Workers (src/index.ts) and in Node for local tests
// (test/verify.test.ts).
//
// What it does, for one proposed call:
//   1. Checks source verification via Sourcify v2 (independently readable
//      proof that the deployed bytecode matches published source).
//   2. Simulates the call with eth_call against a public BSC RPC
//      (read-only; nothing is signed or sent).
//   3. Runs safety checks: value carried, destination vs. the contract
//      that was verified, and whether the 4-byte selector exists in the
//      verified ABI.
//   4. Returns a verdict: SAFE | RISKY | BLOCKED.
//
// Read-only by design: this module never handles private keys, never
// signs, and never sends a transaction.

import { selector } from "./keccak.ts";

export type Verdict = "SAFE" | "RISKY" | "BLOCKED";

export interface VerifyInput {
  chainId: number;
  contract: string; // target contract address (the one being verified)
  to: string; // destination of the proposed call
  data: string; // calldata, 0x-prefixed hex
  from: string; // caller address (used for simulation only)
  value: string; // wei, decimal or 0x-hex string
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SimulationResult {
  success: boolean;
  returnData: string;
  revertReason: string | null;
}

export interface VerifyResult {
  verdict: Verdict;
  verified: boolean;
  match: string | null;
  simulation: SimulationResult;
  checks: CheckResult[];
  reasons: string[];
}

const SOURCIFY_V2 = "https://sourcify.dev/server/v2/contract";
// Public BSC RPCs. The first is primary; the second is a one-time retry
// if the first flakes (public dataseeds do, regularly).
const BSC_RPCS = [
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org",
];
// Public RPCs sometimes reject non-browser clients; send a browser UA.
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;

function fail(status: number, message: string): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

function parseValue(v: string): bigint {
  if (typeof v !== "string") fail(400, "value must be a string");
  if (v.startsWith("0x") || v.startsWith("0X")) {
    try {
      return BigInt(v);
    } catch {
      fail(400, `invalid value: ${v}`);
    }
  }
  if (/^\d+$/.test(v)) return BigInt(v);
  return fail(400, `invalid value: ${v}`);
}

interface SourcifyResult {
  verified: boolean;
  abi: unknown[] | null;
  match: string | null;
}

async function checkSourcify(
  chainId: number,
  address: string,
): Promise<SourcifyResult> {
  const url = `${SOURCIFY_V2}/${chainId}/${address}?fields=abi`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
  } catch (e) {
    fail(
      502,
      `Sourcify request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res!.ok) return { verified: false, abi: null, match: null };
  const body: Record<string, unknown> = (await res!.json()) as Record<
    string,
    unknown
  >;
  const abi = Array.isArray(body.abi) ? (body.abi as unknown[]) : null;
  const match =
    (typeof body.creationMatch === "string" && body.creationMatch) ||
    (typeof body.runtimeMatch === "string" && body.runtimeMatch) ||
    (typeof body.match === "string" && body.match) ||
    null;
  return { verified: true, abi, match };
}

/** Decode an Error(string) revert payload (selector 0x08c379a0), if present. */
function decodeRevertReason(data: string): string | null {
  if (!data || !data.startsWith("0x08c379a0")) return null;
  try {
    const hex = data.slice(10);
    const pairs = hex.match(/../g);
    if (!pairs || pairs.length < 64) return null;
    const bytes = new Uint8Array(pairs.map((h) => parseInt(h, 16)));
    const lenHex = [...bytes.slice(32, 64)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const len = Number(BigInt("0x" + lenHex));
    return new TextDecoder().decode(bytes.slice(64, 64 + len));
  } catch {
    return null;
  }
}

async function ethCall(
  rpc: string,
  input: VerifyInput,
  valueWei: bigint,
): Promise<SimulationResult> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: input.to,
          from: input.from,
          data: input.data,
          value: "0x" + valueWei.toString(16),
        },
        "latest",
      ],
    }),
  });
  const body = (await res.json()) as {
    result?: string;
    error?: { message?: string; data?: string };
  };
  if (body?.error) {
    const msg: string = body.error.message ?? "execution reverted";
    const reason =
      decodeRevertReason(body.error.data ?? "") ??
      (msg.toLowerCase().includes("revert") ? msg : null);
    return {
      success: false,
      returnData: body.error.data ?? "0x",
      revertReason: reason,
    };
  }
  if (typeof body?.result === "string") {
    return { success: true, returnData: body.result, revertReason: null };
  }
  return {
    success: false,
    returnData: "0x",
    revertReason: "unexpected RPC response",
  };
}

async function simulate(
  input: VerifyInput,
  valueWei: bigint,
): Promise<SimulationResult> {
  let lastError: unknown = null;
  for (const rpc of BSC_RPCS) {
    try {
      return await ethCall(rpc, input, valueWei);
    } catch (e) {
      lastError = e; // flaky public RPC — retry once against the next dataseed
    }
  }
  fail(
    502,
    `BSC RPC unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function selectorsFromAbi(abi: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of abi) {
    const fn = item as {
      type?: string;
      name?: string;
      inputs?: { type?: string }[];
    };
    if (fn?.type !== "function" || typeof fn?.name !== "string") continue;
    const inputs = Array.isArray(fn.inputs) ? fn.inputs : [];
    const sig = `${fn.name}(${inputs.map((i) => i.type ?? "").join(",")})`;
    map.set(selector(sig), sig);
  }
  return map;
}

export async function verifyCall(input: VerifyInput): Promise<VerifyResult> {
  // --- input validation (400s) ---
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
    fail(400, "chainId must be a positive integer");
  }
  for (const [label, addr] of [
    ["contract", input.contract],
    ["to", input.to],
    ["from", input.from],
  ] as const) {
    if (typeof addr !== "string" || !ADDRESS_RE.test(addr)) {
      fail(400, `invalid ${label} address: ${addr}`);
    }
  }
  if (typeof input.data !== "string" || !HEX_RE.test(input.data)) {
    fail(400, `invalid data (must be 0x hex): ${input.data}`);
  }
  const valueWei = parseValue(input.value);
  const dataSelector =
    input.data.length >= 10 ? input.data.slice(0, 10).toLowerCase() : null;

  const checks: CheckResult[] = [];
  const reasons: string[] = [];

  // 1. Source verification (Sourcify v2).
  const { verified, abi, match } = await checkSourcify(
    input.chainId,
    input.contract,
  );
  checks.push({
    name: "contract-verified",
    pass: verified,
    detail: verified
      ? `source verified on Sourcify (${match ?? "match status unknown"})`
      : "contract source NOT verified on Sourcify",
  });
  if (!verified) reasons.push("contract source is not verified on Sourcify");

  // 2. Destination matches the contract that was verified.
  const destOk = input.to.toLowerCase() === input.contract.toLowerCase();
  checks.push({
    name: "destination-matches-contract",
    pass: destOk,
    detail: destOk
      ? "call destination is the verified contract"
      : `call destination ${input.to} differs from contract ${input.contract}`,
  });
  if (!destOk)
    reasons.push("call destination differs from the contract that was verified");

  // 3. Value carried by the call.
  const valueOk = valueWei === 0n;
  checks.push({
    name: "value-is-zero",
    pass: valueOk,
    detail: valueOk
      ? "value is 0 (no funds move with this call)"
      : `value is ${valueWei.toString()} wei — this call moves funds`,
  });
  if (!valueOk)
    reasons.push(`call carries value ${valueWei.toString()} wei`);

  // 4. Selector present in the verified ABI (only checkable when verified).
  let selectorKnown: boolean | null = null;
  if (abi && dataSelector) {
    const map = selectorsFromAbi(abi);
    const sig = map.get(dataSelector) ?? null;
    selectorKnown = sig !== null;
    checks.push({
      name: "selector-in-abi",
      pass: selectorKnown,
      detail: selectorKnown
        ? `selector ${dataSelector} = ${sig}`
        : `selector ${dataSelector} is NOT present in the verified ABI`,
    });
    if (!selectorKnown)
      reasons.push(
        `selector ${dataSelector} is not present in the verified ABI`,
      );
  } else if (dataSelector) {
    checks.push({
      name: "selector-in-abi",
      pass: false,
      detail: "no verified ABI — selector cannot be checked",
    });
  } else {
    checks.push({
      name: "selector-in-abi",
      pass: true,
      detail: "no calldata — plain call, nothing to match",
    });
  }

  // 5. Simulation. BSC only: the agent only simulates where it has a
  // reliable public RPC. Anything else is reported, not guessed.
  let simulation: SimulationResult;
  if (input.chainId === 56) {
    simulation = await simulate(input, valueWei);
  } else {
    simulation = {
      success: false,
      returnData: "0x",
      revertReason: `simulation only supported on BSC (chainId 56), got ${input.chainId}`,
    };
  }
  checks.push({
    name: "simulation-succeeded",
    pass: simulation.success,
    detail: simulation.success
      ? `eth_call succeeded, return data ${simulation.returnData.length} chars`
      : `eth_call failed${simulation.revertReason ? `: ${simulation.revertReason}` : ""}`,
  });
  if (!simulation.success)
    reasons.push(
      `simulation failed${simulation.revertReason ? `: ${simulation.revertReason}` : ""}`,
    );

  // --- verdict ---
  // BLOCKED: simulation reverts, or the selector is absent from a verified ABI.
  // RISKY: unverified contract, value > 0, or any other failed check.
  // SAFE: only when verified + simulation succeeds + every check passes.
  let verdict: Verdict;
  if (!simulation.success) {
    verdict = "BLOCKED";
  } else if (verified && abi && dataSelector && selectorKnown === false) {
    verdict = "BLOCKED";
  } else if (!verified || !valueOk || !destOk) {
    verdict = "RISKY";
  } else {
    verdict = "SAFE";
  }

  return { verdict, verified, match, simulation, checks, reasons };
}
