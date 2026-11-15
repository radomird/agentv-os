// The phone's own cryptography (companion-web/seal.ts), held against Node's
// on random inputs and against the RFCs' vectors. Each vector is also given
// to Node, so a vector copied wrong shows up as that, not as a bug.

import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt } from "node:crypto";
import { test } from "node:test";
import { chacha20, decode, encode, hex, hkdf, hmac, open, poly1305, seal, sha256, utf8, x25519, x25519Public } from "../../../companion-web/seal.ts";
import { x25519Pair, x25519Shared } from "../../../daemon/phone-channel.ts";

const un = (text: string) => Uint8Array.from(Buffer.from(text.replace(/\s/g, ""), "hex"));
const nodeSeal = (key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, extra: Uint8Array) => {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(extra, { plaintextLength: plain.length });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
};

test("base64url goes there and back at every length", () => {
  for (let length = 0; length < 70; length++) {
    const bytes = randomBytes(length);
    assert.equal(encode(bytes), bytes.toString("base64url"));
    assert.deepEqual(Buffer.from(decode(encode(bytes))!), bytes);
  }
  assert.equal(decode("a+b/"), null);
  assert.equal(decode("abcde"), null);
});

test("SHA-256 is Node's, at every length around a block's edge and for long messages", () => {
  for (const length of [...Array(200).keys(), 1000, 4096, 65_537]) {
    const message = randomBytes(length);
    assert.equal(hex(sha256(message)), createHash("sha256").update(message).digest("hex"), `${length} bytes`);
  }
  const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(createHash("sha256").update("abc").digest("hex"), abc);
  assert.equal(hex(sha256(utf8("abc"))), abc);
});

