// index.ts — Cloudflare Workers entrypoint for the Verify Agent.
//
// Read-only by design: this agent never holds keys, never signs, and
// never sends a transaction. It only reads public data (Sourcify + a
// public BSC RPC) and returns a verdict.
//
// Routes:
//   GET  /        — agent info + a worked example
//   GET  /health — liveness probe, {"ok": true}
//   POST /verify — verify one proposed call (see README for the schema)

import { verifyCall, type VerifyInput } from "./verify.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const INFO = {
  name: "verify-agent",
  description:
    "Read-only on-chain verification agent. Before you sign a transaction, it checks the target contract's source verification and simulates the call, then returns a SAFE / RISKY / BLOCKED verdict. It never holds keys, never signs, and never sends transactions.",
  version: "0.1.0",
  endpoints: {
    "GET /": "this info",
    "GET /health": 'liveness probe, returns {"ok": true}',
    "POST /verify":
      'verify a call. Body: {"chainId": 56, "contract": "0x...", "to": "0x...", "data": "0x...", "from": "0x...", "value": "0"}',
  },
  example: {
    request: {
      method: "POST",
      url: "/verify",
      body: {
        chainId: 56,
        contract: "0x1c759C4e075103b5B250DB5114B832b17B99C456",
        to: "0x1c759C4e075103b5B250DB5114B832b17B99C456",
        data: "0x06fdde03",
        from: "0x0000000000000000000000000000000000000000",
        value: "0",
      },
    },
    note: "name() on the CLAF Eye NFT — verified contract, read-only call, expected verdict SAFE.",
  },
};

const REQUIRED_FIELDS = ["chainId", "contract", "to", "data", "from", "value"];

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method === "GET" && url.pathname === "/") return json(INFO);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/verify") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const input = body as Partial<VerifyInput>;
      const missing = REQUIRED_FIELDS.filter(
        (k) => (input as Record<string, unknown>)[k] === undefined,
      );
      if (missing.length > 0) {
        return json({ error: `missing fields: ${missing.join(", ")}` }, 400);
      }
      try {
        const result = await verifyCall(input as VerifyInput);
        return json(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status =
          e instanceof Error && typeof (e as { status?: unknown }).status ===
            "number"
            ? ((e as unknown as { status: number }).status as number)
            : 500;
        return json({ error: message }, status);
      }
    }
    return json({ error: "not found" }, 404);
  },
};
