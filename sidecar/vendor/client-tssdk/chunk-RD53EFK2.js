import {
  sm2_exports,
  sm32,
  sm4_exports
} from "./chunk-SEZTAX2J.js";

// src/crypto_utils.ts
var SYM_GCM_NONCE_LEN = 12;
var SYM_GCM_TAG_LEN = 16;
var MIN_ENCRYPTED_BLOB_LEN = SYM_GCM_NONCE_LEN + SYM_GCM_TAG_LEN + 1;
var BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var SM2_UNCOMPRESSED_PUBLIC_KEY_LEN = 65;
var BIGINT_ZERO = BigInt(0);
var BIGINT_ONE = BigInt(1);
var BIGINT_BYTE_SHIFT = BigInt(8);
var SM2_CURVE_ORDER = BigInt(
  "115792089210356248756420345214020892766061623724957744567843809356293439045923"
);
var DEK_WRAP_HKDF_SALT_LEN = 32;
var DEK_WRAP_SESSION_KEY_LEN = 32;
var fallbackRequestIdCounter = 0;
function createFallbackRequestId() {
  fallbackRequestIdCounter += 1;
  return `req_${Date.now().toString(36)}_${fallbackRequestIdCounter.toString(36)}`;
}
function defaultUtf8Encode(value) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value);
  }
  const encodedValue = encodeURIComponent(value);
  const bytes = [];
  for (let index = 0; index < encodedValue.length; index += 1) {
    const char = encodedValue[index];
    if (char === "%") {
      bytes.push(Number.parseInt(encodedValue.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(char.charCodeAt(0));
  }
  return new Uint8Array(bytes);
}
function defaultUtf8Decode(value) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(value);
  }
  const encodedValue = Array.from(
    value,
    (byte) => `%${byte.toString(16).padStart(2, "0")}`
  ).join("");
  return decodeURIComponent(encodedValue);
}
function normalizeRuntimeBytes(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}
function decodeBase64Char(value, allowPadding = false) {
  if (allowPadding && value === "=") {
    return -1;
  }
  const index = BASE64_ALPHABET.indexOf(value ?? "");
  if (index < 0) {
    throw new Error("invalid base64");
  }
  return index;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((item) => item.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const normalizedHex = hex.trim().toLowerCase();
  if (!normalizedHex || normalizedHex.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(normalizedHex.length / 2);
  for (let index = 0; index < normalizedHex.length; index += 2) {
    const value = Number.parseInt(normalizedHex.slice(index, index + 2), 16);
    if (Number.isNaN(value)) {
      throw new Error("invalid hex");
    }
    out[index / 2] = value;
  }
  return out;
}
function isHexString(value) {
  const normalizedValue = value.trim();
  return normalizedValue.length > 0 && normalizedValue.length % 2 === 0 && /^[0-9a-f]+$/i.test(normalizedValue);
}
function utf8Encode(value, runtime) {
  return runtime?.utf8Encode ? runtime.utf8Encode(value) : defaultUtf8Encode(value);
}
function utf8Decode(value, runtime) {
  return runtime?.utf8Decode ? runtime.utf8Decode(value) : defaultUtf8Decode(value);
}
function concatBytes(...chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function sm3DigestBytes(data) {
  return hexToBytes(sm32(data));
}
function hmacSm3(key, data) {
  const blockSize = 64;
  const normalizedKey = key.length > blockSize ? sm3DigestBytes(key) : new Uint8Array(key);
  const paddedKey = new Uint8Array(blockSize);
  const outerPad = new Uint8Array(blockSize);
  const innerPad = new Uint8Array(blockSize);
  paddedKey.set(normalizedKey);
  for (let index = 0; index < blockSize; index += 1) {
    outerPad[index] = paddedKey[index] ^ 92;
    innerPad[index] = paddedKey[index] ^ 54;
  }
  return sm3DigestBytes(
    concatBytes(outerPad, sm3DigestBytes(concatBytes(innerPad, data)))
  );
}
function hkdfSm3(ikm, salt, info, length) {
  const normalizedSalt = salt.length > 0 ? salt : new Uint8Array(DEK_WRAP_HKDF_SALT_LEN);
  const prk = hmacSm3(normalizedSalt, ikm);
  const blocks = [];
  let previous = new Uint8Array();
  let outputLength = 0;
  let counter = 1;
  while (outputLength < length) {
    previous = new Uint8Array(
      hmacSm3(prk, concatBytes(previous, info, new Uint8Array([counter])))
    );
    blocks.push(previous);
    outputLength += previous.length;
    counter += 1;
  }
  return new Uint8Array(concatBytes(...blocks).slice(0, length));
}
function readDerTlv(bytes, offset) {
  const start = offset;
  const tag = bytes[offset];
  if (tag === void 0) {
    throw new Error("invalid DER");
  }
  offset += 1;
  let length = bytes[offset];
  if (length === void 0) {
    throw new Error("invalid DER");
  }
  offset += 1;
  if (length & 128) {
    const lengthByteCount = length & 127;
    if (lengthByteCount === 0 || lengthByteCount > 4) {
      throw new Error("invalid DER length");
    }
    length = 0;
    for (let index = 0; index < lengthByteCount; index += 1) {
      const next = bytes[offset + index];
      if (next === void 0) {
        throw new Error("invalid DER length");
      }
      length = length << 8 | next;
    }
    offset += lengthByteCount;
  }
  const end = offset + length;
  if (end > bytes.length) {
    throw new Error("invalid DER length");
  }
  return {
    tag,
    valueOffset: offset,
    end,
    raw: bytes.slice(start, end)
  };
}
function extractCertificateTbsDer(certificateDer) {
  const certificate = readDerTlv(certificateDer, 0);
  if (certificate.tag !== 48 || certificate.end !== certificateDer.length) {
    throw new Error("invalid X.509 certificate DER");
  }
  const tbsCertificate = readDerTlv(certificateDer, certificate.valueOffset);
  if (tbsCertificate.tag !== 48) {
    throw new Error("invalid X.509 certificate TBS");
  }
  return tbsCertificate.raw;
}
function extractSubjectPublicKeyBytesFromSpkiDer(spkiDer) {
  const spki = readDerTlv(spkiDer, 0);
  if (spki.tag !== 48 || spki.end !== spkiDer.length) {
    throw new Error("invalid SPKI DER");
  }
  const algorithm = readDerTlv(spkiDer, spki.valueOffset);
  const subjectPublicKey = readDerTlv(spkiDer, algorithm.end);
  if (subjectPublicKey.tag !== 3) {
    throw new Error("invalid SPKI public key");
  }
  const unusedBitCount = spkiDer[subjectPublicKey.valueOffset];
  if (unusedBitCount !== 0) {
    throw new Error("invalid SPKI public key bit string");
  }
  return spkiDer.slice(subjectPublicKey.valueOffset + 1, subjectPublicKey.end);
}
function createRandomBytes(length) {
  const out = new Uint8Array(length);
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.getRandomValues) {
    throw new Error("crypto.getRandomValues is unavailable");
  }
  cryptoObject.getRandomValues(out);
  return out;
}
async function createRandomBytesAsync(length, runtime) {
  if (!runtime?.randomBytes) {
    return createRandomBytes(length);
  }
  return normalizeRuntimeBytes(await runtime.randomBytes(length));
}
function createRequestId() {
  try {
    return `req_${bytesToHex(createRandomBytes(16))}`;
  } catch {
    return createFallbackRequestId();
  }
}
async function createRequestIdAsync(runtime) {
  return `req_${bytesToHex(await createRandomBytesAsync(16, runtime))}`;
}
function createEncryptionKeyId() {
  return `env_${bytesToHex(createRandomBytes(12))}`;
}
async function createEncryptionKeyIdAsync(runtime) {
  return `env_${bytesToHex(await createRandomBytesAsync(12, runtime))}`;
}
function generateDekHex() {
  return bytesToHex(createRandomBytes(32));
}
async function generateDekHexAsync(runtime) {
  return bytesToHex(await createRandomBytesAsync(32, runtime));
}
async function encryptBytesToBlob(value, keyBytes, runtime) {
  const nonce = await createRandomBytesAsync(SYM_GCM_NONCE_LEN, runtime);
  const result = sm4_exports.encrypt(value, keyBytes.slice(0, 16), {
    mode: "gcm",
    iv: nonce,
    output: "array",
    outputTag: true
  });
  const tag = result.tag;
  if (!tag || tag.length !== SYM_GCM_TAG_LEN) {
    throw new Error("SM4-GCM tag missing");
  }
  const blob = new Uint8Array(
    nonce.length + result.output.length + tag.length
  );
  blob.set(nonce, 0);
  blob.set(result.output, nonce.length);
  blob.set(tag, nonce.length + result.output.length);
  return blob;
}
function assertDekBytes(dekHex) {
  const dek = hexToBytes(dekHex);
  if (dek.length !== 32) {
    throw new Error("invalid DEK length");
  }
  return dek;
}
async function decryptBytesFromBlob(blob, dekHex) {
  const dek = assertDekBytes(dekHex);
  if (blob.length <= SYM_GCM_NONCE_LEN + SYM_GCM_TAG_LEN) {
    throw new Error("blob too short");
  }
  const nonce = blob.slice(0, SYM_GCM_NONCE_LEN);
  const ciphertextWithTag = blob.slice(SYM_GCM_NONCE_LEN);
  const tagStart = ciphertextWithTag.length - SYM_GCM_TAG_LEN;
  const ciphertext = ciphertextWithTag.slice(0, tagStart);
  const tag = ciphertextWithTag.slice(tagStart);
  const plaintext = sm4_exports.decrypt(ciphertext, dek.slice(0, 16), {
    mode: "gcm",
    iv: nonce,
    tag,
    output: "array"
  });
  return new Uint8Array(plaintext);
}
async function encryptBytesToBlobHex(value, dekHex, runtime) {
  const dek = assertDekBytes(dekHex);
  return bytesToHex(await encryptBytesToBlob(value, dek, runtime));
}
async function decryptBytesFromBlobHex(blobHex, dekHex) {
  return decryptBytesFromBlob(hexToBytes(blobHex), dekHex);
}
async function encryptTextToBlobHex(value, dekHex, runtime) {
  return encryptBytesToBlobHex(utf8Encode(value, runtime), dekHex, runtime);
}
async function decryptTextFromBlobHex(blobHex, dekHex, runtime) {
  return utf8Decode(await decryptBytesFromBlobHex(blobHex, dekHex), runtime);
}
function bytesToBase64(bytes, runtime) {
  if (runtime?.bytesToBase64) {
    return runtime.bytesToBase64(bytes);
  }
  if (typeof btoa !== "undefined") {
    let binary = "";
    const chunkSize = 32768;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = first << 16 | (second ?? 0) << 8 | (third ?? 0);
    output += BASE64_ALPHABET[chunk >> 18 & 63];
    output += BASE64_ALPHABET[chunk >> 12 & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[chunk >> 6 & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[chunk & 63] : "=";
  }
  return output;
}
function isBase64String(value) {
  const normalizedValue = value.trim().replace(/\s+/g, "");
  return normalizedValue.length > 0 && normalizedValue.length % 4 === 0 && BASE64_PATTERN.test(normalizedValue);
}
function isEncryptedBlobString(value, runtime) {
  const normalizedValue = value.trim();
  if (isHexString(normalizedValue)) {
    return normalizedValue.length / 2 >= MIN_ENCRYPTED_BLOB_LEN;
  }
  if (!isBase64String(normalizedValue)) {
    return false;
  }
  try {
    return base64ToBytes(normalizedValue, runtime).length >= MIN_ENCRYPTED_BLOB_LEN;
  } catch {
    return false;
  }
}
async function encryptBytesToBlobBase64(value, dekHex, runtime) {
  const dek = assertDekBytes(dekHex);
  return bytesToBase64(await encryptBytesToBlob(value, dek, runtime), runtime);
}
async function decryptBytesFromBlobBase64(blobBase64, dekHex, runtime) {
  return decryptBytesFromBlob(base64ToBytes(blobBase64, runtime), dekHex);
}
async function decryptBytesFromBlobEncoded(blobText, dekHex, runtime) {
  let base64Error = null;
  try {
    return await decryptBytesFromBlobBase64(blobText, dekHex, runtime);
  } catch (error) {
    base64Error = error;
  }
  if (isHexString(blobText)) {
    return decryptBytesFromBlobHex(blobText, dekHex);
  }
  throw base64Error;
}
async function encryptTextToBlobBase64(value, dekHex, runtime) {
  return encryptBytesToBlobBase64(utf8Encode(value, runtime), dekHex, runtime);
}
async function decryptTextFromBlobEncoded(blobText, dekHex, runtime) {
  return utf8Decode(await decryptBytesFromBlobEncoded(blobText, dekHex, runtime), runtime);
}
var FAKE_CIPHER_PREFIX = "fake-ts-sdk.v1.";
function encodeBase64Url(value) {
  return bytesToBase64(utf8Encode(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decodeBase64Url(value) {
  const normalizedValue = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddedValue = normalizedValue + "=".repeat((4 - (normalizedValue.length % 4 || 4)) % 4);
  return utf8Decode(base64ToBytes(paddedValue));
}
function createFakeCipherEnvelope(input) {
  return `${FAKE_CIPHER_PREFIX}${encodeBase64Url(
    JSON.stringify({
      v: 1,
      kind: input.kind,
      encryption_key_id: input.encryptionKeyId,
      nonce: input.requestId ?? createRequestId(),
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      plain_text: input.plainText,
      file_name: input.fileName,
      file_type: input.fileType,
      file_size: input.fileSize,
      file_base64: input.fileBase64,
      request_id: input.requestId
    })
  )}`;
}
function isFakeCipherPayload(value) {
  return value.trim().startsWith(FAKE_CIPHER_PREFIX);
}
function encodeFakeTextCipher(input) {
  return createFakeCipherEnvelope({
    encryptionKeyId: input.encryptionKeyId,
    kind: "text",
    plainText: input.text,
    requestId: input.requestId
  });
}
function encodeFakeBytesCipher(input) {
  return createFakeCipherEnvelope({
    encryptionKeyId: input.encryptionKeyId,
    kind: "file",
    fileName: input.fileName,
    fileType: input.fileType,
    fileSize: input.bytes.byteLength,
    fileBase64: bytesToBase64(input.bytes),
    requestId: input.requestId
  });
}
function decodeFakeCipherEnvelope(cipher) {
  if (!isFakeCipherPayload(cipher)) {
    return null;
  }
  try {
    const envelope = JSON.parse(
      decodeBase64Url(cipher.trim().slice(FAKE_CIPHER_PREFIX.length))
    );
    return envelope.v === 1 ? envelope : null;
  } catch {
    return null;
  }
}
function decodeFakeTextCipher(cipher) {
  const envelope = decodeFakeCipherEnvelope(cipher);
  if (!envelope || envelope.kind !== "text") {
    throw new Error("invalid fake text cipher");
  }
  return envelope.plain_text ?? "";
}
function decodeFakeBytesCipher(cipher) {
  const envelope = decodeFakeCipherEnvelope(cipher);
  if (!envelope || envelope.kind !== "file" || !envelope.file_base64) {
    throw new Error("invalid fake file cipher");
  }
  return base64ToBytes(envelope.file_base64);
}
function base64ToBytes(value, runtime) {
  if (runtime?.base64ToBytes) {
    return runtime.base64ToBytes(value);
  }
  const normalizedValue = value.trim().replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (typeof atob !== "undefined") {
    let binary;
    try {
      binary = atob(normalizedValue);
    } catch {
      throw new Error("invalid base64");
    }
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      out[index] = binary.charCodeAt(index);
    }
    return out;
  }
  const output = [];
  if (normalizedValue.length % 4 !== 0) {
    throw new Error("invalid base64");
  }
  for (let index = 0; index < normalizedValue.length; index += 4) {
    const first = decodeBase64Char(normalizedValue[index]);
    const second = decodeBase64Char(normalizedValue[index + 1]);
    const third = decodeBase64Char(normalizedValue[index + 2], true);
    const fourth = decodeBase64Char(normalizedValue[index + 3], true);
    if (third < 0 && fourth >= 0 || index + 4 < normalizedValue.length && (third < 0 || fourth < 0)) {
      throw new Error("invalid base64");
    }
    const chunk = first << 18 | second << 12 | (third < 0 ? 0 : third) << 6 | (fourth < 0 ? 0 : fourth);
    output.push(chunk >> 16 & 255);
    if (third >= 0) {
      output.push(chunk >> 8 & 255);
    }
    if (fourth >= 0) {
      output.push(chunk & 255);
    }
  }
  return new Uint8Array(output);
}
async function normalizeBytesInput(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return new Uint8Array(await input.arrayBuffer());
}
async function normalizeFileToBytes(input) {
  if (typeof input === "string") {
    return base64ToBytes(input);
  }
  return normalizeBytesInput(input);
}
function normalizeSm2PublicKeyHex(publicKeyHex) {
  const normalizedHex = publicKeyHex.trim().toLowerCase();
  if (normalizedHex.length === 128 && isHexString(normalizedHex)) {
    return `04${normalizedHex}`;
  }
  if (normalizedHex.length === 130 && normalizedHex.startsWith("04") && isHexString(normalizedHex)) {
    return normalizedHex;
  }
  throw new Error("invalid SM2 public key");
}
function normalizeSm2PublicKeyBytes(publicKeyBytes) {
  return normalizeSm2PublicKeyHex(bytesToHex(publicKeyBytes));
}
function deriveDekWrapSessionKey(ephemeralPublicKey, sharedPoint) {
  return hkdfSm3(
    concatBytes(ephemeralPublicKey, sharedPoint),
    new Uint8Array(DEK_WRAP_HKDF_SALT_LEN),
    new Uint8Array(),
    DEK_WRAP_SESSION_KEY_LEN
  );
}
function bytesToBigInt(bytes) {
  let value = BIGINT_ZERO;
  for (const byte of bytes) {
    value = value << BIGINT_BYTE_SHIFT | BigInt(byte);
  }
  return value;
}
function sm2PrivateKeyHexFromSeed(seed) {
  const privateKey = bytesToBigInt(seed) % (SM2_CURVE_ORDER - BIGINT_ONE) + BIGINT_ONE;
  return privateKey.toString(16).padStart(64, "0");
}
async function generateEphemeralSm2KeyPair(runtime) {
  const privateKey = sm2PrivateKeyHexFromSeed(
    await createRandomBytesAsync(40, runtime)
  );
  const publicKey = sm2_exports.getPublicKeyFromPrivateKey(privateKey);
  return {
    privateKey,
    publicKey
  };
}
async function encryptDekWithSm2EcdhWrap(dek, receiverPublicKeyHex, runtime) {
  const ephemeralKeyPair = await generateEphemeralSm2KeyPair(runtime);
  const ephemeralPublicKey = hexToBytes(
    normalizeSm2PublicKeyHex(ephemeralKeyPair.publicKey)
  );
  const sharedPoint = new Uint8Array(
    sm2_exports.ecdh(ephemeralKeyPair.privateKey, receiverPublicKeyHex, false)
  );
  const sessionKey = deriveDekWrapSessionKey(ephemeralPublicKey, sharedPoint);
  const nonce = await createRandomBytesAsync(SYM_GCM_NONCE_LEN, runtime);
  const result = sm4_exports.encrypt(dek, sessionKey.slice(0, 16), {
    mode: "gcm",
    iv: nonce,
    output: "array",
    outputTag: true
  });
  const tag = result.tag;
  if (ephemeralPublicKey.length !== SM2_UNCOMPRESSED_PUBLIC_KEY_LEN || !tag || tag.length !== SYM_GCM_TAG_LEN) {
    throw new Error("SM2 ECDH DEK wrap failed");
  }
  return concatBytes(ephemeralPublicKey, nonce, tag, result.output);
}
async function encryptDekWithPublicKeyHex(dekHex, publicKeyHex, runtime) {
  return bytesToHex(
    await encryptDekWithPublicKeyBytes(dekHex, hexToBytes(publicKeyHex), runtime)
  );
}
async function encryptDekWithPublicKeyBase64(dekHex, publicKeyBase64, runtime) {
  return bytesToBase64(
    await encryptDekWithPublicKeyBytes(
      dekHex,
      base64ToBytes(publicKeyBase64, runtime),
      runtime
    ),
    runtime
  );
}
async function encryptDekWithPublicKeyBytes(dekHex, publicKeyBytes, runtime) {
  const dek = assertDekBytes(dekHex);
  const publicKeyHex = normalizeSm2PublicKeyBytes(publicKeyBytes);
  return encryptDekWithSm2EcdhWrap(dek, publicKeyHex, runtime);
}

export {
  bytesToHex,
  hexToBytes,
  isHexString,
  utf8Encode,
  utf8Decode,
  extractCertificateTbsDer,
  extractSubjectPublicKeyBytesFromSpkiDer,
  createRandomBytes,
  createRandomBytesAsync,
  createRequestId,
  createRequestIdAsync,
  createEncryptionKeyId,
  createEncryptionKeyIdAsync,
  generateDekHex,
  generateDekHexAsync,
  encryptBytesToBlobHex,
  decryptBytesFromBlobHex,
  encryptTextToBlobHex,
  decryptTextFromBlobHex,
  bytesToBase64,
  isBase64String,
  isEncryptedBlobString,
  encryptBytesToBlobBase64,
  decryptBytesFromBlobBase64,
  decryptBytesFromBlobEncoded,
  encryptTextToBlobBase64,
  decryptTextFromBlobEncoded,
  FAKE_CIPHER_PREFIX,
  isFakeCipherPayload,
  encodeFakeTextCipher,
  encodeFakeBytesCipher,
  decodeFakeCipherEnvelope,
  decodeFakeTextCipher,
  decodeFakeBytesCipher,
  base64ToBytes,
  normalizeBytesInput,
  normalizeFileToBytes,
  normalizeSm2PublicKeyHex,
  normalizeSm2PublicKeyBytes,
  encryptDekWithPublicKeyHex,
  encryptDekWithPublicKeyBase64
};
//# sourceMappingURL=chunk-RD53EFK2.js.map
