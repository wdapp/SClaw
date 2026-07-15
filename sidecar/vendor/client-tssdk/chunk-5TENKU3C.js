// src/adapters/browser.ts
function getBrowserStorage() {
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
function createMemoryStorage() {
  const entries = /* @__PURE__ */ new Map();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    }
  };
}
function createStorageAdapter() {
  const fallbackStorage = createMemoryStorage();
  return {
    getItem: (key) => getBrowserStorage()?.getItem(key) ?? fallbackStorage.getItem(key),
    setItem: (key, value) => {
      const storage = getBrowserStorage();
      if (storage) {
        storage.setItem(key, value);
        return;
      }
      fallbackStorage.setItem(key, value);
    },
    removeItem: (key) => {
      const storage = getBrowserStorage();
      if (storage) {
        storage.removeItem(key);
        return;
      }
      fallbackStorage.removeItem(key);
    }
  };
}
function headersToRecord(headers) {
  const result = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
function createHttpResponse(response) {
  return {
    ok: response.ok,
    status: response.status,
    headers: headersToRecord(response.headers),
    body: response.body,
    text: () => response.text(),
    json: () => response.json()
  };
}
function normalizeBody(body) {
  if (body === void 0 || typeof body === "string" || body instanceof ArrayBuffer) {
    return body;
  }
  return new Uint8Array(body).buffer;
}
function normalizeUploadBody(input) {
  if (typeof Blob !== "undefined" && input.file instanceof Blob) {
    return input.file;
  }
  if (typeof FormData !== "undefined" && input.file instanceof FormData) {
    return input.file;
  }
  return void 0;
}
function createBrowserAdapter() {
  const storage = createStorageAdapter();
  return {
    platform: "browser",
    storage,
    runtime: {
      now: () => Date.now(),
      randomBytes: (length) => {
        const bytes = new Uint8Array(length);
        const crypto = globalThis.crypto;
        if (!crypto?.getRandomValues) {
          throw new Error("crypto.getRandomValues is unavailable");
        }
        crypto.getRandomValues(bytes);
        return bytes;
      },
      randomUUID: () => globalThis.crypto?.randomUUID?.() ?? "",
      utf8Encode: (value) => new TextEncoder().encode(value),
      utf8Decode: (value) => new TextDecoder().decode(value),
      bytesToBase64: (bytes) => {
        let binary = "";
        bytes.forEach((byte) => {
          binary += String.fromCharCode(byte);
        });
        return btoa(binary);
      },
      base64ToBytes: (value) => {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      },
      getCurrentPath: () => typeof window === "undefined" ? "" : window.location.pathname || "/",
      getLaunchQuery: () => {
        if (typeof window === "undefined" || !window.location.search) {
          return {};
        }
        return Object.fromEntries(new URLSearchParams(window.location.search));
      }
    },
    http: {
      request: async (input) => {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: normalizeBody(input.body),
          signal: input.signal
        });
        return createHttpResponse(response);
      }
    },
    stream: {
      supportsStream: () => typeof ReadableStream !== "undefined" && typeof Response !== "undefined" && typeof new Response("").body?.getReader === "function"
    },
    upload: {
      upload: async (input) => {
        const response = await fetch(input.url, {
          method: "POST",
          headers: input.headers,
          body: normalizeUploadBody(input)
        });
        return createHttpResponse(response);
      }
    },
    channel: {
      getCaptureInput: () => ({
        path: typeof window === "undefined" ? "" : window.location.pathname || "/",
        query: typeof window === "undefined" ? {} : Object.fromEntries(new URLSearchParams(window.location.search)),
        referrerInfo: typeof document === "undefined" ? "" : document.referrer
      })
    },
    createAbortController: () => new AbortController()
  };
}

export {
  createBrowserAdapter
};
//# sourceMappingURL=chunk-5TENKU3C.js.map
