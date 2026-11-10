// The phone's own cryptography, in plain TypeScript: SHA-256, HMAC, HKDF,
// X25519 and ChaCha20-Poly1305. The page comes over plain HTTP, where a
// browser gives it no crypto.subtle, so these few are written out here. The
// box does the same with Node's own, and the tests hold each one against
// Node's and against the RFCs' vectors (RFC 6234, 4231, 5869, 7748, 8439).
//
// Random numbers still come from the browser (crypto.getRandomValues), which
// a plain HTTP page does have.
//
// The big-number parts (X25519, Poly1305) aren't constant time. The phone
// uses each X25519 key once, at pairing, and a Poly1305 key once per
// message, so there's little for a clock to learn.

export type Bytes = Uint8Array;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Bytes => encoder.encode(text);
export const text = (bytes: Bytes): string => decoder.decode(bytes);

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function hex(bytes: Bytes): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

// base64url with no padding, which is how keys, nonces and signatures go
// in JSON and in headers.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encode(bytes: Bytes): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[n >>> 18] + B64[(n >>> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >>> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

export function decode(value: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let at = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = B64.indexOf(value[i]);
    const b = B64.indexOf(value[i + 1]);
    const c = i + 2 < value.length ? B64.indexOf(value[i + 2]) : 0;
    const d = i + 3 < value.length ? B64.indexOf(value[i + 3]) : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[at++] = n >>> 16;
    if (i + 2 < value.length) out[at++] = (n >>> 8) & 255;
    if (i + 3 < value.length) out[at++] = n & 255;
  }
  return out;
}

export function random(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

// Whether two byte strings are the same, looking at every byte either way.
export function same(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- SHA-256 (RFC 6234) ---------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(message: Bytes): Bytes {
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  // The message, a 1 bit, zeros, and its length in bits, to a whole number
  // of 64-byte blocks.
  const padded = new Uint8Array((((message.length + 8) >> 6) + 1) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(message.length / 0x20000000));
  view.setUint32(padded.length - 4, (message.length << 3) >>> 0);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }
  const out = new Uint8Array(32);
  const result = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) result.setUint32(i * 4, state[i]);
  return out;
}

// --- HMAC-SHA256 (RFC 2104) and HKDF-SHA256 (RFC 5869) --------------------------

export function hmac(key: Bytes, message: Bytes): Bytes {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  return sha256(concat(outer, sha256(concat(inner, message))));
}

export function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Bytes {
  const prk = hmac(salt.length ? salt : new Uint8Array(32), ikm);
  const out = new Uint8Array(length);
  let last: Bytes = new Uint8Array(0);
  for (let at = 0, n = 1; at < length; at += 32, n++) {
    last = hmac(prk, concat(last, info, new Uint8Array([n])));
    out.set(last.subarray(0, Math.min(32, length - at)), at);
  }
  return out;
}

// --- X25519 (RFC 7748) ----------------------------------------------------------

const P = (1n << 255n) - 19n;
const A24 = 121665n;

const mod = (n: bigint): bigint => ((n % P) + P) % P;

function fromLittle(bytes: Bytes): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function toLittle(n: bigint, length: number): Bytes {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}

function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let square = mod(base);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * square) % P;
    square = (square * square) % P;
  }
  return result;
}

// The shared point of a 32-byte private key and a 32-byte public one.
export function x25519(scalar: Bytes, point: Bytes): Bytes {
  const clamped = Uint8Array.from(scalar);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  const k = fromLittle(clamped);
  const masked = Uint8Array.from(point);
  masked[31] &= 127;
  const x1 = mod(fromLittle(masked));
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  for (let t = 254n; t >= 0n; t--) {
    const bit = (k >> t) & 1n;
    if (swap ^ bit) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = bit;
    const a = mod(x2 + z2);
    const aa = (a * a) % P;
    const b = mod(x2 - z2);
    const bb = (b * b) % P;
    const e = mod(aa - bb);
    const c = mod(x3 + z3);
    const d = mod(x3 - z3);
    const da = (d * a) % P;
    const cb = (c * b) % P;
    x3 = mod(da + cb);
    x3 = (x3 * x3) % P;
    z3 = mod(da - cb);
    z3 = (x1 * ((z3 * z3) % P)) % P;
    x2 = (aa * bb) % P;
    z2 = (e * mod(aa + A24 * e)) % P;
  }
  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  return toLittle((x2 * power(z2, P - 2n)) % P, 32);
}

const BASE = new Uint8Array(32);
BASE[0] = 9;

// The public key of a private one.
export const x25519Public = (scalar: Bytes): Bytes => x25519(scalar, BASE);