test("HMAC-SHA256 is Node's, with short and long keys, and gives RFC 4231's answers", () => {
  for (let i = 0; i < 200; i++) {
    const key = randomBytes(randomInt(0, 150));
    const message = randomBytes(randomInt(0, 300));
    assert.equal(hex(hmac(key, message)), createHmac("sha256", key).update(message).digest("hex"));
  }
  const cases = [
    { key: Buffer.alloc(20, 0x0b), data: Buffer.from("Hi There"), mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7" },
    { key: Buffer.from("Jefe"), data: Buffer.from("what do ya want for nothing?"), mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" },
  ];
  for (const { key, data, mac } of cases) {
    assert.equal(createHmac("sha256", key).update(data).digest("hex"), mac);
    assert.equal(hex(hmac(key, data)), mac);
  }
});

test("HKDF-SHA256 is Node's, at lengths under and over a block, and gives RFC 5869's first answer", () => {
  for (let i = 0; i < 100; i++) {
    const ikm = randomBytes(randomInt(1, 80));
    const salt = randomBytes(randomInt(0, 80));
    const info = randomBytes(randomInt(0, 80));
    const length = randomInt(1, 200);
    assert.equal(hex(hkdf(ikm, salt, info, length)), Buffer.from(hkdfSync("sha256", ikm, salt, info, length)).toString("hex"));
  }
  const ikm = Buffer.alloc(22, 0x0b);
  const salt = un("000102030405060708090a0b0c");
  const info = un("f0f1f2f3f4f5f6f7f8f9");
  const okm = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";
  assert.equal(Buffer.from(hkdfSync("sha256", ikm, salt, info, 42)).toString("hex"), okm);
  assert.equal(hex(hkdf(ikm, salt, info, 42)), okm);
});

test("X25519 agrees with Node on random keys, and gives RFC 7748's answers", () => {
  for (let i = 0; i < 25; i++) {
    const node = x25519Pair();
    const mine = randomBytes(32);
    assert.equal(hex(x25519Public(node.secret)), node.public.toString("hex"), "the public key of Node's private key");
    const shared = x25519Shared(node.secret, x25519Public(mine));
    assert.ok(shared);
    assert.equal(hex(x25519(mine, node.public)), shared.toString("hex"), "both sides come to the same");
  }
  // RFC 7748, 6.1.
  const alice = un("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const alicePublic = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
  const bob = un("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const bobPublic = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
  const shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
  assert.equal(x25519Shared(alice, un(bobPublic))?.toString("hex"), shared, "Node, on the RFC's keys");
  assert.equal(hex(x25519Public(alice)), alicePublic);
  assert.equal(hex(x25519Public(bob)), bobPublic);
  assert.equal(hex(x25519(alice, un(bobPublic))), shared);
  assert.equal(hex(x25519(bob, un(alicePublic))), shared);
  // RFC 7748, 5.2: the first vector, whose point has its top bit ignored.
  const scalar = un("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4");
  const point = un("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c");
  const out = "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552";
  assert.equal(x25519Shared(scalar, point)?.toString("hex"), out, "Node, on the RFC's vector");
  assert.equal(hex(x25519(scalar, point)), out);
});

test("X25519 gives all zeros for a point of small order, which the box refuses", () => {
  const mine = randomBytes(32);
  for (const point of [new Uint8Array(32), Uint8Array.from([1, ...new Uint8Array(31)])]) {
    assert.equal(hex(x25519(mine, point)), "00".repeat(32));
    assert.equal(x25519Shared(mine, point), null);
  }
});

test("ChaCha20-Poly1305 seals as Node does and opens what Node sealed, at every length around a block's edge", () => {
  for (const length of [...Array(140).keys(), 1000, 5000, 70_000]) {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const plain = randomBytes(length);
    const extra = randomBytes(randomInt(0, 40));
    const node = nodeSeal(key, nonce, plain, extra);
    assert.equal(hex(seal(key, nonce, plain, extra)), node.toString("hex"), `${length} bytes`);
    assert.deepEqual(Buffer.from(open(key, nonce, node, extra)!), plain);
  }
});

test("ChaCha20-Poly1305 gives RFC 8439's answers", () => {
  // 2.8.2, the AEAD's example.
  const key = un("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
  const nonce = un("070000004041424344454647");
  const extra = un("50515253c0c1c2c3c4c5c6c7");
  const plain = utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const tag = "1ae10b594f09e26a7e902ecbd0600691";
  const node = nodeSeal(key, nonce, plain, extra).toString("hex");
  assert.ok(node.startsWith("d31a8d34648e60db7b86afbc53ef7ec2") && node.endsWith(tag), "Node, on the RFC's example");
  assert.equal(hex(seal(key, nonce, plain, extra)), node);
  // 2.5.2, Poly1305's example.
  const polyKey = un("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
  assert.equal(hex(poly1305(polyKey, utf8("Cryptographic Forum Research Group"))), "a8061dc1305136c6c22b8baf0c0127a9");
  // 2.4.2, ChaCha20's example: the first bytes of the sunscreen text, from block 1.
  const chachaKey = un("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const sealed = hex(chacha20(chachaKey, un("000000000000004a00000000"), 1, utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.")));
  assert.ok(sealed.startsWith("6e2e359a2568f98041ba0728dd0d6981"));
});

test("a sealed text that changed anywhere doesn't open, nor with another key, nonce or extra data", () => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const extra = utf8("POST\n/api/phone/pin\n7");
  const plain = utf8('{"pin":"2468"}');
  const sealed = seal(key, nonce, plain, extra);
  assert.deepEqual(open(key, nonce, sealed, extra), plain);
  for (let i = 0; i < sealed.length; i++) {
    const changed = Uint8Array.from(sealed);
    changed[i] ^= 1;
    assert.equal(open(key, nonce, changed, extra), null, `byte ${i}`);
  }
  assert.equal(open(randomBytes(32), nonce, sealed, extra), null);
  assert.equal(open(key, randomBytes(12), sealed, extra), null);
  assert.equal(open(key, nonce, sealed, utf8("POST\n/api/phone/pin\n8")), null);
  assert.equal(open(key, nonce, sealed.subarray(0, 10), extra), null);
});
