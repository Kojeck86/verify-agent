// keccak.ts — Minimal pure-TypeScript Keccak-256 (the hash Ethereum uses
// for function selectors). No dependencies. 64-bit lanes are BigInts;
// inputs here are short (function signatures), so performance is a non-issue.
//
// Keccak-256 is NOT SHA3-256: same permutation, different padding
// (suffix 0x01, pad10*1). Verified against known vectors in test/verify.test.ts.

const MASK64 = (1n << 64n) - 1n;

function rotl(x: bigint, n: number): bigint {
  if (n === 0) return x & MASK64;
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;
}

// Keccak-f[1600] round constants.
const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets ROT[x][y].
const ROT: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function keccakF1600(s: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // Theta
    const c: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    }
    const d: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d[x];
    }
    // Rho + Pi: B[y][2x+3y] = ROT(A[x][y], ROT[x][y])
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
      }
    }
    // Chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        s[x + 5 * y] =
          b[x + 5 * y] ^
          ((~b[(x + 1) % 5 + 5 * y] & MASK64) & b[(x + 2) % 5 + 5 * y]);
      }
    }
    // Iota
    s[0] ^= RC[round];
  }
}

/** Keccak-256 digest of `data` (rate 1088 bits, suffix 0x01, pad10*1). */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136; // bytes
  const state: bigint[] = new Array(25).fill(0n);
  const paddedLen = Math.floor(data.length / rate) * rate + rate;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[paddedLen - 1] |= 0x80;
  for (let off = 0; off < paddedLen; off += rate) {
    for (let i = 0; i < rate; i++) {
      const lane = (i / 8) | 0;
      state[lane] ^= BigInt(padded[off + i]) << BigInt((i % 8) * 8);
    }
    keccakF1600(state);
  }
  // Squeeze 32 bytes (lanes 0..3, little-endian).
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const lane = (i / 8) | 0;
    out[i] = Number((state[lane] >> BigInt((i % 8) * 8)) & 0xffn);
  }
  return out;
}

export function keccak256Hex(data: Uint8Array): string {
  return (
    "0x" +
    [...keccak256(data)].map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * 4-byte function selector, e.g. selector("transfer(address,uint256)")
 * === "0xa9059cbb".
 */
export function selector(signature: string): string {
  return keccak256Hex(new TextEncoder().encode(signature)).slice(0, 10);
}