// --- ChaCha20-Poly1305 (RFC 8439) -----------------------------------------------

const rotl = (n: number, by: number): number => (n << by) | (n >>> (32 - by));

function chachaBlock(key: DataView, counter: number, nonce: DataView, out: Uint8Array): void {
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.getUint32(i * 4, true);
  s[12] = counter;
  for (let i = 0; i < 3; i++) s[13 + i] = nonce.getUint32(i * 4, true);
  const x = Uint32Array.from(s);
  const quarter = (a: number, b: number, c: number, d: number) => {
    x[a] += x[b];
    x[d] = rotl(x[d] ^ x[a], 16);
    x[c] += x[d];
    x[b] = rotl(x[b] ^ x[c], 12);
    x[a] += x[b];
    x[d] = rotl(x[d] ^ x[a], 8);
    x[c] += x[d];
    x[b] = rotl(x[b] ^ x[c], 7);
  };
  for (let round = 0; round < 10; round++) {
    quarter(0, 4, 8, 12);
    quarter(1, 5, 9, 13);
    quarter(2, 6, 10, 14);
    quarter(3, 7, 11, 15);
    quarter(0, 5, 10, 15);
    quarter(1, 6, 11, 12);
    quarter(2, 7, 8, 13);
    quarter(3, 4, 9, 14);
  }
  const view = new DataView(out.buffer, out.byteOffset, 64);
  for (let i = 0; i < 16; i++) view.setUint32(i * 4, (x[i] + s[i]) >>> 0, true);
}

const view = (bytes: Bytes): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// The data with the key stream from block `counter` on over it. The same
// call turns it back.
export function chacha20(key: Bytes, nonce: Bytes, counter: number, data: Bytes): Bytes {
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(64);
  const k = view(key);
  const n = view(nonce);
  for (let at = 0; at < data.length; at += 64, counter++) {
    chachaBlock(k, counter, n, block);
    for (let i = 0; i < 64 && at + i < data.length; i++) out[at + i] = data[at + i] ^ block[i];
  }
  return out;
}

const P1305 = (1n << 130n) - 5n;

export function poly1305(key: Bytes, message: Bytes): Bytes {
  const r = fromLittle(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = fromLittle(key.subarray(16, 32));
  let acc = 0n;
  const whole = message.length - (message.length % 16);
  if (whole) {
    const blocks = new DataView(message.buffer, message.byteOffset, whole);
    for (let at = 0; at < whole; at += 16) {
      const n = blocks.getBigUint64(at, true) | (blocks.getBigUint64(at + 8, true) << 64n) | (1n << 128n);
      acc = ((acc + n) * r) % P1305;
    }
  }
  if (whole < message.length) {
    const rest = message.subarray(whole);
    acc = ((acc + (fromLittle(rest) | (1n << BigInt(rest.length * 8)))) * r) % P1305;
  }
  return toLittle((acc + s) & ((1n << 128n) - 1n), 16);
}

// What Poly1305 signs for the AEAD: the extra data and the sealed text, each
// padded to 16 bytes, then both lengths.
function tagOf(key: Bytes, nonce: Bytes, sealed: Bytes, extra: Bytes): Bytes {
  const pad = (length: number) => new Uint8Array((16 - (length % 16)) % 16);
  const lengths = new Uint8Array(16);
  const lengthsView = new DataView(lengths.buffer);
  lengthsView.setBigUint64(0, BigInt(extra.length), true);
  lengthsView.setBigUint64(8, BigInt(sealed.length), true);
  const once = chacha20(key, nonce, 0, new Uint8Array(32));
  return poly1305(once, concat(extra, pad(extra.length), sealed, pad(sealed.length), lengths));
}

// The text sealed under a 32-byte key and a 12-byte nonce, with its 16-byte
// tag after it. The extra data isn't hidden, but the tag covers it too.
export function seal(key: Bytes, nonce: Bytes, plain: Bytes, extra: Bytes): Bytes {
  const sealed = chacha20(key, nonce, 1, plain);
  return concat(sealed, tagOf(key, nonce, sealed, extra));
}

// The text back, or null when the tag doesn't fit: a wrong key, or anything
// changed on the way.
export function open(key: Bytes, nonce: Bytes, sealed: Bytes, extra: Bytes): Bytes | null {
  if (sealed.length < 16) return null;
  const body = sealed.subarray(0, sealed.length - 16);
  if (!same(tagOf(key, nonce, body, extra), sealed.subarray(sealed.length - 16))) return null;
  return chacha20(key, nonce, 1, body);
}
