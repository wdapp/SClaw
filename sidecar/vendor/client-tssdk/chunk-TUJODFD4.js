// src/certificate_cache.ts
var CPU_TEE_CERTIFICATE_CACHE_TTL_MS = 60 * 60 * 1e3;
var CPU_TEE_CERTIFICATE_CACHE_VERSION = 3;
var CPU_TEE_CERTIFICATE_CACHE_KEY_PREFIX = "client_tssdk.cpu-tee-certificate.v3.";
function getStorage(adapterStorage) {
  if (adapterStorage) {
    return adapterStorage;
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    const globalStorage = globalThis.localStorage;
    return globalStorage || null;
  } catch {
    return null;
  }
}
function normalizeCertificateUrl(certificateUrl) {
  return certificateUrl.trim();
}
function getCacheKey(certificateUrl) {
  return `${CPU_TEE_CERTIFICATE_CACHE_KEY_PREFIX}${encodeURIComponent(
    normalizeCertificateUrl(certificateUrl)
  )}`;
}
function isRecord(value) {
  return Boolean(value && typeof value === "object");
}
function readCpuTeeCertificatePayload(certificateUrl, nowMs = Date.now(), storageAdapter) {
  const normalizedUrl = normalizeCertificateUrl(certificateUrl);
  if (!normalizedUrl) {
    return null;
  }
  const storage = getStorage(storageAdapter);
  if (!storage) {
    return null;
  }
  const cacheKey = getCacheKey(normalizedUrl);
  const rawValue = storage.getItem(cacheKey);
  if (!rawValue?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!isRecord(parsed) || parsed.version !== CPU_TEE_CERTIFICATE_CACHE_VERSION || parsed.certificateUrl !== normalizedUrl || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= nowMs || !("payload" in parsed)) {
      storage.removeItem(cacheKey);
      return null;
    }
    return parsed.payload ?? null;
  } catch {
    storage.removeItem(cacheKey);
    return null;
  }
}
function writeCpuTeeCertificatePayload(certificateUrl, payload, nowMs = Date.now(), storageAdapter) {
  const normalizedUrl = normalizeCertificateUrl(certificateUrl);
  if (!normalizedUrl || payload === void 0) {
    return;
  }
  const storage = getStorage(storageAdapter);
  if (!storage) {
    return;
  }
  const record = {
    version: CPU_TEE_CERTIFICATE_CACHE_VERSION,
    certificateUrl: normalizedUrl,
    cachedAt: nowMs,
    expiresAt: nowMs + CPU_TEE_CERTIFICATE_CACHE_TTL_MS,
    payload
  };
  storage.setItem(getCacheKey(normalizedUrl), JSON.stringify(record));
}
function clearCpuTeeCertificatePayload(certificateUrl, storageAdapter) {
  const normalizedUrl = normalizeCertificateUrl(certificateUrl);
  if (!normalizedUrl) {
    return;
  }
  const storage = getStorage(storageAdapter);
  if (!storage) {
    return;
  }
  storage.removeItem(getCacheKey(normalizedUrl));
}

export {
  CPU_TEE_CERTIFICATE_CACHE_TTL_MS,
  readCpuTeeCertificatePayload,
  writeCpuTeeCertificatePayload,
  clearCpuTeeCertificatePayload
};
//# sourceMappingURL=chunk-TUJODFD4.js.map
