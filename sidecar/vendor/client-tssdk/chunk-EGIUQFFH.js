import {
  createBrowserAdapter
} from "./chunk-5TENKU3C.js";
import {
  sm32
} from "./chunk-SEZTAX2J.js";

// src/analytics.ts
var DEFAULT_ANALYTICS_API_BASE_URL = "https://api.jinghua.security";
var ANALYTICS_EVENTS_PATH = "/api/analytics/events";
var ANALYTICS_QUEUE_STORAGE_KEY = "jh_analytics_queue_v1";
var ANALYTICS_ANONYMOUS_ID_STORAGE_KEY = "jh_analytics_anonymous_id";
var ANALYTICS_SESSION_ID_STORAGE_KEY = "jh_analytics_session_id";
var ANALYTICS_INDEXED_DB_NAME = "jh_analytics";
var ANALYTICS_INDEXED_DB_STORE = "queue";
var ANALYTICS_INDEXED_DB_KEY = "events";
var EVENT_NAME_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
var PROPERTY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
var ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
var CUSTOM_NAME_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
var DEFAULT_FLUSH_INTERVAL_MS = 5e3;
var DEFAULT_MAX_BATCH_SIZE = 50;
var DEFAULT_MAX_QUEUE_SIZE = 1e3;
var DEFAULT_MAX_EVENT_BYTES = 4096;
var DEFAULT_MAX_BATCH_BYTES = 128 * 1024;
var DEFAULT_RETRY_BASE_DELAY_MS = 5e3;
var DEFAULT_RETRY_MAX_DELAY_MS = 3e5;
var ANALYTICS_EVENT_TTL_MS = 72 * 60 * 60 * 1e3;
var MAX_FUTURE_SKEW_MS = 5 * 60 * 1e3;
var STRING_VALUE_MAX_LENGTH = 256;
var ROUTE_PATH_MAX_LENGTH = 1024;
var MODEL_MAX_LENGTH = 128;
var ERROR_CODE_MAX_LENGTH = 128;
var CUSTOM_REMARK_MAX_LENGTH = 120;
var CUSTOM_SOURCE_MAX_LENGTH = 32;
var SANITIZE_MAX_DEPTH = 3;
var FORBIDDEN_KEYS = new Set(
  [
    "prompt",
    "content",
    "answer",
    "reasoning",
    "fileName",
    "fileContent",
    "encrypted_user_data",
    "encrypted_file_bytes",
    "encrypted_dek",
    "accessToken",
    "refreshToken",
    "token",
    "phone",
    "password",
    "privateKey",
    "deviceKey",
    "dek"
  ].map((key) => key.toLowerCase())
);
var analyticsDbPromise = null;
var SDKAnalyticsHelper = class {
  sdk;
  dependencies;
  options = null;
  queue = [];
  userId = "";
  context = {};
  anonymousId = "";
  sessionId = "";
  flushTimer = null;
  retryUntil = 0;
  currentRetryDelayMs = 0;
  flushPromise = null;
  indexedDbLoadPromise = null;
  stateVersion = 0;
  listenersAttached = false;
  detachAdapterFlushOnHide = null;
  fallbackAdapter;
  handleOnline = () => {
    this.scheduleFlush(0);
  };
  handleVisibilityChange = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      void this.flush().catch(() => void 0);
    }
  };
  handlePageHide = () => {
    this.flushOnPageHide();
  };
  constructor(sdk, dependencies = {}) {
    this.sdk = sdk;
    this.dependencies = dependencies;
  }
  init(options) {
    try {
      const adapter = this.getAdapter();
      const resolvedOptions = resolveOptions(this.sdk, options, adapter);
      this.options = resolvedOptions;
      this.anonymousId = getOrCreateAnonymousId(
        resolvedOptions.persist,
        adapter
      );
      this.sessionId = getOrCreateSessionId(adapter);
      this.queue = mergeQueues(
        resolvedOptions.persist ? readStoredQueue(adapter.storage) : [],
        this.queue
      );
      this.dropExpiredEvents();
      this.trimQueue();
      this.persistQueue();
      this.loadIndexedDbQueue();
      this.attachBrowserListeners();
      this.attachAdapterListeners(resolvedOptions.adapter);
      this.scheduleFlush(resolvedOptions.flushIntervalMs);
    } catch (error) {
      this.debugLog("analytics init failed", error);
    }
  }
  identify(userId, traits) {
    try {
      void traits;
      this.userId = normalizeUserId(userId);
    } catch (error) {
      this.debugLog("analytics identify failed", error);
    }
  }
  track(eventName, properties = {}, options = {}) {
    try {
      const resolvedOptions = this.options;
      if (!resolvedOptions) {
        return;
      }
      const normalizedEventName = normalizeEventName(eventName);
      if (!normalizedEventName) {
        return;
      }
      const occurredAt = normalizeOccurredAt(options.occurredAt);
      if (!occurredAt || isEventExpired(occurredAt) || isEventInFuture(occurredAt)) {
        return;
      }
      const event = this.createEvent(
        normalizedEventName,
        properties,
        options,
        occurredAt
      );
      const normalizedEvent = fitEventToMaxBytes(
        event,
        resolvedOptions.maxEventBytes,
        resolvedOptions.adapter.runtime
      );
      if (!normalizedEvent) {
        return;
      }
      this.queue.push(normalizedEvent);
      this.trimQueue();
      this.persistQueue();
      this.scheduleFlush(
        this.queue.length >= resolvedOptions.maxBatchSize ? 0 : resolvedOptions.flushIntervalMs
      );
    } catch (error) {
      this.debugLog("analytics track failed", error);
    }
  }
  async flush() {
    const resolvedOptions = this.options;
    if (!resolvedOptions) {
      return this.emptyResult("not_initialized");
    }
    if (this.flushPromise) {
      return this.flushPromise;
    }
    const now = Date.now();
    if (this.retryUntil > now) {
      return {
        ok: false,
        queued: false,
        sent: 0,
        dropped: 0,
        remaining: this.queue.length,
        retryable: true,
        retryAfterMs: this.retryUntil - now,
        reason: "backoff"
      };
    }
    this.flushPromise = this.performFlush(resolvedOptions).finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }
  setContext(context) {
    try {
      this.context = sanitizeRecord(
        {
          ...this.context,
          ...context
        },
        "context"
      );
    } catch (error) {
      this.debugLog("analytics setContext failed", error);
    }
  }
  reset() {
    try {
      this.userId = "";
      this.context = {};
      this.sessionId = createId(
        "as",
        (this.options?.adapter ?? this.getAdapter()).runtime
      );
      writeSessionValue(
        ANALYTICS_SESSION_ID_STORAGE_KEY,
        this.sessionId,
        this.options?.adapter ?? this.getAdapter()
      );
      this.clearQueue();
    } catch (error) {
      this.debugLog("analytics reset failed", error);
    }
  }
  getAnonymousId() {
    if (!this.anonymousId) {
      const adapter = this.options?.adapter ?? this.getAdapter();
      this.anonymousId = getOrCreateAnonymousId(
        this.options?.persist ?? true,
        adapter
      );
    }
    return this.anonymousId;
  }
  getSessionId() {
    if (!this.sessionId) {
      this.sessionId = getOrCreateSessionId(
        this.options?.adapter ?? this.getAdapter()
      );
    }
    return this.sessionId;
  }
  destroy() {
    this.detachBrowserListeners();
    this.detachAdapterListeners();
    this.clearFlushTimer();
    this.clearQueue();
    this.options = null;
    this.flushPromise = null;
    this.indexedDbLoadPromise = null;
    this.retryUntil = 0;
    this.currentRetryDelayMs = 0;
    this.userId = "";
    this.context = {};
  }
  createEvent(eventName, properties, options, occurredAt) {
    const resolvedOptions = this.options;
    if (!resolvedOptions) {
      throw new Error("analytics is not initialized");
    }
    const marketingVisitorId = normalizeOptionalId(
      resolvedOptions.getMarketingVisitorId?.() ?? this.dependencies.getMarketingVisitorId?.() ?? null
    );
    const routePath = normalizeRoutePath(
      options.routePath ?? getRecordString(this.context, "routePath") ?? getCurrentPath(resolvedOptions.adapter.runtime)
    );
    const event = removeUndefinedFields({
      eventId: createId("evt", resolvedOptions.adapter.runtime),
      eventName,
      appName: resolvedOptions.appName,
      clientType: resolvedOptions.clientType,
      anonymousId: this.getAnonymousId(),
      marketingVisitorId,
      analyticsSessionId: this.getSessionId(),
      chatSessionId: normalizeOptionalId(options.chatSessionId),
      requestId: normalizeOptionalId(options.requestId),
      routePath,
      model: normalizeOptionalString(options.model, MODEL_MAX_LENGTH),
      result: normalizeResult(options.result),
      errorCode: normalizeOptionalString(options.errorCode, ERROR_CODE_MAX_LENGTH),
      durationMs: normalizeDurationMs(options.durationMs),
      properties: eventName === "custom.event" ? sanitizeCustomProperties(properties) : sanitizeRecord(properties, "properties"),
      context: sanitizeRecord(
        {
          sdkVersion: this.sdk.version,
          language: getNavigatorLanguage(),
          online: getNavigatorOnline(),
          identified: Boolean(this.userId),
          ...this.context
        },
        "context"
      ),
      occurredAt: occurredAt.toISOString()
    });
    if (event.properties && Object.keys(event.properties).length === 0) {
      delete event.properties;
    }
    if (event.context && Object.keys(event.context).length === 0) {
      delete event.context;
    }
    return event;
  }
  async performFlush(resolvedOptions) {
    this.clearFlushTimer();
    this.dropExpiredEvents();
    this.persistQueue();
    if (this.queue.length === 0) {
      return this.emptyResult("empty");
    }
    const batch = this.buildBatch(resolvedOptions);
    if (batch.length === 0) {
      return this.emptyResult("empty_batch");
    }
    const requestBody = JSON.stringify({ events: batch });
    try {
      const response = await resolvedOptions.adapter.http.request({
        url: resolvedOptions.endpoint,
        method: "POST",
        headers: await this.createHeaders(resolvedOptions),
        body: requestBody
      });
      const payload = await readJsonResponse(response);
      if (response.status === 429) {
        const retryAfterMs = resolveRetryAfterMs(
          payload?.retryAfterMs,
          readHeader(response.headers, "Retry-After"),
          resolvedOptions.retryBaseDelayMs
        );
        return this.keepForRetry(resolvedOptions, "rate_limited", retryAfterMs, {
          status: response.status
        });
      }
      if (response.ok && payload?.queued === true) {
        this.removeBatch(batch);
        this.resetBackoff();
        this.scheduleFlushIfNeeded(resolvedOptions);
        return {
          ok: true,
          queued: true,
          sent: batch.length,
          dropped: payload.dropped ?? 0,
          remaining: this.queue.length,
          retryable: false,
          status: response.status
        };
      }
      if (response.ok && payload?.retryable === true) {
        return this.keepForRetry(
          resolvedOptions,
          "queue_unavailable",
          payload.retryAfterMs,
          { status: response.status }
        );
      }
      if (response.ok || response.status >= 400 && response.status < 500) {
        this.removeBatch(batch);
        this.resetBackoff();
        this.scheduleFlushIfNeeded(resolvedOptions);
        return {
          ok: response.ok,
          queued: payload?.queued === true,
          sent: 0,
          dropped: batch.length,
          remaining: this.queue.length,
          retryable: false,
          status: response.status,
          reason: response.ok ? "not_queued" : "client_rejected"
        };
      }
      return this.keepForRetry(resolvedOptions, "server_error", void 0, {
        status: response.status
      });
    } catch (error) {
      this.debugLog("analytics flush failed", error);
      return this.keepForRetry(resolvedOptions, "network_error");
    }
  }
  buildBatch(resolvedOptions) {
    const batch = [];
    for (const event of this.queue) {
      if (batch.length >= resolvedOptions.maxBatchSize) {
        break;
      }
      const nextBatch = [...batch, event];
      const nextBytes = byteLength(
        JSON.stringify({ events: nextBatch }),
        resolvedOptions.adapter.runtime
      );
      if (nextBytes > resolvedOptions.maxBatchBytes) {
        if (batch.length === 0) {
          this.removeBatch([event]);
        }
        break;
      }
      batch.push(event);
    }
    return batch;
  }
  async createHeaders(resolvedOptions) {
    const headers = {
      "Content-Type": "application/json"
    };
    const token = await resolvedOptions.tokenProvider?.();
    const normalizedToken = normalizeToken(token);
    if (normalizedToken) {
      headers.Authorization = normalizedToken;
    }
    return headers;
  }
  createHeadersSync(resolvedOptions) {
    const headers = {
      "Content-Type": "application/json"
    };
    try {
      const token = resolvedOptions.tokenProvider?.();
      if (typeof token === "string") {
        const normalizedToken = normalizeToken(token);
        if (normalizedToken) {
          headers.Authorization = normalizedToken;
        }
      }
    } catch (error) {
      this.debugLog("analytics token provider failed", error);
    }
    return headers;
  }
  flushOnPageHide() {
    const resolvedOptions = this.options;
    if (!resolvedOptions || this.queue.length === 0) {
      return;
    }
    this.dropExpiredEvents();
    this.persistQueue();
    const batch = this.buildBatch(resolvedOptions);
    if (batch.length === 0) {
      return;
    }
    const requestBody = JSON.stringify({ events: batch });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && typeof Blob !== "undefined") {
      try {
        const beaconQueued = navigator.sendBeacon(
          resolvedOptions.endpoint,
          new Blob([requestBody], { type: "application/json" })
        );
        if (beaconQueued) {
          return;
        }
      } catch (error) {
        this.debugLog("analytics sendBeacon failed", error);
      }
    }
    if (typeof fetch === "function") {
      void fetch(resolvedOptions.endpoint, {
        method: "POST",
        headers: this.createHeadersSync(resolvedOptions),
        body: requestBody,
        credentials: "same-origin",
        keepalive: true
      }).then(async (response) => {
        const payload = await readJsonResponse(response);
        if (response.ok && payload?.queued === true) {
          this.removeBatch(batch);
        }
      }).catch((error) => {
        this.debugLog("analytics keepalive flush failed", error);
      });
    }
  }
  trimQueue() {
    const maxQueueSize = this.options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    while (this.queue.length > maxQueueSize) {
      this.queue.shift();
    }
  }
  dropExpiredEvents() {
    const before = this.queue.length;
    this.queue = this.queue.filter((event) => {
      const occurredAt = new Date(event.occurredAt);
      return !Number.isNaN(occurredAt.getTime()) && !isEventExpired(occurredAt);
    });
    if (before !== this.queue.length) {
      this.debugLog("analytics dropped expired events", {
        dropped: before - this.queue.length
      });
    }
  }
  removeBatch(batch) {
    const eventIds = new Set(batch.map((event) => event.eventId));
    this.queue = this.queue.filter((event) => !eventIds.has(event.eventId));
    this.persistQueue();
  }
  keepForRetry(resolvedOptions, reason, retryAfterMs, extra = {}) {
    const resolvedRetryAfterMs = normalizeRetryDelay(
      retryAfterMs,
      this.currentRetryDelayMs || resolvedOptions.retryBaseDelayMs,
      resolvedOptions.retryBaseDelayMs,
      resolvedOptions.retryMaxDelayMs
    );
    this.currentRetryDelayMs = Math.min(
      resolvedOptions.retryMaxDelayMs,
      resolvedRetryAfterMs * 2
    );
    this.retryUntil = Date.now() + resolvedRetryAfterMs;
    this.persistQueue();
    this.scheduleFlush(resolvedRetryAfterMs);
    return {
      ok: false,
      queued: false,
      sent: 0,
      dropped: 0,
      remaining: this.queue.length,
      retryable: true,
      retryAfterMs: resolvedRetryAfterMs,
      reason,
      ...extra
    };
  }
  resetBackoff() {
    this.retryUntil = 0;
    this.currentRetryDelayMs = 0;
  }
  scheduleFlushIfNeeded(resolvedOptions) {
    if (this.queue.length > 0) {
      this.scheduleFlush(resolvedOptions.flushIntervalMs);
    }
  }
  scheduleFlush(delayMs) {
    if (!this.options || this.queue.length === 0 || this.flushTimer) {
      return;
    }
    const now = Date.now();
    const effectiveDelayMs = Math.max(
      0,
      this.retryUntil > now ? this.retryUntil - now : delayMs
    );
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => void 0);
    }, effectiveDelayMs);
  }
  clearFlushTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
  attachBrowserListeners() {
    if (this.listenersAttached || typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("pagehide", this.handlePageHide);
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.listenersAttached = true;
  }
  detachBrowserListeners() {
    if (!this.listenersAttached || typeof window === "undefined" || typeof window.removeEventListener !== "function") {
      return;
    }
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("pagehide", this.handlePageHide);
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener(
        "visibilitychange",
        this.handleVisibilityChange
      );
    }
    this.listenersAttached = false;
  }
  attachAdapterListeners(adapter) {
    this.detachAdapterListeners();
    this.detachAdapterFlushOnHide = adapter.analytics?.flushOnHide?.(() => {
      void this.flush().catch(() => void 0);
    }) ?? null;
  }
  detachAdapterListeners() {
    this.detachAdapterFlushOnHide?.();
    this.detachAdapterFlushOnHide = null;
  }
  persistQueue() {
    if (!this.options?.persist) {
      return;
    }
    writeStoredQueue(this.queue, this.options.adapter.storage);
    if (shouldUseIndexedDb(this.options.adapter)) {
      void writeIndexedDbQueue(this.queue).catch((error) => {
        this.debugLog("analytics indexedDB write failed", error);
      });
    }
  }
  loadIndexedDbQueue() {
    if (!this.options?.persist || this.indexedDbLoadPromise || !shouldUseIndexedDb(this.options.adapter)) {
      return;
    }
    const loadVersion = this.stateVersion;
    this.indexedDbLoadPromise = readIndexedDbQueue().then((events) => {
      if (this.stateVersion !== loadVersion || !this.options?.persist) {
        return;
      }
      if (!events.length) {
        return;
      }
      this.queue = mergeQueues(events, this.queue);
      this.dropExpiredEvents();
      this.trimQueue();
      this.persistQueue();
      this.scheduleFlush(0);
    }).catch((error) => {
      this.debugLog("analytics indexedDB read failed", error);
    }).finally(() => {
      this.indexedDbLoadPromise = null;
    });
  }
  clearQueue() {
    const adapter = this.options?.adapter ?? this.getAdapter();
    this.stateVersion += 1;
    this.queue = [];
    removeStoredValue(ANALYTICS_QUEUE_STORAGE_KEY, adapter.storage);
    if (shouldUseIndexedDb(adapter)) {
      void clearIndexedDbQueue().catch((error) => {
        this.debugLog("analytics indexedDB clear failed", error);
      });
    }
  }
  emptyResult(reason) {
    return {
      ok: true,
      queued: false,
      sent: 0,
      dropped: 0,
      remaining: this.queue.length,
      retryable: false,
      reason
    };
  }
  debugLog(message, details) {
    if (!this.options?.debug || typeof console === "undefined") {
      return;
    }
    console.warn(`[JSSDK analytics] ${message}`, details);
  }
  getAdapter() {
    const adapter = this.sdk.getAdapter?.();
    if (adapter) {
      return adapter;
    }
    this.fallbackAdapter ??= createBrowserAdapter();
    return this.fallbackAdapter;
  }
};
function resolveOptions(sdk, options, adapter) {
  const appName = normalizeRequiredString(options.appName, "appName", 64);
  const clientType = normalizeClientType(options.clientType);
  return {
    appName,
    clientType,
    adapter,
    endpoint: normalizeEndpoint(
      options.endpoint,
      sdk.getApiBaseUrl?.() || DEFAULT_ANALYTICS_API_BASE_URL
    ),
    tokenProvider: options.tokenProvider,
    flushIntervalMs: normalizePositiveInteger(
      options.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS,
      500,
      6e4
    ),
    maxBatchSize: normalizePositiveInteger(
      options.maxBatchSize,
      DEFAULT_MAX_BATCH_SIZE,
      1,
      DEFAULT_MAX_BATCH_SIZE
    ),
    maxQueueSize: normalizePositiveInteger(
      options.maxQueueSize,
      DEFAULT_MAX_QUEUE_SIZE,
      1,
      1e4
    ),
    maxEventBytes: normalizePositiveInteger(
      options.maxEventBytes,
      DEFAULT_MAX_EVENT_BYTES,
      512,
      64 * 1024
    ),
    maxBatchBytes: normalizePositiveInteger(
      options.maxBatchBytes,
      DEFAULT_MAX_BATCH_BYTES,
      1024,
      512 * 1024
    ),
    retryBaseDelayMs: normalizePositiveInteger(
      options.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      1,
      6e4
    ),
    retryMaxDelayMs: normalizePositiveInteger(
      options.retryMaxDelayMs,
      DEFAULT_RETRY_MAX_DELAY_MS,
      1,
      15 * 60 * 1e3
    ),
    persist: options.persist !== false,
    debug: options.debug === true,
    getMarketingVisitorId: options.getMarketingVisitorId
  };
}
function normalizeEndpoint(endpoint, apiBaseUrl) {
  const explicitEndpoint = endpoint?.trim();
  if (explicitEndpoint) {
    return explicitEndpoint;
  }
  return buildApiUrl(apiBaseUrl, ANALYTICS_EVENTS_PATH);
}
function buildApiUrl(apiBaseUrl, path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const normalizedBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  if (normalizedBaseUrl === "") {
    return normalizedPath;
  }
  return `${normalizedBaseUrl}${normalizedPath}`;
}
function normalizeApiBaseUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return DEFAULT_ANALYTICS_API_BASE_URL;
  }
  if (trimmed === "/api") {
    return "";
  }
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}
function normalizeRequiredString(value, field, maxLength) {
  const normalized = normalizeOptionalString(value, maxLength);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}
function normalizeOptionalString(value, maxLength = STRING_VALUE_MAX_LENGTH) {
  if (typeof value !== "string") {
    return void 0;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : void 0;
}
function normalizeUserId(value) {
  return normalizeOptionalString(value, 128) || "";
}
function normalizeOptionalId(value) {
  const normalized = normalizeOptionalString(value, 128);
  if (!normalized || !ID_PATTERN.test(normalized)) {
    return void 0;
  }
  return normalized;
}
function normalizeEventName(value) {
  const normalized = value.trim();
  if (!EVENT_NAME_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}
function normalizeClientType(value) {
  if (value === "chat_pc" || value === "chatbot") {
    return "chatbot";
  }
  return value === "chat_web" || value === "desktop_mac" || value === "desktop_windows" || value === "sdk" || value === "console_web" || value === "unknown" ? value : "unknown";
}
function normalizeResult(value) {
  return value === "success" || value === "failed" || value === "canceled" || value === "unknown" ? value : void 0;
}
function normalizeDurationMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return void 0;
  }
  return Math.floor(value);
}
function normalizeRoutePath(value) {
  const normalized = normalizeOptionalString(value, ROUTE_PATH_MAX_LENGTH);
  if (!normalized) {
    return void 0;
  }
  const queryIndex = normalized.indexOf("?");
  const withoutQuery = queryIndex >= 0 ? normalized.slice(0, queryIndex) : normalized;
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}
function normalizeOccurredAt(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return /* @__PURE__ */ new Date();
}
function isEventExpired(occurredAt) {
  return Date.now() - occurredAt.getTime() > ANALYTICS_EVENT_TTL_MS;
}
function isEventInFuture(occurredAt) {
  return occurredAt.getTime() - Date.now() > MAX_FUTURE_SKEW_MS;
}
function sanitizeCustomProperties(value) {
  const sanitized = sanitizeRecord(value, "properties");
  const customName = normalizeOptionalString(sanitized.customName, 64);
  const remark = normalizeOptionalString(sanitized.remark, CUSTOM_REMARK_MAX_LENGTH);
  const source = normalizeOptionalString(sanitized.source, CUSTOM_SOURCE_MAX_LENGTH);
  const result = {};
  if (customName && CUSTOM_NAME_PATTERN.test(customName)) {
    result.customName = customName;
  }
  if (remark) {
    result.remark = remark;
  }
  if (source) {
    result.source = source;
  }
  if (typeof sanitized.value === "number" && Number.isFinite(sanitized.value)) {
    result.value = sanitized.value;
  }
  return result;
}
function sanitizeRecord(value, scope, depth = 0) {
  const result = {};
  if (!isPlainRecord(value) || depth >= SANITIZE_MAX_DEPTH) {
    return result;
  }
  for (const [key, entryValue] of Object.entries(value)) {
    if (!isAllowedKey(key)) {
      continue;
    }
    const normalizedValue = sanitizeValue(entryValue, scope, depth + 1);
    if (normalizedValue !== void 0) {
      result[key] = normalizedValue;
    }
  }
  return result;
}
function sanitizeValue(value, scope, depth) {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : void 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized.slice(0, STRING_VALUE_MAX_LENGTH) : void 0;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => sanitizeValue(item, scope, depth + 1)).filter((item) => item !== void 0);
    return items.length > 0 ? items : void 0;
  }
  if (isPlainRecord(value) && depth < SANITIZE_MAX_DEPTH) {
    const nested = sanitizeRecord(value, scope, depth);
    return Object.keys(nested).length > 0 ? nested : void 0;
  }
  return void 0;
}
function isAllowedKey(key) {
  return PROPERTY_KEY_PATTERN.test(key) && !FORBIDDEN_KEYS.has(key.toLowerCase());
}
function fitEventToMaxBytes(event, maxEventBytes, runtime) {
  let normalizedEvent = event;
  if (byteLength(JSON.stringify(normalizedEvent), runtime) <= maxEventBytes) {
    return normalizedEvent;
  }
  normalizedEvent = {
    ...normalizedEvent,
    properties: trimRecordToFit(
      normalizedEvent.properties ?? {},
      (nextProperties) => byteLength(
        JSON.stringify({
          ...normalizedEvent,
          properties: nextProperties
        }),
        runtime
      ) <= maxEventBytes
    )
  };
  if (normalizedEvent.properties && Object.keys(normalizedEvent.properties).length === 0) {
    delete normalizedEvent.properties;
  }
  if (byteLength(JSON.stringify(normalizedEvent), runtime) <= maxEventBytes) {
    return normalizedEvent;
  }
  delete normalizedEvent.context;
  if (byteLength(JSON.stringify(normalizedEvent), runtime) <= maxEventBytes) {
    return normalizedEvent;
  }
  return null;
}
function trimRecordToFit(value, fits) {
  const entries = Object.entries(value);
  const nextValue = {};
  for (const [key, entryValue] of entries) {
    const candidate = {
      ...nextValue,
      [key]: entryValue
    };
    if (fits(candidate)) {
      nextValue[key] = entryValue;
    }
  }
  return nextValue;
}
function getCurrentPath(runtime) {
  const adapterPath = runtime.getCurrentPath?.();
  if (adapterPath) {
    return adapterPath;
  }
  if (typeof window === "undefined" || !window.location) {
    return void 0;
  }
  return window.location.pathname || "/";
}
function getNavigatorLanguage() {
  if (typeof navigator === "undefined") {
    return void 0;
  }
  return normalizeOptionalString(navigator.language, 32);
}
function getNavigatorOnline() {
  if (typeof navigator === "undefined") {
    return void 0;
  }
  return navigator.onLine;
}
function getOrCreateAnonymousId(persist, adapter) {
  const existing = persist ? readStoredValue(ANALYTICS_ANONYMOUS_ID_STORAGE_KEY, adapter.storage) : "";
  if (existing && ID_PATTERN.test(existing)) {
    return existing;
  }
  const anonymousId = createId("anon", adapter.runtime);
  if (persist) {
    writeStoredValue(
      ANALYTICS_ANONYMOUS_ID_STORAGE_KEY,
      anonymousId,
      adapter.storage
    );
  }
  return anonymousId;
}
function getOrCreateSessionId(adapter) {
  const existing = readSessionValue(ANALYTICS_SESSION_ID_STORAGE_KEY, adapter);
  if (existing && ID_PATTERN.test(existing)) {
    return existing;
  }
  const sessionId = createId("as", adapter.runtime);
  writeSessionValue(ANALYTICS_SESSION_ID_STORAGE_KEY, sessionId, adapter);
  return sessionId;
}
function readStoredQueue(storage) {
  const rawValue = readStoredValue(ANALYTICS_QUEUE_STORAGE_KEY, storage);
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    const events = Array.isArray(parsed) ? parsed : isPlainRecord(parsed) && Array.isArray(parsed.events) ? parsed.events : [];
    return events.filter(isAnalyticsEvent);
  } catch {
    return [];
  }
}
function writeStoredQueue(events, storage) {
  writeStoredValue(
    ANALYTICS_QUEUE_STORAGE_KEY,
    JSON.stringify({
      events
    }),
    storage
  );
}
async function readIndexedDbQueue() {
  const database = await openAnalyticsDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      ANALYTICS_INDEXED_DB_STORE,
      "readonly"
    );
    const request = transaction.objectStore(ANALYTICS_INDEXED_DB_STORE).get(ANALYTICS_INDEXED_DB_KEY);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const result = request.result;
      const events = isPlainRecord(result) && Array.isArray(result.events) ? result.events : [];
      resolve(events.filter(isAnalyticsEvent));
    };
  });
}
async function writeIndexedDbQueue(events) {
  const database = await openAnalyticsDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      ANALYTICS_INDEXED_DB_STORE,
      "readwrite"
    );
    const request = transaction.objectStore(ANALYTICS_INDEXED_DB_STORE).put({ events }, ANALYTICS_INDEXED_DB_KEY);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}
async function clearIndexedDbQueue() {
  const database = await openAnalyticsDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      ANALYTICS_INDEXED_DB_STORE,
      "readwrite"
    );
    const request = transaction.objectStore(ANALYTICS_INDEXED_DB_STORE).delete(ANALYTICS_INDEXED_DB_KEY);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}
function openAnalyticsDatabase() {
  const indexedDb = getIndexedDb();
  if (!indexedDb) {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  if (!analyticsDbPromise) {
    const nextDbPromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(ANALYTICS_INDEXED_DB_NAME, 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ANALYTICS_INDEXED_DB_STORE)) {
          database.createObjectStore(ANALYTICS_INDEXED_DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
    analyticsDbPromise = nextDbPromise.catch((error) => {
      analyticsDbPromise = null;
      throw error;
    });
  }
  return analyticsDbPromise;
}
function getIndexedDb() {
  if (typeof indexedDB !== "undefined") {
    return indexedDB;
  }
  if (typeof window !== "undefined" && window.indexedDB) {
    return window.indexedDB;
  }
  return null;
}
function shouldUseIndexedDb(adapter) {
  return adapter.platform === "browser" && Boolean(getIndexedDb());
}
function mergeQueues(firstQueue, secondQueue) {
  const seen = /* @__PURE__ */ new Set();
  const merged = [];
  for (const event of [...firstQueue, ...secondQueue]) {
    if (seen.has(event.eventId)) {
      continue;
    }
    seen.add(event.eventId);
    merged.push(event);
  }
  return merged;
}
function isAnalyticsEvent(value) {
  if (!isPlainRecord(value)) {
    return false;
  }
  return typeof value.eventId === "string" && typeof value.eventName === "string" && typeof value.appName === "string" && typeof value.clientType === "string" && typeof value.anonymousId === "string" && typeof value.analyticsSessionId === "string" && typeof value.occurredAt === "string";
}
function readStoredValue(key, storage) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
function writeStoredValue(key, value, storage) {
  try {
    storage.setItem(key, value);
  } catch {
    return;
  }
}
function removeStoredValue(key, storage) {
  try {
    storage.removeItem(key);
  } catch {
    return;
  }
}
function readSessionValue(key, adapter) {
  try {
    if (adapter.platform === "browser" && typeof window !== "undefined" && window.sessionStorage) {
      return window.sessionStorage.getItem(key);
    }
    return adapter.storage.getItem(key);
  } catch {
    return null;
  }
}
function writeSessionValue(key, value, adapter) {
  try {
    if (adapter.platform === "browser" && typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.setItem(key, value);
      return;
    }
    adapter.storage.setItem(key, value);
  } catch {
    return;
  }
}
function createId(prefix, runtime) {
  const randomUUID = runtime?.randomUUID?.() || (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : typeof window !== "undefined" && window.crypto && typeof window.crypto.randomUUID === "function" ? window.crypto.randomUUID() : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  return `${prefix}_${randomUUID.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 128);
}
function normalizePositiveInteger(value, fallback, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
function normalizeRetryDelay(value, fallback, min, max) {
  return normalizePositiveInteger(value, fallback, min, max);
}
function resolveRetryAfterMs(retryAfterMs, retryAfterHeader, fallback) {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
    return retryAfterMs;
  }
  if (retryAfterHeader) {
    const numericSeconds = Number(retryAfterHeader);
    if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
      return Math.ceil(numericSeconds * 1e3);
    }
    const dateMs = new Date(retryAfterHeader).getTime();
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }
  return fallback;
}
function normalizeToken(value) {
  const token = value?.trim();
  if (!token) {
    return "";
  }
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}
async function readJsonResponse(response) {
  const contentType = readHeader(response.headers, "Content-Type").toLowerCase();
  if (contentType && !contentType.includes("application/json")) {
    return null;
  }
  try {
    const payload = await response.json();
    return isPlainRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}
function readHeader(headers, name) {
  if (typeof headers.get === "function") {
    return headers.get(name) ?? "";
  }
  const targetName = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === targetName
  );
  return entry?.[1] ?? "";
}
function removeUndefinedFields(value) {
  for (const key of Object.keys(value)) {
    if (value[key] === void 0) {
      delete value[key];
    }
  }
  return value;
}
function getRecordString(value, key) {
  const entry = value[key];
  return typeof entry === "string" ? entry : void 0;
}
function byteLength(value, runtime) {
  if (runtime) {
    return runtime.utf8Encode(value).length;
  }
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gi, "x").length;
}
function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// src/channel.ts
var DEFAULT_CHANNEL_API_BASE_URL = "https://api.jinghua.security";
var MARKETING_VISITOR_ID_STORAGE_KEY = "jh_marketing_visitor_id";
var MARKETING_FIRST_TOUCH_STORAGE_KEY = "jh_marketing_first_touch";
var MARKETING_LAST_TOUCH_STORAGE_KEY = "jh_marketing_last_touch";
var SOURCE_PATTERN = /^[a-z0-9_]{1,64}$/;
var VISITOR_ID_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
var VALUE_MAX_LENGTH = 128;
var REFERRER_HOST_MAX_LENGTH = 128;
var LANDING_PATH_MAX_LENGTH = 1024;
var PLATFORM_CLICK_PARAMS = [
  "bd_vid",
  "click_id",
  "callback",
  "gdt_vid"
];
var memoryMarketingVisitorId = "";
var reportedLandingVisitKeys = /* @__PURE__ */ new Set();
var SDKChannelHelper = class {
  sdk;
  apiBaseUrl = null;
  fallbackAdapter;
  constructor(sdk) {
    this.sdk = sdk;
  }
  async capture(input) {
    const snapshot = this.captureCurrentAttribution(input);
    if (!snapshot) {
      return null;
    }
    await this.reportLandingVisitOnce(snapshot);
    return snapshot;
  }
  getCurrentAttribution() {
    return readStoredAttribution(
      MARKETING_LAST_TOUCH_STORAGE_KEY,
      this.getAdapter().storage
    );
  }
  withLoginAttribution(payload) {
    if (Object.prototype.hasOwnProperty.call(payload, "attribution")) {
      return payload;
    }
    const currentSnapshot = this.captureCurrentAttribution();
    if (currentSnapshot) {
      void this.reportLandingVisitOnce(currentSnapshot).catch(() => void 0);
    }
    const attribution = currentSnapshot && currentSnapshot.source !== "direct" ? currentSnapshot : this.getCurrentAttribution();
    if (!attribution) {
      return payload;
    }
    return {
      ...payload,
      attribution: toMarketingAttributionPayload(attribution)
    };
  }
  clear() {
    const storage = this.getAdapter().storage;
    memoryMarketingVisitorId = "";
    reportedLandingVisitKeys.clear();
    removeStoredValue2(MARKETING_VISITOR_ID_STORAGE_KEY, storage);
    removeStoredValue2(MARKETING_FIRST_TOUCH_STORAGE_KEY, storage);
    removeStoredValue2(MARKETING_LAST_TOUCH_STORAGE_KEY, storage);
  }
  setApiBaseUrl(apiBaseUrl) {
    this.apiBaseUrl = normalizeApiBaseUrl2(apiBaseUrl);
  }
  buildCurrentSnapshot(input) {
    const adapter = this.getAdapter();
    const captureInput = input ?? adapter.channel?.getCaptureInput?.() ?? null;
    if (!captureInput) {
      return null;
    }
    return buildMarketingAttributionSnapshot(
      toMarketingAttributionLocationInput(captureInput, adapter)
    );
  }
  captureCurrentAttribution(input) {
    const snapshot = this.buildCurrentSnapshot(input);
    if (!snapshot) {
      return null;
    }
    if (snapshot.source !== "direct") {
      const storage = this.getAdapter().storage;
      if (!readStoredAttribution(MARKETING_FIRST_TOUCH_STORAGE_KEY, storage)) {
        writeStoredAttribution(MARKETING_FIRST_TOUCH_STORAGE_KEY, snapshot, storage);
      }
      writeStoredAttribution(MARKETING_LAST_TOUCH_STORAGE_KEY, snapshot, storage);
    }
    return snapshot;
  }
  async reportLandingVisitOnce(snapshot) {
    const reportKey = getLandingVisitReportKey(snapshot);
    if (reportedLandingVisitKeys.has(reportKey)) {
      return;
    }
    reportedLandingVisitKeys.add(reportKey);
    await this.reportLandingVisit(snapshot);
  }
  async reportLandingVisit(snapshot) {
    try {
      await this.getAdapter().http.request({
        url: buildApiUrl2(
          this.resolveApiBaseUrl(),
          "/api/marketing/attribution/events"
        ),
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          eventType: "landing_visit",
          attribution: toMarketingAttributionPayload(snapshot)
        })
      });
    } catch {
      return;
    }
  }
  resolveApiBaseUrl() {
    if (this.apiBaseUrl !== null) {
      return this.apiBaseUrl;
    }
    return normalizeApiBaseUrl2(
      this.sdk.getApiBaseUrl?.() || DEFAULT_CHANNEL_API_BASE_URL
    );
  }
  getAdapter() {
    const adapter = this.sdk.getAdapter?.();
    if (adapter) {
      return adapter;
    }
    this.fallbackAdapter ??= createBrowserAdapter();
    return this.fallbackAdapter;
  }
};
function buildMarketingAttributionSnapshot(input) {
  const searchParams = input.query;
  const source = normalizeSource(searchParams.get("utm_source"));
  if (!source) {
    return null;
  }
  const visitorId = getMarketingVisitorId(input.storage, input.runtime);
  if (!visitorId || !VISITOR_ID_PATTERN.test(visitorId)) {
    return null;
  }
  const medium = normalizeSearchValue(searchParams.get("utm_medium"));
  const campaign = normalizeSearchValue(searchParams.get("utm_campaign"));
  const content = normalizeSearchValue(searchParams.get("utm_content"));
  const term = normalizeSearchValue(searchParams.get("utm_term"));
  const platformClick = getPlatformClick(searchParams);
  return {
    visitorId,
    source,
    medium,
    campaign,
    content,
    term,
    platformClickId: platformClick.id,
    platformClickParam: platformClick.param,
    referrerHost: getReferrerHost(input.referrer),
    landingPath: normalizeLandingPath(input.pathname),
    capturedAt: (input.now ?? /* @__PURE__ */ new Date()).toISOString()
  };
}
function getMarketingVisitorId(storage, runtime) {
  try {
    const existing = storage.getItem(MARKETING_VISITOR_ID_STORAGE_KEY);
    if (existing && VISITOR_ID_PATTERN.test(existing)) {
      return existing;
    }
    const visitorId = getMemoryMarketingVisitorId(runtime);
    storage.setItem(MARKETING_VISITOR_ID_STORAGE_KEY, visitorId);
    return visitorId;
  } catch {
    return getMemoryMarketingVisitorId(runtime);
  }
}
function createMarketingVisitorId(runtime) {
  const browserRandomId = typeof window !== "undefined" ? window.crypto?.randomUUID?.() : "";
  const randomId = browserRandomId || runtime.randomUUID?.();
  if (randomId && VISITOR_ID_PATTERN.test(randomId)) {
    return randomId;
  }
  return `visitor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function getMemoryMarketingVisitorId(runtime) {
  if (!memoryMarketingVisitorId) {
    memoryMarketingVisitorId = createMarketingVisitorId(runtime);
  }
  return memoryMarketingVisitorId;
}
function normalizeSource(value) {
  const normalized = normalizeSearchValue(value);
  return SOURCE_PATTERN.test(normalized) ? normalized : "";
}
function normalizeSearchValue(value) {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > VALUE_MAX_LENGTH) {
    return "";
  }
  return normalized;
}
function getPlatformClick(searchParams) {
  for (const param of PLATFORM_CLICK_PARAMS) {
    const id = normalizeSearchValue(searchParams.get(param));
    if (id) {
      return { id, param };
    }
  }
  return { id: "", param: "" };
}
function getReferrerHost(referrer = "") {
  const normalized = referrer.trim();
  if (!normalized) {
    return "";
  }
  try {
    return new URL(normalized).hostname.slice(0, REFERRER_HOST_MAX_LENGTH);
  } catch {
    return "";
  }
}
function normalizeLandingPath(pathname) {
  const normalized = pathname.trim() || "/";
  const landingPath = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return landingPath.slice(0, LANDING_PATH_MAX_LENGTH);
}
function toMarketingAttributionPayload(snapshot) {
  return {
    visitorId: snapshot.visitorId,
    source: snapshot.source,
    medium: snapshot.medium,
    campaign: snapshot.campaign,
    content: snapshot.content,
    term: snapshot.term,
    platformClickId: snapshot.platformClickId,
    platformClickParam: snapshot.platformClickParam,
    referrerHost: snapshot.referrerHost,
    landingPath: snapshot.landingPath
  };
}
function getLandingVisitReportKey(snapshot) {
  return JSON.stringify([
    snapshot.visitorId,
    snapshot.source,
    snapshot.medium,
    snapshot.campaign,
    snapshot.content,
    snapshot.term,
    snapshot.platformClickId,
    snapshot.platformClickParam,
    snapshot.referrerHost,
    snapshot.landingPath
  ]);
}
function readStoredAttribution(storageKey, storage) {
  try {
    const value = storage.getItem(storageKey);
    if (!value) {
      return null;
    }
    const parsed = JSON.parse(value);
    return isMarketingAttributionSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function writeStoredAttribution(storageKey, snapshot, storage) {
  try {
    storage.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    return;
  }
}
function removeStoredValue2(storageKey, storage) {
  try {
    storage.removeItem(storageKey);
  } catch {
    return;
  }
}
function isMarketingAttributionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const snapshot = value;
  const platformClickId = snapshot.platformClickId;
  const platformClickParam = snapshot.platformClickParam;
  return typeof snapshot.visitorId === "string" && VISITOR_ID_PATTERN.test(snapshot.visitorId) && typeof snapshot.source === "string" && SOURCE_PATTERN.test(snapshot.source) && typeof snapshot.medium === "string" && snapshot.medium.length <= VALUE_MAX_LENGTH && typeof snapshot.campaign === "string" && snapshot.campaign.length <= VALUE_MAX_LENGTH && typeof snapshot.content === "string" && snapshot.content.length <= VALUE_MAX_LENGTH && typeof snapshot.term === "string" && snapshot.term.length <= VALUE_MAX_LENGTH && typeof platformClickId === "string" && platformClickId.length <= VALUE_MAX_LENGTH && typeof platformClickParam === "string" && isConsistentPlatformClick(platformClickId, platformClickParam) && typeof snapshot.referrerHost === "string" && snapshot.referrerHost.length <= REFERRER_HOST_MAX_LENGTH && typeof snapshot.landingPath === "string" && snapshot.landingPath.startsWith("/") && snapshot.landingPath.length <= LANDING_PATH_MAX_LENGTH && typeof snapshot.capturedAt === "string" && Number.isFinite(Date.parse(snapshot.capturedAt));
}
function isConsistentPlatformClick(id, param) {
  if (!isPlatformClickParam(param)) {
    return false;
  }
  return param === "" ? id === "" : id !== "";
}
function isPlatformClickParam(value) {
  return value === "" || PLATFORM_CLICK_PARAMS.includes(value);
}
function normalizeApiBaseUrl2(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return DEFAULT_CHANNEL_API_BASE_URL;
  }
  if (trimmed === "/api") {
    return "";
  }
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}
function buildApiUrl2(apiBaseUrl, path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (apiBaseUrl === "") {
    return normalizedPath;
  }
  return `${normalizeApiBaseUrl2(apiBaseUrl)}${normalizedPath}`;
}
function toMarketingAttributionLocationInput(input, adapter) {
  return {
    query: buildCaptureSearchParams(input),
    pathname: input.path || adapter.runtime.getCurrentPath?.() || "/",
    referrer: normalizeCaptureReferrer(input.referrerInfo),
    runtime: adapter.runtime,
    storage: adapter.storage
  };
}
function buildCaptureSearchParams(input) {
  const searchParams = new URLSearchParams();
  const query = isRecord(input.query) ? input.query : {};
  appendDerivedQueryParams(searchParams, input.scene);
  appendDerivedQueryParams(searchParams, query.scene);
  appendDerivedQueryParams(searchParams, query.q);
  for (const [key, value] of Object.entries(query)) {
    const normalizedValue = normalizeQueryParamValue(value);
    if (normalizedValue !== null) {
      searchParams.set(key, normalizedValue);
    }
  }
  return searchParams;
}
function appendDerivedQueryParams(target, value) {
  const rawValue = normalizeQueryParamValue(value);
  if (!rawValue) {
    return;
  }
  const candidates = /* @__PURE__ */ new Set([rawValue]);
  try {
    candidates.add(decodeURIComponent(rawValue));
  } catch {
  }
  for (const candidate of candidates) {
    const parsedParams = parseEmbeddedQuery(candidate);
    parsedParams.forEach((entryValue, key) => {
      target.set(key, entryValue);
    });
  }
}
function parseEmbeddedQuery(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return new URLSearchParams();
  }
  try {
    const url = new URL(trimmed);
    return url.searchParams;
  } catch {
    const queryIndex = trimmed.indexOf("?");
    const queryText = queryIndex >= 0 ? trimmed.slice(queryIndex + 1) : trimmed.replace(/^\?/, "");
    return queryText.includes("=") ? new URLSearchParams(queryText) : new URLSearchParams();
  }
}
function normalizeQueryParamValue(value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}
function normalizeCaptureReferrer(referrerInfo) {
  if (typeof referrerInfo === "string") {
    return referrerInfo;
  }
  if (!isRecord(referrerInfo)) {
    return "";
  }
  const url = normalizeQueryParamValue(referrerInfo.url);
  if (url) {
    return url;
  }
  const appId = normalizeQueryParamValue(referrerInfo.appId);
  return appId ? `miniapp://${appId}` : "";
}
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// src/helper.ts
var DEFAULT_HELPER_API_BASE_URL = "https://api.jinghua.security";
var DEFAULT_DEVICE_KEY_EXPORT_FILE_NAME = "\u8346\u534E\u5BC6\u7B97\u79C1\u94A5.json";
var DEFAULT_CHAT_CONTEXT_LIMIT = 20;
var MAX_CHAT_CONTEXT_LIMIT = 20;
var DEFAULT_CHAT_ATTACHMENT_MAX_COUNT = 5;
var MAX_CHAT_ATTACHMENT_MAX_COUNT = 10;
var DEFAULT_CHAT_ATTACHMENT_MAX_SIZE_MB = 2;
var MAX_CHAT_ATTACHMENT_MAX_SIZE_MB = 20;
var DEFAULT_REQUEST_TIMEOUT_MS = 48e4;
var DEFAULT_ASR_REQUEST_TIMEOUT_MS = 95e3;
var DEK_HEX_PATTERN = /^[0-9a-f]{64}$/i;
var FILE_FINGERPRINT_VERSION = "user_sm3_v1";
var CHAT_IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif"
];
var CHAT_FILE_EXTENSIONS = [
  "pdf",
  "txt",
  "md",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "ppt",
  "pptx",
  "json",
  "log",
  "xml"
];
var CHAT_ATTACHMENT_EXTENSIONS = [
  ...CHAT_IMAGE_EXTENSIONS,
  ...CHAT_FILE_EXTENSIONS
];
var CHAT_ATTACHMENT_EXTENSIONS_SET = new Set(
  CHAT_ATTACHMENT_EXTENSIONS
);
var CHAT_IMAGE_EXTENSIONS_SET = new Set(CHAT_IMAGE_EXTENSIONS);
var ATTACHMENT_ONLY_TRANSPORT_PROMPT = "\u8BF7\u7ED3\u5408\u672C\u6761\u6D88\u606F\u4E2D\u7684\u9644\u4EF6\u5185\u5BB9\u8FDB\u884C\u5206\u6790\u5E76\u56DE\u7B54\u3002";
var SERVER_BUSY_RETRY_DELAYS_MS = [120, 240, 480, 960];
var RECENT_CANCELED_SESSION_WINDOW_MS = 5e3;
var CERTIFICATE_STALE_RETRY_CODES = /* @__PURE__ */ new Set([
  "CERTIFICATE_STALE",
  "GENERATION_TRANSPORT_DECRYPT_FAILED",
  "ENCRYPTED_DEK_DECRYPT_FAILED"
]);
var CERTIFICATE_STALE_RETRY_STATUSES = /* @__PURE__ */ new Set([400, 422, 500]);
var CERTIFICATE_STALE_RETRY_KEYWORDS = [
  "encrypted_dek",
  "generation_transport",
  "decrypt",
  "\u89E3\u5BC6",
  "certificate",
  "\u8BC1\u4E66",
  "public_key"
];
var HELPER_STATUS_DEFINITIONS = {
  submit_question: {
    step: "0",
    title: "\u63D0\u4EA4\u95EE\u9898",
    info: ["\u63D0\u4EA4\u95EE\u9898"]
  },
  local_encrypt_attest: {
    step: "1",
    title: "\u672C\u5730\u52A0\u5BC6\u548C\u8FDC\u7A0B\u8BC1\u660E",
    info: [
      "\u5BC6\u6001\u8BA1\u7B97\u73AF\u5883\u8FDC\u7A0B\u8BC1\u660E...",
      "\u4F7F\u7528\u79C1\u94A5\u52A0\u5BC6\u95EE\u9898...",
      "\u5BC6\u6587\u6570\u636E\u5305\u6B63\u5728\u4E0A\u4F20\u81F3\u4E91\u7AEF\u50A8\u5B58\u4E2D\u5FC3..."
    ]
  },
  cpu_tee_processing: {
    step: "2",
    title: "CPU-TEE\u9A8C\u8BC1\u548C\u5904\u7406",
    info: ["\u9A8C\u8BC1\u7528\u6237\u8EAB\u4EFD..."]
  },
  inference_busy: {
    step: "3",
    title: "\u6A21\u578B\u670D\u52A1\u7E41\u5FD9",
    info: ["\u6A21\u578B\u670D\u52A1\u7E41\u5FD9\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"]
  },
  gpu_cipher_computing: {
    step: "3",
    title: "GPU\u5BC6\u6587\u8BA1\u7B97",
    info: ["\u8FDB\u884C\u5BC6\u6001\u63A8\u7406..."]
  },
  STREAM_ERROR: {
    step: "3",
    title: "\u6D41\u5F0F\u8BFB\u53D6\u4E0D\u53EF\u7528",
    info: ["\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u6D41\u5F0F\u8BFB\u53D6\uFF0C\u5DF2\u81EA\u52A8\u5207\u6362\u4E3A\u975E\u6D41\u5F0F\u8F93\u51FA"]
  },
  inference_queued: {
    step: "3",
    title: "\u6A21\u578B\u6392\u961F\u4E2D",
    info: ["\u6A21\u578B\u670D\u52A1\u7E41\u5FD9\uFF0C\u6B63\u5728\u7B49\u5F85\u7A7A\u95F2\u8D44\u6E90..."]
  },
  ciphertext_returned: {
    step: "4",
    title: "\u8FD4\u56DE\u5BC6\u6587\u7ED3\u679C",
    info: ["\u5BC6\u6587\u7ED3\u679C\u6B63\u5728\u8FD4\u56DE\u81F3\u672C\u5730..."]
  },
  local_decrypt: {
    step: "5",
    title: "\u672C\u5730\u89E3\u5BC6",
    info: ["\u4F7F\u7528\u79C1\u94A5\u89E3\u5BC6\u5BC6\u6587\u7ED3\u679C..."]
  }
};
var HelperFlowError = class extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.name = "SDKHelperError";
    this.code = code;
    this.details = details;
  }
};
var SDKHelper = class {
  sdk;
  channel;
  analytics;
  token;
  dek;
  dekUserId;
  sessionId;
  options = createDefaultOptions();
  historyMap = /* @__PURE__ */ new Map();
  attachmentMap = /* @__PURE__ */ new Map();
  attachmentDedupeMap = /* @__PURE__ */ new Map();
  messageListeners = /* @__PURE__ */ new Set();
  statusListeners = /* @__PURE__ */ new Set();
  attachmentStatusListeners = /* @__PURE__ */ new Set();
  uploadFileStatusListeners = /* @__PURE__ */ new Set();
  uploadFileStatusContextMap = /* @__PURE__ */ new Map();
  attachmentProcessingWatchMap = /* @__PURE__ */ new Map();
  removedAttachmentIds = /* @__PURE__ */ new Set();
  attachmentProcessingWatcher;
  statusRunMap = /* @__PURE__ */ new Map();
  pendingMap = /* @__PURE__ */ new Map();
  pendingAsrControllers = /* @__PURE__ */ new Set();
  pendingSessionMap = /* @__PURE__ */ new Map();
  busySessionMap = /* @__PURE__ */ new Map();
  recentCanceledSessionMap = /* @__PURE__ */ new Map();
  lastUnauthorizedRequest;
  streamReadableUnsupported = false;
  destroyVersion = 0;
  fallbackAdapter;
  constructor(sdk) {
    this.sdk = sdk;
    this.channel = new SDKChannelHelper(sdk);
    this.analytics = new SDKAnalyticsHelper(sdk, {
      getMarketingVisitorId: () => this.channel.getCurrentAttribution()?.visitorId ?? null
    });
  }
  getAdapter() {
    const adapter = this.sdk.getAdapter?.();
    if (adapter) {
      return adapter;
    }
    this.fallbackAdapter ??= createBrowserAdapter();
    return this.fallbackAdapter;
  }
  createAbortController() {
    const adapter = this.getAdapter();
    if (adapter.createAbortController) {
      return adapter.createAbortController();
    }
    return new AbortController();
  }
  async init() {
    try {
      const deviceKeyState = await this.getDeviceKeyState();
      if (!deviceKeyState.ok) {
        return this.fail(
          deviceKeyState.code,
          deviceKeyState.message,
          deviceKeyState.details
        );
      }
      return this.ok({
        status: deviceKeyState.data.hasDek ? "already_initialized" : "missing",
        dek: deviceKeyState.data.dek,
        userId: deviceKeyState.data.userId
      });
    } catch (error) {
      return this.fail(
        "SDK_NOT_READY",
        "SDK \u521D\u59CB\u5316\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        normalizeErrorDetails(error)
      );
    }
  }
  setSecret(dek) {
    const userId = this.resolveCurrentUserId();
    if (!userId) {
      return this.fail(
        "SECRET_MISSING",
        "DEK helper API \u9700\u8981\u5148\u8C03\u7528 sdk.init({ userId })"
      );
    }
    if (!isDeviceKeyRecord(dek)) {
      return this.fail("SECRET_MISSING", "\u79C1\u94A5\u7ED3\u6784\u4E0D\u5B8C\u6574\u6216\u683C\u5F0F\u4E0D\u6B63\u786E");
    }
    try {
      this.setRuntimeSecret(dek, userId);
      return this.ok(cloneDeviceKeyRecord(dek));
    } catch (error) {
      return this.fail(
        "SDK_NOT_READY",
        "\u5199\u5165\u79C1\u94A5\u5931\u8D25",
        normalizeErrorDetails(error)
      );
    }
  }
  async ensureCloudDeviceKey() {
    const stateVersion = this.destroyVersion;
    try {
      await this.sdk.init();
      this.assertStateVersion(stateVersion);
      this.assertTokenReady();
      const userId = this.resolveDekInitUserId();
      const activeDeviceKey = this.getCurrentSecret(userId);
      if (activeDeviceKey) {
        return this.ok({
          userId,
          source: "memory",
          initialized: true,
          dek: activeDeviceKey,
          requiresBackup: false
        });
      }
      const cloudResult = await this.getCloudDeviceKey(userId);
      this.assertStateVersion(stateVersion);
      if (!cloudResult.ok) {
        return this.fail(
          cloudResult.code,
          cloudResult.message,
          cloudResult.details
        );
      }
      if (cloudResult.data.dek) {
        this.setRuntimeSecret(cloudResult.data.dek, userId);
        return this.ok({
          userId,
          source: "cloud",
          initialized: true,
          dek: cloudResult.data.dek,
          requiresBackup: false
        });
      }
      const generatedDeviceKey = await this.sdk.generateDeviceKey({
        userId,
        markInitialized: false,
        force: true
      });
      this.assertStateVersion(stateVersion);
      if (!generatedDeviceKey) {
        return this.fail("SECRET_MISSING", "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u79C1\u94A5\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
      const uploadResult = await this.uploadCloudDeviceKey(generatedDeviceKey);
      this.assertStateVersion(stateVersion);
      if (!uploadResult.ok) {
        if (isConflictResponseResult(uploadResult)) {
          const refetchResult = await this.getCloudDeviceKey(userId);
          this.assertStateVersion(stateVersion);
          if (refetchResult.ok && refetchResult.data.dek) {
            this.setRuntimeSecret(refetchResult.data.dek, userId);
            return this.ok({
              userId,
              source: "cloud",
              initialized: true,
              dek: refetchResult.data.dek,
              requiresBackup: false
            });
          }
          this.clearSecretState(userId);
          if (!refetchResult.ok) {
            return this.fail(
              refetchResult.code,
              refetchResult.message,
              refetchResult.details
            );
          }
          return this.fail(
            "SECRET_MISSING",
            "\u4E91\u7AEF DEK \u5DF2\u88AB\u5176\u4ED6\u8BF7\u6C42\u521D\u59CB\u5316\uFF0C\u4F46\u91CD\u65B0\u62C9\u53D6\u54CD\u5E94\u7F3A\u5C11\u79C1\u94A5",
            refetchResult.data
          );
        }
        this.clearSecretState(userId);
        return this.fail(
          uploadResult.code,
          uploadResult.message,
          uploadResult.details
        );
      }
      if (!uploadResult.data.dek) {
        return this.fail("SECRET_MISSING", "\u4E91\u7AEF DEK \u521D\u59CB\u5316\u54CD\u5E94\u7F3A\u5C11\u79C1\u94A5");
      }
      this.setRuntimeSecret(uploadResult.data.dek, userId);
      return this.ok({
        userId,
        source: "created",
        initialized: true,
        dek: uploadResult.data.dek,
        requiresBackup: true
      });
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async getDeviceKeyState(userId) {
    const stateVersion = this.destroyVersion;
    try {
      await this.sdk.init();
      this.assertStateVersion(stateVersion);
      this.assertTokenReady();
      const resolvedUserId = this.resolveDekInitUserId(userId);
      const activeDeviceKey = this.getCurrentSecret(resolvedUserId);
      if (activeDeviceKey) {
        return this.ok({
          userId: resolvedUserId,
          status: "ready",
          hasDek: true,
          source: "memory",
          initialized: true,
          dek: activeDeviceKey
        });
      }
      const cloudResult = await this.getCloudDeviceKey(resolvedUserId);
      this.assertStateVersion(stateVersion);
      if (!cloudResult.ok) {
        return this.fail(
          cloudResult.code,
          cloudResult.message,
          cloudResult.details
        );
      }
      if (cloudResult.data.dek) {
        this.setRuntimeSecret(cloudResult.data.dek, resolvedUserId);
        return this.ok({
          userId: cloudResult.data.userId,
          status: "ready",
          hasDek: true,
          source: "cloud",
          initialized: true,
          dek: cloudResult.data.dek
        });
      }
      return this.ok({
        userId: cloudResult.data.userId,
        status: "missing",
        hasDek: false,
        source: "cloud",
        initialized: false,
        dek: null
      });
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async getCloudDeviceKey(userId) {
    try {
      this.assertTokenReady();
      this.resolveDekInitUserId(userId);
      const response = await this.getAdapter().http.request({
        url: buildApiUrl3(this.options.apiBaseUrl, "/api/sdk/dek/current"),
        method: "GET",
        headers: this.createJsonHeaders()
      });
      return await this.consumeCloudDeviceKeyResponse(response);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async uploadCloudDeviceKey(deviceKey) {
    const stateVersion = this.destroyVersion;
    try {
      this.assertTokenReady();
      const userId = this.resolveDekInitUserId();
      if (!isDeviceKeyRecord(deviceKey)) {
        return this.fail("SECRET_MISSING", "\u79C1\u94A5\u7ED3\u6784\u4E0D\u5B8C\u6574\u6216\u683C\u5F0F\u4E0D\u6B63\u786E");
      }
      const response = await this.getAdapter().http.request({
        url: buildApiUrl3(this.options.apiBaseUrl, "/api/sdk/dek/current"),
        method: "POST",
        headers: this.createJsonHeaders(),
        body: JSON.stringify(deviceKey)
      });
      const result = await this.consumeCloudDeviceKeyResponse(response);
      this.assertStateVersion(stateVersion);
      if (result.ok && result.data.dek) {
        this.setRuntimeSecret(result.data.dek, userId);
      }
      return result;
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async resetCloudDeviceKey() {
    const stateVersion = this.destroyVersion;
    try {
      await this.sdk.init();
      this.assertStateVersion(stateVersion);
      this.assertTokenReady();
      const userId = this.resolveDekInitUserId();
      this.clearSecretState(userId);
      const generatedDeviceKey = await this.sdk.generateDeviceKey({
        userId,
        markInitialized: false,
        force: true
      });
      this.assertStateVersion(stateVersion);
      if (!generatedDeviceKey) {
        return this.fail("SECRET_MISSING", "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u79C1\u94A5\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
      const response = await this.getAdapter().http.request({
        url: buildApiUrl3(this.options.apiBaseUrl, "/api/sdk/dek/reset"),
        method: "POST",
        headers: this.createJsonHeaders(),
        body: JSON.stringify(generatedDeviceKey)
      });
      const resetResult = await this.consumeCloudDeviceKeyResponse(response);
      this.assertStateVersion(stateVersion);
      if (!resetResult.ok) {
        return this.fail(
          resetResult.code,
          resetResult.message,
          resetResult.details
        );
      }
      if (!resetResult.data.dek) {
        return this.fail("SECRET_MISSING", "\u4E91\u7AEF DEK \u91CD\u7F6E\u54CD\u5E94\u7F3A\u5C11\u79C1\u94A5");
      }
      this.setRuntimeSecret(resetResult.data.dek, userId);
      return this.ok({
        userId,
        source: "reset",
        initialized: true,
        dek: resetResult.data.dek,
        requiresBackup: true
      });
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  exportActiveDeviceKey() {
    const userId = this.resolveCurrentUserId();
    const activeDeviceKey = userId ? this.getCurrentSecret(userId) : null;
    return activeDeviceKey || this.sdk.getActiveDeviceKeyRecord();
  }
  buildDeviceKeyExportFileName(phone) {
    return buildDeviceKeyExportFileName(phone);
  }
  serializeDeviceKeyRecordAsJson(deviceKey) {
    try {
      return this.ok(serializeDeviceKeyRecordAsJson(deviceKey));
    } catch (error) {
      return this.fail(
        "SECRET_MISSING",
        normalizeDeviceKeyBackupErrorMessage(error, "\u79C1\u94A5\u7ED3\u6784\u4E0D\u5B8C\u6574\u6216\u683C\u5F0F\u4E0D\u6B63\u786E")
      );
    }
  }
  parseDeviceKeyRecordFromJson(rawValue) {
    try {
      return this.ok(parseDeviceKeyRecordFromJson(rawValue));
    } catch (error) {
      return this.fail(
        "SECRET_MISSING",
        normalizeDeviceKeyBackupErrorMessage(error, "\u79C1\u94A5\u5185\u5BB9\u7F3A\u5C11\u5FC5\u8981\u5B57\u6BB5\uFF0C\u65E0\u6CD5\u5B8C\u6210\u9A8C\u8BC1")
      );
    }
  }
  createDeviceKeyBackup(options = {}) {
    const deviceKey = options.deviceKey || this.exportActiveDeviceKey();
    if (!deviceKey) {
      return this.fail("SECRET_MISSING", "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u79C1\u94A5");
    }
    try {
      const normalizedDeviceKey = cloneDeviceKeyRecordForExport(deviceKey);
      const fileName = typeof options.fileName === "string" && options.fileName.trim() ? options.fileName.trim() : buildDeviceKeyExportFileName(options.phone);
      return this.ok({
        deviceKey: normalizedDeviceKey,
        json: serializeDeviceKeyRecordAsJson(normalizedDeviceKey),
        fileName
      });
    } catch (error) {
      return this.fail(
        "SECRET_MISSING",
        normalizeDeviceKeyBackupErrorMessage(error, "\u79C1\u94A5\u7ED3\u6784\u4E0D\u5B8C\u6574\u6216\u683C\u5F0F\u4E0D\u6B63\u786E")
      );
    }
  }
  async setToken(token, options) {
    const normalizedToken = normalizeToken2(token);
    if (!normalizedToken) {
      return this.fail("TOKEN_MISSING", "token \u4E0D\u80FD\u4E3A\u7A7A");
    }
    this.token = normalizedToken;
    if (options?.retryLastUnauthorized) {
      const retryResult = await this.retryLastUnauthorized();
      if (!retryResult.ok) {
        return this.fail(retryResult.code, retryResult.message, retryResult.details);
      }
    }
    return this.ok(void 0);
  }
  setSessionId(sessionId) {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return this.fail("SESSION_ID_REQUIRED", "sessionId \u4E0D\u80FD\u4E3A\u7A7A");
    }
    this.sessionId = normalizedSessionId;
    return this.ok(void 0);
  }
  setOptions(options) {
    const nextOptions = normalizeOptions({
      ...this.options,
      ...options
    });
    this.options = this.applyStreamReadableFallback(nextOptions);
    this.channel.setApiBaseUrl(this.options.apiBaseUrl);
    return this.ok(toPublicOptions(this.options));
  }
  async getDekInitState(userId) {
    try {
      this.assertTokenReady();
      this.resolveDekInitUserId(userId);
      const response = await this.getAdapter().http.request({
        url: buildApiUrl3(this.options.apiBaseUrl, "/api/sdk/dek/init"),
        method: "GET",
        headers: this.createJsonHeaders()
      });
      return await this.consumeDekInitResponse(response);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async setDekInitState(input = {}) {
    try {
      this.assertTokenReady();
      this.resolveDekInitUserId(input.userId);
      return this.fail(
        "UNSUPPORTED_OPERATION",
        "\u4E91\u7AEF DEK \u65B9\u6848\u4E0D\u518D\u652F\u6301\u624B\u52A8\u6807\u8BB0\u521D\u59CB\u5316\uFF0C\u8BF7\u8C03\u7528 sdk.helper.ensureCloudDeviceKey()",
        {
          replacement: "sdk.helper.ensureCloudDeviceKey()"
        }
      );
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async getSystemPrompts(options) {
    try {
      this.assertTokenReady();
      const promptOptions = this.normalizeSystemPromptOptions(options);
      const query = promptOptions.sessionId ? `?sessionId=${encodeURIComponent(promptOptions.sessionId)}` : "";
      const response = await this.getAdapter().http.request({
        url: buildApiUrl3(
          this.options.apiBaseUrl,
          `/api/sdk/system-prompts${query}`
        ),
        method: "GET",
        headers: this.createJsonHeaders()
      });
      return this.consumeSystemPromptResponse(response);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async setSystemPrompt(id, options) {
    try {
      this.assertTokenReady();
      const promptOptions = this.normalizeSystemPromptOptions(options);
      const response = await this.getAdapter().http.request({
        url: buildApiUrl3(
          this.options.apiBaseUrl,
          "/api/sdk/system-prompts/selection"
        ),
        method: "PUT",
        headers: this.createJsonHeaders(),
        body: JSON.stringify({
          id: id?.trim() || null,
          ...promptOptions.sessionId ? {
            sessionId: promptOptions.sessionId
          } : {}
        })
      });
      return this.consumeSystemPromptResponse(response);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async recognizeSpeech(audio, options) {
    const stateVersion = this.destroyVersion;
    let requestController;
    try {
      this.assertTokenReady();
      const userId = this.resolveDekInitUserId();
      await this.sdk.ensureReady();
      this.assertStateVersion(stateVersion);
      const encryptedAudio = await this.sdk.encryptBytes(audio);
      this.assertStateVersion(stateVersion);
      const buildTransport = () => this.sdk.buildAsrTransport({
        encryptedAudio,
        userId,
        asrModel: options?.asrModel
      });
      let transport = await buildTransport();
      this.assertStateVersion(stateVersion);
      const controller = this.createAbortController();
      requestController = controller;
      this.pendingAsrControllers.add(controller);
      let certificateRefreshRetried = false;
      for (; ; ) {
        let timedOut = false;
        const timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, DEFAULT_ASR_REQUEST_TIMEOUT_MS);
        let response;
        try {
          response = await this.getAdapter().http.request({
            url: buildApiUrl3(this.options.apiBaseUrl, "/api/internal/asr"),
            method: "POST",
            headers: this.createJsonHeaders(),
            body: JSON.stringify(transport),
            signal: controller.signal,
            timeoutMs: DEFAULT_ASR_REQUEST_TIMEOUT_MS
          });
        } catch (error) {
          if (timedOut) {
            throw new HelperFlowError(
              "NETWORK_ERROR",
              "\u8BED\u97F3\u8BC6\u522B\u8BF7\u6C42\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"
            );
          }
          this.assertStateVersion(stateVersion);
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
        this.assertStateVersion(stateVersion);
        if (response.status === 401) {
          return this.fail(
            "AUTH_UNAUTHORIZED",
            "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0 token \u540E\u91CD\u8BD5"
          );
        }
        if (!response.ok) {
          const errorInfo = await readResponseErrorInfo(response);
          if (this.shouldRetryWithFreshCpuTeeCertificate(
            errorInfo,
            certificateRefreshRetried
          )) {
            certificateRefreshRetried = true;
            if (await this.tryRefreshCpuTeeCertificate(controller.signal)) {
              this.assertStateVersion(stateVersion);
              transport = await buildTransport();
              this.assertStateVersion(stateVersion);
              continue;
            }
          }
          return this.fail(
            "NETWORK_ERROR",
            errorInfo.message,
            buildHttpErrorDetails(errorInfo)
          );
        }
        const payload = await response.json();
        this.assertStateVersion(stateVersion);
        const responseMessage = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : "\u8BED\u97F3\u8BC6\u522B\u5931\u8D25";
        if (payload.code === 2006) {
          return this.fail("NO_SPEECH", responseMessage, payload);
        }
        if (payload.code !== 0) {
          if (!certificateRefreshRetried && shouldRetryAsrWithFreshCpuTeeCertificate(payload)) {
            certificateRefreshRetried = true;
            if (await this.tryRefreshCpuTeeCertificate(controller.signal)) {
              this.assertStateVersion(stateVersion);
              transport = await buildTransport();
              this.assertStateVersion(stateVersion);
              continue;
            }
          }
          return this.fail("NETWORK_ERROR", responseMessage, payload);
        }
        const encryptedText = typeof payload.data?.encrypted_asr_text === "string" ? payload.data.encrypted_asr_text.trim() : "";
        if (!encryptedText) {
          return this.fail(
            "NETWORK_ERROR",
            "\u8BED\u97F3\u8BC6\u522B\u54CD\u5E94\u7F3A\u5C11\u8F6C\u5199\u5BC6\u6587",
            payload
          );
        }
        let text;
        try {
          text = (await this.sdk.decryptText(encryptedText)).trim();
        } catch (error) {
          throw new HelperFlowError(
            "DECRYPT_FAILED",
            "\u8BED\u97F3\u8BC6\u522B\u7ED3\u679C\u89E3\u5BC6\u5931\u8D25\uFF0C\u8BF7\u786E\u8BA4\u5F53\u524D\u79C1\u94A5\u662F\u5426\u5339\u914D",
            normalizeErrorDetails(error)
          );
        }
        this.assertStateVersion(stateVersion);
        if (!text) {
          return this.fail("NO_SPEECH", "\u672A\u8BC6\u522B\u5230\u6709\u6548\u6587\u5B57\uFF0C\u8BF7\u91CD\u65B0\u5F55\u5165");
        }
        return this.ok({
          text,
          ...typeof payload.request_id === "string" && payload.request_id.trim() ? { requestId: payload.request_id.trim() } : {},
          ...typeof payload.data?.asr_model === "string" && payload.data.asr_model.trim() ? { asrModel: payload.data.asr_model.trim() } : {}
        });
      }
    } catch (error) {
      const sdkErrorCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (sdkErrorCode === "PLAINTEXT_MODE_UNSUPPORTED") {
        return this.fail(
          "UNSUPPORTED_OPERATION",
          "\u5F53\u524D\u660E\u6587\u8054\u8C03\u6A21\u5F0F\u4E0D\u652F\u6301\u5BC6\u6001 ASR"
        );
      }
      if (sdkErrorCode === "DEVICE_KEY_UNAVAILABLE") {
        return this.fail("SECRET_MISSING", "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u79C1\u94A5");
      }
      return this.errorToResult(error);
    } finally {
      if (requestController) {
        this.pendingAsrControllers.delete(requestController);
      }
    }
  }
  async uploadFile(files, options) {
    const stateVersion = this.destroyVersion;
    const uploadId = createUploadFileId();
    const uploadContexts = files.map(
      (file, index) => createRawUploadFileStatusContext(uploadId, file, index, options)
    );
    const limits = resolveAttachmentLimits(this.options, options);
    const uploadItems = [];
    const attachments = [];
    const settledFileIds = /* @__PURE__ */ new Set();
    const failContext = (context, error) => {
      if (settledFileIds.has(context.fileId)) {
        return;
      }
      const flowError = normalizeHelperFlowError(error);
      this.emitUploadFileStatus(context, {
        stage: "failed",
        status: "failed",
        message: flowError.message,
        errorCode: flowError.code,
        errorDetails: flowError.details
      });
      uploadItems.push(createUploadFileFailedItem(context, flowError));
      settledFileIds.add(context.fileId);
    };
    const completeSuccess = (context, attachment) => {
      if (settledFileIds.has(context.fileId)) {
        return;
      }
      attachments.push(attachment);
      uploadItems.push(createUploadFileSuccessItem(context, attachment));
      settledFileIds.add(context.fileId);
    };
    const completeSkipped = (context, message) => {
      if (settledFileIds.has(context.fileId)) {
        return;
      }
      uploadItems.push(createUploadFileSkippedItem(context, message));
      settledFileIds.add(context.fileId);
    };
    const toResult = () => this.ok(createUploadFileResult(uploadId, uploadItems, attachments));
    try {
      uploadContexts.forEach((context) => {
        this.emitUploadFileStatus(context, {
          stage: "validating",
          status: "processing",
          message: "\u6B63\u5728\u6821\u9A8C\u6587\u4EF6\u6570\u91CF\u3001\u5927\u5C0F\u548C\u7C7B\u578B"
        });
      });
      try {
        assertFileCount(files, limits);
      } catch (error) {
        uploadContexts.forEach((context) => {
          failContext(context, error);
        });
        return toResult();
      }
      const uploadQueue = [];
      for (const [index, file] of files.entries()) {
        let context = uploadContexts[index];
        try {
          const normalizedFile = await this.normalizeUploadFileInput(file);
          context = createUploadFileStatusContext(
            uploadId,
            normalizedFile,
            index,
            options
          );
          uploadContexts[index] = context;
          assertFileList([normalizedFile], limits);
          this.emitUploadFileStatus(context, {
            stage: "type_checked",
            status: "success",
            message: "\u6587\u4EF6\u7C7B\u578B\u6821\u9A8C\u901A\u8FC7"
          });
          uploadQueue.push({ file: normalizedFile, context });
        } catch (error) {
          failContext(context, error);
        }
      }
      if (uploadQueue.length === 0) {
        return toResult();
      }
      try {
        this.assertTokenReady();
        await this.assertSecretReady();
        this.assertStateVersion(stateVersion);
      } catch (error) {
        if (!this.isStateVersionCurrent(stateVersion)) {
          return toResult();
        }
        uploadQueue.forEach(({ context }) => {
          failContext(context, error);
        });
        return toResult();
      }
      const uploadedDedupeKeys = /* @__PURE__ */ new Set();
      for (const { file, context } of uploadQueue) {
        try {
          this.emitUploadFileStatus(context, {
            stage: "fingerprinting",
            status: "processing",
            message: "\u6B63\u5728\u8BA1\u7B97\u6587\u4EF6\u6307\u7EB9"
          });
          const fingerprint = await this.computeFileFingerprintForUpload(file);
          this.assertStateVersion(stateVersion);
          if (uploadedDedupeKeys.has(fingerprint.dedupeKey)) {
            const message = "\u672C\u6B21\u9009\u62E9\u4E2D\u5B58\u5728\u91CD\u590D\u6587\u4EF6\uFF0C\u5DF2\u8DF3\u8FC7\u91CD\u590D\u4E0A\u4F20";
            this.emitUploadFileStatus(context, {
              stage: "reused",
              status: "success",
              message
            });
            this.emitUploadFileStatus(context, {
              stage: "completed",
              status: "completed",
              message: "\u91CD\u590D\u6587\u4EF6\u5904\u7406\u5B8C\u6210"
            });
            completeSkipped(context, message);
            continue;
          }
          const cachedAttachment = this.attachmentDedupeMap.get(
            fingerprint.dedupeKey
          );
          if (cachedAttachment) {
            const reusedAttachment = {
              ...cachedAttachment,
              reused: true
            };
            this.rememberUploadFileStatusContext(reusedAttachment, context);
            this.emitUploadFileStatus(context, {
              stage: "reused",
              status: "success",
              attachment: reusedAttachment,
              message: "\u547D\u4E2D\u672C\u5730\u9644\u4EF6\u7F13\u5B58\uFF0C\u590D\u7528\u5DF2\u4E0A\u4F20\u9644\u4EF6"
            });
            completeSuccess(context, reusedAttachment);
            uploadedDedupeKeys.add(fingerprint.dedupeKey);
            const attachmentStatusEmitted2 = this.emitAttachmentStatus(reusedAttachment);
            if (!attachmentStatusEmitted2) {
              this.emitUploadFileStatusFromAttachment(reusedAttachment, false);
            }
            this.watchAttachmentProcessingIfNeeded(
              reusedAttachment,
              options,
              stateVersion
            );
            continue;
          }
          this.emitUploadFileStatus(context, {
            stage: "encrypting",
            status: "processing",
            message: "\u6B63\u5728\u672C\u5730\u52A0\u5BC6\u9644\u4EF6"
          });
          const attachment = await this.uploadSingleFile(
            file,
            fingerprint,
            context,
            options
          );
          this.assertStateVersion(stateVersion);
          this.rememberAttachment(attachment, fingerprint.dedupeKey);
          this.rememberUploadFileStatusContext(attachment, context);
          this.emitUploadFileStatus(context, {
            stage: "uploaded",
            status: "success",
            attachment,
            message: "\u9644\u4EF6\u4E0A\u4F20\u5B8C\u6210"
          });
          completeSuccess(context, attachment);
          uploadedDedupeKeys.add(fingerprint.dedupeKey);
          const attachmentStatusEmitted = this.emitAttachmentStatus(attachment);
          if (!attachmentStatusEmitted) {
            this.emitUploadFileStatusFromAttachment(attachment, false);
          }
          this.watchAttachmentProcessingIfNeeded(
            attachment,
            options,
            stateVersion
          );
        } catch (error) {
          if (!this.isStateVersionCurrent(stateVersion)) {
            return toResult();
          }
          failContext(context, error);
        }
      }
      return toResult();
    } catch (error) {
      if (!this.isStateVersionCurrent(stateVersion)) {
        return toResult();
      }
      uploadContexts.forEach((context) => {
        failContext(context, error);
      });
      return toResult();
    }
  }
  getFileTypes() {
    return {
      extensions: [...CHAT_ATTACHMENT_EXTENSIONS],
      imageExtensions: [...CHAT_IMAGE_EXTENSIONS],
      fileExtensions: [...CHAT_FILE_EXTENSIONS],
      accept: CHAT_ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`).join(
        ","
      )
    };
  }
  async computeFileFingerprint(file) {
    try {
      const normalizedFile = await this.normalizeUploadFileInput(file);
      assertFileList([normalizedFile], this.options);
      return this.ok(await this.computeFileFingerprintForUpload(normalizedFile));
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async getAttachmentStatus(attachmentId) {
    try {
      this.assertTokenReady();
      const attachment = await this.fetchAttachmentStatus(attachmentId);
      this.rememberAttachment(attachment);
      this.emitAttachmentStatus(attachment);
      return this.ok(attachment);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async getAttachmentStatuses(attachmentIds) {
    try {
      this.assertTokenReady();
      const attachments = await this.fetchAttachmentStatuses(attachmentIds);
      attachments.forEach((attachment) => {
        this.rememberAttachment(attachment);
        this.emitAttachmentStatus(attachment);
      });
      return this.ok(attachments);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  removeFile(attachmentId) {
    try {
      const id = normalizeAttachmentId(attachmentId);
      this.removedAttachmentIds.add(id);
      this.attachmentMap.delete(id);
      this.attachmentProcessingWatchMap.delete(id);
      this.uploadFileStatusContextMap.delete(id);
      this.removeAttachmentDedupeEntries(id);
      return this.ok(void 0);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  removeAllFile() {
    try {
      this.attachmentMap.forEach((attachment) => {
        this.removedAttachmentIds.add(attachment.id);
      });
      this.attachmentDedupeMap.forEach((attachment) => {
        this.removedAttachmentIds.add(attachment.id);
      });
      this.attachmentProcessingWatchMap.forEach((entry, attachmentId) => {
        this.removedAttachmentIds.add(attachmentId);
        this.removedAttachmentIds.add(entry.current.id);
      });
      this.attachmentMap.clear();
      this.attachmentDedupeMap.clear();
      this.attachmentProcessingWatchMap.clear();
      this.uploadFileStatusContextMap.clear();
      return this.ok(void 0);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async sendMessage(input, options) {
    const mid = createMessageId();
    return this.sendMessageWithMid(mid, input, options);
  }
  async retryLastUnauthorized() {
    const retryableRequest = this.lastUnauthorizedRequest;
    if (!retryableRequest) {
      return this.fail(
        "AUTH_UNAUTHORIZED",
        "\u6CA1\u6709\u53EF\u91CD\u8BD5\u7684 401 \u8BF7\u6C42\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001\u6D88\u606F"
      );
    }
    this.lastUnauthorizedRequest = void 0;
    return retryableRequest.run();
  }
  cancel(mid) {
    if (mid) {
      const controller = this.pendingMap.get(mid);
      const sessionId = this.pendingSessionMap.get(mid) ?? this.resolveBusySessionIdForMid(mid);
      if (controller) {
        controller.abort();
      }
      if (sessionId) {
        this.markSessionRecentlyCanceled(sessionId);
        this.notifyServerCancel(sessionId);
      }
      this.pendingMap.delete(mid);
      this.pendingSessionMap.delete(mid);
      this.releaseBusySessionForMid(mid);
      this.clearLastUnauthorizedRequestForMid(mid);
      this.finishStatusRun(mid);
      return this.ok(void 0, mid);
    }
    const mids = Array.from(this.pendingMap.keys());
    const sessionIds = /* @__PURE__ */ new Set([
      ...Array.from(this.pendingSessionMap.values()),
      ...Array.from(this.busySessionMap.keys())
    ]);
    this.pendingMap.forEach((controller) => {
      controller.abort();
    });
    sessionIds.forEach((sessionId) => {
      this.markSessionRecentlyCanceled(sessionId);
      this.notifyServerCancel(sessionId);
    });
    this.pendingMap.clear();
    this.pendingSessionMap.clear();
    this.busySessionMap.clear();
    this.lastUnauthorizedRequest = void 0;
    mids.forEach((pendingMid) => {
      this.finishStatusRun(pendingMid);
    });
    this.statusRunMap.clear();
    return this.ok(void 0);
  }
  async getHistoryMessage(sessionId, page) {
    try {
      const targetSessionId = this.resolveSessionId(sessionId);
      const state = await this.resolveHistoryState(targetSessionId, {
        refresh: page?.refresh,
        sessionMode: page?.sessionMode
      });
      return {
        ...this.ok(sliceHistoryMessages(state.messages, page)),
        persistableItems: slicePersistableHistoryMessages(state, page)
      };
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  async setHistory(sessionId, wireMessages, options) {
    try {
      const targetSessionId = this.resolveSessionId(sessionId);
      const sessionMode = resolveHelperSessionMode(
        targetSessionId,
        options?.sessionMode ?? this.options.sessionMode
      );
      const normalizedWireMessages = Array.isArray(wireMessages) ? [...wireMessages] : [];
      const currentState = this.historyMap.get(targetSessionId);
      const historySource = historySourceFromSessionMode(sessionMode);
      if (currentState && currentState.source === historySource && hasSameWireMessageRefs(currentState.wireMessages, normalizedWireMessages)) {
        return this.ok(currentState);
      }
      const messages = await Promise.all(
        normalizedWireMessages.map((item) => this.decryptHistoryMessage(item))
      );
      const state = createHistoryState(
        targetSessionId,
        historySource,
        messages,
        normalizedWireMessages
      );
      this.historyMap.set(targetSessionId, state);
      return this.ok(state);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  clearHistory(sessionId) {
    try {
      const targetSessionId = this.resolveSessionId(sessionId);
      this.historyMap.delete(targetSessionId);
      return this.ok(void 0);
    } catch (error) {
      return this.errorToResult(error);
    }
  }
  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }
  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
  onAttachmentStatus(listener) {
    this.attachmentStatusListeners.add(listener);
    return () => {
      this.attachmentStatusListeners.delete(listener);
    };
  }
  onUploadFile(listener) {
    this.uploadFileStatusListeners.add(listener);
    return () => {
      this.uploadFileStatusListeners.delete(listener);
    };
  }
  destroy() {
    this.destroyVersion += 1;
    this.cancel();
    this.pendingAsrControllers.forEach((controller) => controller.abort());
    this.pendingAsrControllers.clear();
    this.analytics.destroy();
    this.clearSecretState(this.dekUserId || this.resolveCurrentUserId());
    this.token = void 0;
    this.historyMap.clear();
    this.attachmentMap.clear();
    this.attachmentDedupeMap.clear();
    this.messageListeners.clear();
    this.statusListeners.clear();
    this.attachmentStatusListeners.clear();
    this.uploadFileStatusListeners.clear();
    this.uploadFileStatusContextMap.clear();
    this.attachmentProcessingWatchMap.clear();
    this.removedAttachmentIds.clear();
    this.attachmentProcessingWatcher = void 0;
    this.statusRunMap.clear();
    this.pendingMap.clear();
    this.pendingSessionMap.clear();
    this.busySessionMap.clear();
    this.recentCanceledSessionMap.clear();
    this.lastUnauthorizedRequest = void 0;
    this.streamReadableUnsupported = false;
    this.sessionId = void 0;
    return this.ok(void 0);
  }
  destory() {
    return this.destroy();
  }
  unmount() {
    return this.destroy();
  }
  async sendMessageWithMid(mid, input, options) {
    let sessionId = "";
    try {
      sessionId = this.resolveSessionId();
      if (this.busySessionMap.has(sessionId)) {
        return this.fail(
          "SESSION_BUSY",
          "\u5F53\u524D\u4F1A\u8BDD\u6B63\u5728\u751F\u6210\u56DE\u590D\uFF0C\u8BF7\u7A0D\u540E\u518D\u53D1\u9001",
          void 0,
          mid
        );
      }
      this.assertTokenReady();
      this.startStatusRun(mid);
      this.emitStatus(mid, sessionId, "submit_question");
      const controller = this.createAbortController();
      this.pendingMap.set(mid, controller);
      this.pendingSessionMap.set(mid, sessionId);
      this.busySessionMap.set(sessionId, mid);
      let requestOptions = normalizeOptions({
        ...this.options,
        ...options
      });
      const streamFallbackApplied = requestOptions.stream && (this.streamReadableUnsupported || !this.getAdapter().stream.supportsStream());
      if (streamFallbackApplied) {
        this.disableStreamReadableFallback();
      }
      requestOptions = this.applyStreamReadableFallback(requestOptions);
      const sessionMode = resolveHelperSessionMode(
        sessionId,
        requestOptions.sessionMode
      );
      this.assertModelReady(requestOptions);
      this.emitStatus(mid, sessionId, "local_encrypt_attest");
      await this.assertSecretReady();
      const preparedMessage = await this.prepareMessage(
        mid,
        sessionId,
        input,
        requestOptions,
        controller.signal,
        sessionMode,
        streamFallbackApplied
      );
      return await this.executePreparedMessage(preparedMessage, controller);
    } catch (error) {
      if (error instanceof HelperFlowError && error.code === "AUTH_UNAUTHORIZED") {
        this.lastUnauthorizedRequest = {
          mid,
          run: () => this.sendMessageWithMid(mid, input, options)
        };
      }
      return this.errorToResult(error, mid);
    } finally {
      this.pendingMap.delete(mid);
      this.pendingSessionMap.delete(mid);
      if (sessionId && this.busySessionMap.get(sessionId) === mid) {
        this.busySessionMap.delete(sessionId);
      }
      this.finishStatusRun(mid);
    }
  }
  async executePreparedMessage(preparedMessage, controller) {
    try {
      assertNotCanceled(controller.signal);
      this.emitStatus(
        preparedMessage.mid,
        preparedMessage.sessionId,
        "cpu_tee_processing"
      );
      if (preparedMessage.streamFallbackApplied) {
        this.emitStreamFallbackStatus(preparedMessage);
      }
      const state = await this.resolveHistoryState(preparedMessage.sessionId, {
        sessionMode: preparedMessage.sessionMode
      });
      const { messages } = await this.sdk.buildConversationMessages({
        history: state.wireMessages,
        currentUserMessage: preparedMessage.wireQuestion,
        maxRounds: preparedMessage.options.chatContextLimit
      });
      const buildPayload = async () => {
        const generationTransport = await this.sdk.buildGenerationTransport({
          encryptedUserData: preparedMessage.encryptedUserData,
          sessionId: preparedMessage.sessionId
        });
        return {
          ...buildChatPayloadOptions(preparedMessage.options),
          messages,
          generation_transport: generationTransport,
          ...preparedMessage.sessionMode === "temporary" ? {
            draftSessionId: preparedMessage.sessionId
          } : {}
        };
      };
      let payload = await buildPayload();
      let certificateRefreshRetried = false;
      const path = preparedMessage.sessionMode === "temporary" ? "/api/chat/completions" : `/api/chat/sessions/${encodeURIComponent(
        preparedMessage.sessionId
      )}/messages`;
      for (let attemptIndex = 0; ; attemptIndex += 1) {
        assertNotCanceled(controller.signal);
        const response = await this.fetchChat(
          path,
          payload,
          preparedMessage,
          controller
        );
        if (response.status === 401) {
          this.lastUnauthorizedRequest = {
            mid: preparedMessage.mid,
            run: () => this.retryPreparedMessage(preparedMessage)
          };
          return this.fail(
            "AUTH_UNAUTHORIZED",
            "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0 token \u540E\u91CD\u8BD5",
            void 0,
            preparedMessage.mid
          );
        }
        if (!response.ok) {
          const errorInfo = await readResponseErrorInfo(response);
          if (this.shouldRetryServerBusy(
            preparedMessage.sessionId,
            errorInfo,
            attemptIndex
          )) {
            await delayWithAbort(
              SERVER_BUSY_RETRY_DELAYS_MS[attemptIndex],
              controller.signal
            );
            continue;
          }
          if (errorInfo.code === "INFERENCE_BUSY") {
            this.emitInferenceBusyStatus(preparedMessage, errorInfo.details);
          }
          if (this.shouldRetryWithFreshCpuTeeCertificate(
            errorInfo,
            certificateRefreshRetried
          )) {
            const refreshed = await this.tryRefreshCpuTeeCertificate(
              controller.signal
            );
            certificateRefreshRetried = true;
            if (refreshed) {
              payload = await buildPayload();
              continue;
            }
          }
          return this.fail(
            errorInfo.code,
            errorInfo.message,
            buildHttpErrorDetails(errorInfo),
            preparedMessage.mid
          );
        }
        this.emitStatus(
          preparedMessage.mid,
          preparedMessage.sessionId,
          "gpu_cipher_computing"
        );
        const contentType = getResponseHeader(response, "content-type")?.toLowerCase() || "";
        if (preparedMessage.options.stream && contentType.includes("text/event-stream") && !isResponseStreamReadable(response)) {
          this.disableStreamReadableFallback();
          this.emitStreamFallbackStatus(preparedMessage);
          return this.fail(
            "STREAM_ERROR",
            "\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u6D41\u5F0F\u8BFB\u53D6",
            void 0,
            preparedMessage.mid
          );
        }
        const result = contentType.includes("text/event-stream") ? await this.consumeStreamResponse(
          response,
          preparedMessage,
          controller.signal
        ) : await this.consumeJsonResponse(response, preparedMessage);
        if (result.ok) {
          this.recentCanceledSessionMap.delete(preparedMessage.sessionId);
          return result;
        }
        if (this.shouldRetryServerBusy(
          preparedMessage.sessionId,
          resultToHttpErrorInfo(result),
          attemptIndex
        )) {
          await delayWithAbort(
            SERVER_BUSY_RETRY_DELAYS_MS[attemptIndex],
            controller.signal
          );
          continue;
        }
        if (result.code === "INFERENCE_BUSY") {
          this.emitInferenceBusyStatus(preparedMessage, result.details);
        }
        return result;
      }
    } catch (error) {
      if (error instanceof HelperFlowError && error.code === "AUTH_UNAUTHORIZED") {
        this.lastUnauthorizedRequest = {
          mid: preparedMessage.mid,
          run: () => this.retryPreparedMessage(preparedMessage)
        };
      }
      return this.errorToResult(error, preparedMessage.mid);
    }
  }
  async retryPreparedMessage(preparedMessage) {
    if (this.busySessionMap.has(preparedMessage.sessionId)) {
      return this.fail(
        "SESSION_BUSY",
        "\u5F53\u524D\u4F1A\u8BDD\u6B63\u5728\u751F\u6210\u56DE\u590D\uFF0C\u8BF7\u7A0D\u540E\u518D\u53D1\u9001",
        void 0,
        preparedMessage.mid
      );
    }
    const controller = this.createAbortController();
    this.startStatusRun(preparedMessage.mid);
    this.pendingMap.set(preparedMessage.mid, controller);
    this.pendingSessionMap.set(
      preparedMessage.mid,
      preparedMessage.sessionId
    );
    this.busySessionMap.set(preparedMessage.sessionId, preparedMessage.mid);
    try {
      return await this.executePreparedMessage(preparedMessage, controller);
    } finally {
      this.pendingMap.delete(preparedMessage.mid);
      this.pendingSessionMap.delete(preparedMessage.mid);
      if (this.busySessionMap.get(preparedMessage.sessionId) === preparedMessage.mid) {
        this.busySessionMap.delete(preparedMessage.sessionId);
      }
      this.finishStatusRun(preparedMessage.mid);
    }
  }
  async prepareMessage(mid, sessionId, input, options, signal, sessionMode, streamFallbackApplied) {
    const normalizedInput = normalizeMessageInput(input);
    const attachments = await this.resolveAttachments(
      normalizedInput.files,
      options
    );
    const content = [];
    const plainContent = [];
    let encryptedUserData = "";
    assertNotCanceled(signal);
    if (normalizedInput.text.trim()) {
      this.emitStatus(mid, sessionId, "local_encrypt_attest");
      encryptedUserData = await this.sdk.encryptText(normalizedInput.text);
      content.push({
        type: "text",
        text: encryptedUserData
      });
      plainContent.push({
        type: "text",
        text: normalizedInput.text
      });
    }
    for (const attachment of attachments) {
      const fileBlock = createWireFileBlock(attachment);
      content.push(fileBlock);
      plainContent.push(createPlainFileBlock(attachment));
    }
    if (!encryptedUserData && attachments.length > 0) {
      this.emitStatus(mid, sessionId, "local_encrypt_attest");
      encryptedUserData = await this.sdk.encryptText(
        ATTACHMENT_ONLY_TRANSPORT_PROMPT
      );
    }
    if (content.length === 0 || !encryptedUserData) {
      throw new HelperFlowError(
        "INVALID_MESSAGE",
        "\u6D88\u606F\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u8BF7\u8F93\u5165\u6587\u672C\u6216\u9009\u62E9\u9644\u4EF6"
      );
    }
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const question = {
      id: `${mid}_user`,
      role: "user",
      content: plainContent,
      requestId: null,
      tokenCount: null,
      createdAt
    };
    const wireQuestion = {
      id: question.id,
      role: "user",
      content,
      requestId: null,
      tokenCount: null,
      createdAt
    };
    return {
      mid,
      sessionId,
      sessionMode,
      question,
      wireQuestion,
      encryptedUserData,
      options,
      streamFallbackApplied
    };
  }
  async consumeJsonResponse(response, preparedMessage) {
    const payload = await response.json();
    const assistantWireMessage = payload.assistantMessage;
    if (!assistantWireMessage) {
      return this.fail(
        "NETWORK_ERROR",
        "\u804A\u5929\u63A5\u53E3\u8FD4\u56DE\u7F3A\u5C11 assistantMessage",
        payload,
        preparedMessage.mid
      );
    }
    assistantWireMessage.webSearchSources = normalizeWebSearchSources(
      assistantWireMessage.webSearchSources ?? payload.webSearchSources
    );
    this.emitStatus(
      preparedMessage.mid,
      preparedMessage.sessionId,
      "ciphertext_returned"
    );
    const userWireMessage = payload.userMessage ?? {
      ...preparedMessage.wireQuestion,
      requestId: preparedMessage.wireQuestion.requestId ?? assistantWireMessage.requestId ?? payload.upstreamRequestId ?? null
    };
    const question = {
      ...preparedMessage.question,
      id: userWireMessage.id ?? preparedMessage.question.id,
      requestId: userWireMessage.requestId ?? assistantWireMessage.requestId ?? payload.upstreamRequestId ?? null,
      tokenCount: userWireMessage.tokenCount ?? null,
      sequenceNo: userWireMessage.sequenceNo ?? null,
      createdAt: userWireMessage.createdAt ?? preparedMessage.question.createdAt
    };
    const answer = await this.decryptHistoryMessage(assistantWireMessage);
    const wireMessages = [userWireMessage, assistantWireMessage];
    this.appendHistory(
      preparedMessage.sessionId,
      [question, answer],
      wireMessages,
      preparedMessage.sessionMode
    );
    this.emitStatus(
      preparedMessage.mid,
      preparedMessage.sessionId,
      "local_decrypt"
    );
    this.emitMessage({
      mid: preparedMessage.mid,
      sessionId: preparedMessage.sessionId,
      done: true,
      content: collectPlainText(answer.content),
      reasoning: collectPlainText(answer.reasoning ?? []),
      question,
      answer,
      wireQuestion: userWireMessage,
      wireAnswer: assistantWireMessage,
      wireMessages,
      webSearchSources: answer.webSearchSources ?? [],
      timestamp: Date.now()
    });
    return this.ok(
      {
        mid: preparedMessage.mid,
        sessionId: preparedMessage.sessionId,
        stream: false,
        question,
        answer,
        wireQuestion: userWireMessage,
        wireAnswer: assistantWireMessage,
        wireMessages,
        usage: payload.usage,
        requestId: payload.upstreamRequestId ?? assistantWireMessage.requestId ?? null,
        webSearchSources: answer.webSearchSources ?? []
      },
      preparedMessage.mid
    );
  }
  async consumeStreamResponse(response, preparedMessage, signal) {
    let startedUserWireMessage = null;
    let assistantPlaceholder = null;
    let assistantWireMessage = null;
    let usage;
    let upstreamRequestId = null;
    const contentDeltas = [];
    const reasoningDeltas = [];
    let plainContent = "";
    let plainReasoning = "";
    let streamCiphertextReturnedEmitted = false;
    const emitStreamCiphertextReturned = () => {
      if (streamCiphertextReturnedEmitted) {
        return;
      }
      streamCiphertextReturnedEmitted = true;
      this.emitStatus(
        preparedMessage.mid,
        preparedMessage.sessionId,
        "ciphertext_returned"
      );
    };
    try {
      this.emitMessage({
        mid: preparedMessage.mid,
        sessionId: preparedMessage.sessionId,
        done: false,
        content: "",
        reasoning: "",
        question: preparedMessage.question,
        timestamp: Date.now()
      });
      for await (const event of parsePrivateChatSse(response, signal)) {
        assertNotCanceled(signal);
        if (event.type === "error") {
          const message = event.message || "\u6D41\u5F0F\u54CD\u5E94\u5931\u8D25";
          const streamErrorDetails = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details : {};
          throw new HelperFlowError(
            streamErrorDetails.code === "INFERENCE_BUSY" ? "INFERENCE_BUSY" : isServerSessionBusyError(409, message) ? "SESSION_BUSY" : "STREAM_ERROR",
            message,
            streamErrorDetails.code === "INFERENCE_BUSY" ? normalizeInferenceBusyDetails(
              streamErrorDetails.error ?? streamErrorDetails
            ) : event.details
          );
        }
        if (event.type === "started") {
          startedUserWireMessage = event.userMessage;
          assistantPlaceholder = event.assistantMessage;
          continue;
        }
        if (event.type === "queued") {
          this.emitQueueStatus(preparedMessage, event);
          continue;
        }
        if (event.type === "reasoning_delta" || event.type === "content_delta") {
          const decryptedDelta = await this.decryptTextDelta(event.encryptedText);
          if (decryptedDelta.length > 0) {
            emitStreamCiphertextReturned();
          }
          if (event.type === "reasoning_delta") {
            reasoningDeltas.push(event.encryptedText);
            plainReasoning += decryptedDelta;
            this.emitMessage({
              mid: preparedMessage.mid,
              sessionId: preparedMessage.sessionId,
              done: false,
              content: plainContent,
              reasoning: plainReasoning,
              reasoningDelta: decryptedDelta,
              question: preparedMessage.question,
              timestamp: Date.now()
            });
          } else {
            contentDeltas.push(event.encryptedText);
            plainContent += decryptedDelta;
            this.emitMessage({
              mid: preparedMessage.mid,
              sessionId: preparedMessage.sessionId,
              done: false,
              content: plainContent,
              contentDelta: decryptedDelta,
              reasoning: plainReasoning,
              question: preparedMessage.question,
              timestamp: Date.now()
            });
          }
          continue;
        }
        if (event.type === "completed") {
          emitStreamCiphertextReturned();
          assistantWireMessage = await this.compactStreamAssistantMessage(
            event.assistantMessage,
            contentDeltas,
            reasoningDeltas,
            event.upstreamRequestId ?? null,
            event.usage
          );
          assistantWireMessage.webSearchSources = normalizeWebSearchSources(
            assistantWireMessage.webSearchSources ?? event.webSearchSources ?? event.assistantMessage.webSearchSources
          );
          usage = event.usage;
          upstreamRequestId = event.upstreamRequestId ?? event.assistantMessage.requestId ?? assistantWireMessage.requestId ?? null;
        }
      }
      assertNotCanceled(signal);
      if (!assistantWireMessage && assistantPlaceholder) {
        assistantWireMessage = assistantPlaceholder;
      }
      if (!assistantWireMessage) {
        throw new HelperFlowError("STREAM_ERROR", "\u6D41\u5F0F\u54CD\u5E94\u672A\u8FD4\u56DE\u5B8C\u6574\u56DE\u7B54");
      }
      const userWireMessage = startedUserWireMessage ?? {
        ...preparedMessage.wireQuestion,
        requestId: preparedMessage.wireQuestion.requestId ?? assistantWireMessage.requestId ?? upstreamRequestId ?? null
      };
      const question = {
        ...preparedMessage.question,
        id: userWireMessage.id ?? preparedMessage.question.id,
        requestId: userWireMessage.requestId ?? assistantWireMessage.requestId ?? upstreamRequestId ?? null,
        tokenCount: userWireMessage.tokenCount ?? null,
        sequenceNo: userWireMessage.sequenceNo ?? null,
        createdAt: userWireMessage.createdAt ?? preparedMessage.question.createdAt
      };
      const answer = await this.decryptHistoryMessage(assistantWireMessage);
      const finalContent = collectPlainText(answer.content);
      const finalReasoning = collectPlainText(answer.reasoning ?? []);
      const wireMessages = [userWireMessage, assistantWireMessage];
      this.appendHistory(
        preparedMessage.sessionId,
        [question, answer],
        wireMessages,
        preparedMessage.sessionMode
      );
      this.emitStatus(
        preparedMessage.mid,
        preparedMessage.sessionId,
        "local_decrypt"
      );
      this.emitMessage({
        mid: preparedMessage.mid,
        sessionId: preparedMessage.sessionId,
        done: true,
        content: finalContent || plainContent,
        reasoning: finalReasoning || plainReasoning,
        question,
        answer,
        wireQuestion: userWireMessage,
        wireAnswer: assistantWireMessage,
        wireMessages,
        webSearchSources: answer.webSearchSources ?? [],
        timestamp: Date.now()
      });
      return this.ok(
        {
          mid: preparedMessage.mid,
          sessionId: preparedMessage.sessionId,
          stream: true,
          question,
          answer,
          wireQuestion: userWireMessage,
          wireAnswer: assistantWireMessage,
          wireMessages,
          usage,
          requestId: upstreamRequestId,
          webSearchSources: answer.webSearchSources ?? []
        },
        preparedMessage.mid
      );
    } catch (error) {
      if (isCanceledError(error)) {
        const userWireMessage = startedUserWireMessage ?? void 0;
        const question = userWireMessage ? {
          ...preparedMessage.question,
          id: userWireMessage.id ?? preparedMessage.question.id,
          requestId: userWireMessage.requestId ?? null,
          tokenCount: userWireMessage.tokenCount ?? null,
          sequenceNo: userWireMessage.sequenceNo ?? null,
          createdAt: userWireMessage.createdAt ?? preparedMessage.question.createdAt
        } : preparedMessage.question;
        this.emitMessage({
          mid: preparedMessage.mid,
          sessionId: preparedMessage.sessionId,
          done: true,
          canceled: true,
          content: plainContent,
          reasoning: plainReasoning,
          question,
          ...userWireMessage ? {
            wireQuestion: userWireMessage,
            wireMessages: [userWireMessage]
          } : {},
          timestamp: Date.now()
        });
      }
      return this.errorToResult(error, preparedMessage.mid);
    }
  }
  async compactStreamAssistantMessage(assistantMessage, contentDeltas, reasoningDeltas, requestId, usage) {
    if (contentDeltas.length === 0 && reasoningDeltas.length === 0) {
      return assistantMessage;
    }
    const compacted = await this.sdk.compactStreamedAssistantMessage({
      contentDeltas,
      reasoningDeltas,
      requestId: requestId ?? assistantMessage.requestId ?? null,
      tokenCount: usage?.outputTokens ?? assistantMessage.tokenCount ?? null,
      createdAt: assistantMessage.createdAt
    });
    return {
      ...assistantMessage,
      ...compacted.message,
      id: assistantMessage.id,
      sequenceNo: assistantMessage.sequenceNo
    };
  }
  async fetchChat(path, payload, preparedMessage, controller) {
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, preparedMessage.options.requestTimeoutMs);
    const adapter = this.getAdapter();
    const request = {
      url: buildApiUrl3(preparedMessage.options.apiBaseUrl, path),
      method: "POST",
      headers: this.createJsonHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
      timeoutMs: preparedMessage.options.requestTimeoutMs
    };
    const shouldUseStreamAdapter = preparedMessage.options.stream && adapter.stream.supportsStream() && typeof adapter.stream.requestStream === "function";
    try {
      return await (shouldUseStreamAdapter ? adapter.stream.requestStream(request) : adapter.http.request(request));
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HelperFlowError("CANCELED", "\u8BF7\u6C42\u5DF2\u53D6\u6D88");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  notifyServerCancel(sessionId) {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }
    let headers;
    try {
      headers = this.createJsonHeaders();
    } catch {
      return;
    }
    const sessionMode = resolveHelperSessionMode(
      normalizedSessionId,
      this.options.sessionMode
    );
    const path = sessionMode === "temporary" ? "/api/chat/completions/cancel" : `/api/chat/sessions/${encodeURIComponent(
      normalizedSessionId
    )}/messages/cancel`;
    const body = sessionMode === "temporary" ? { draftSessionId: normalizedSessionId } : {};
    void this.getAdapter().http.request({
      url: buildApiUrl3(this.options.apiBaseUrl, path),
      method: "POST",
      headers,
      body: JSON.stringify(body)
    }).catch(() => void 0);
  }
  async normalizeUploadFileInput(file) {
    if (isFileLike(file)) {
      const fileName2 = file.name.trim() || "attachment";
      const fileType2 = file.type || "application/octet-stream";
      const bytes2 = new Uint8Array(await file.arrayBuffer());
      const extension2 = getFileExtension(fileName2);
      return {
        input: file,
        fileName: fileName2,
        fileType: fileType2,
        fileSize: bytes2.byteLength,
        kind: resolveAttachmentKind({
          fileName: fileName2,
          fileType: fileType2,
          extension: extension2
        }),
        extension: extension2,
        bytes: bytes2
      };
    }
    if (!isMiniappFileInput(file)) {
      throw new HelperFlowError(
        "ATTACHMENT_METADATA_MISSING",
        "\u9644\u4EF6\u6587\u4EF6\u4FE1\u606F\u4E0D\u5B8C\u6574"
      );
    }
    const adapter = this.getAdapter();
    const readFile = adapter.upload?.readFile;
    if (!readFile) {
      throw new HelperFlowError(
        "UNSUPPORTED_OPERATION",
        "\u5F53\u524D SDK adapter \u4E0D\u652F\u6301\u8BFB\u53D6\u5C0F\u7A0B\u5E8F\u4E34\u65F6\u6587\u4EF6"
      );
    }
    const fileName = file.name.trim();
    const fileType = file.type?.trim() || "application/octet-stream";
    const extension = getFileExtension(fileName);
    const bytes = toUint8Array(await readFile(file.path.trim()));
    return {
      input: file,
      fileName,
      fileType,
      fileSize: bytes.byteLength,
      kind: resolveAttachmentKind({
        fileName,
        fileType,
        extension
      }),
      extension,
      bytes
    };
  }
  async computeFileFingerprintForUpload(file) {
    const fileName = file.fileName;
    const fileType = file.fileType;
    const fileSize = file.fileSize;
    const rawFingerprint = await sm3Hex(file.bytes);
    const userId = this.sdk.getUserId?.().trim() || "";
    const fileFingerprint = userId ? await sm3Hex(
      `${FILE_FINGERPRINT_VERSION}:${userId}:${rawFingerprint}`
    ) : void 0;
    const localFingerprint = fileFingerprint ?? await sm3Hex(`local_sm3_v1:${rawFingerprint}`);
    return {
      fileName,
      fileType,
      fileSize,
      fileFingerprint,
      fingerprintVersion: FILE_FINGERPRINT_VERSION,
      dedupeKey: buildFileDedupeKey({
        fileName,
        fileType,
        fileSize,
        fingerprint: localFingerprint
      })
    };
  }
  rememberAttachment(attachment, dedupeKey) {
    this.removedAttachmentIds.delete(attachment.id);
    this.attachmentMap.set(attachment.id, attachment);
    if (dedupeKey) {
      this.attachmentDedupeMap.set(dedupeKey, attachment);
      return;
    }
    if (attachment.fileFingerprint) {
      this.attachmentDedupeMap.set(
        buildFileDedupeKey({
          fileName: attachment.fileName,
          fileType: attachment.fileType,
          fileSize: attachment.fileSize,
          fingerprint: attachment.fileFingerprint
        }),
        attachment
      );
    }
  }
  removeAttachmentDedupeEntries(attachmentId) {
    this.attachmentDedupeMap.forEach((attachment, dedupeKey) => {
      if (attachment.id === attachmentId) {
        this.attachmentDedupeMap.delete(dedupeKey);
      }
    });
  }
  async uploadSingleFile(file, fingerprint, statusContext, options) {
    const encryptedPayload = {
      encrypted_file_name: await this.sdk.encryptText(file.fileName),
      encrypted_file_type: await this.sdk.encryptText(file.fileType),
      encrypted_file_size: await this.sdk.encryptText(String(file.fileSize)),
      encrypted_file_bytes: await this.sdk.encryptBytes(file.bytes)
    };
    const formData = {
      fileName: file.fileName,
      fileType: file.fileType,
      fileSize: String(file.fileSize),
      kind: file.kind
    };
    if (fingerprint.fileFingerprint) {
      formData.fileFingerprint = fingerprint.fileFingerprint;
      formData.fingerprintVersion = fingerprint.fingerprintVersion;
    }
    if (options?.preprocess) {
      const sessionId = options.sessionId?.trim() || void 0;
      const transport = await this.sdk.buildGenerationTransport({
        encryptedUserData: encryptedPayload.encrypted_file_name,
        sessionId
      });
      formData.encryptedDek = transport.encrypted_dek;
      if (sessionId) {
        formData.sessionId = sessionId;
      }
      if (options.preprocessModel?.trim()) {
        formData.preprocessModel = options.preprocessModel.trim();
      }
    }
    this.emitUploadFileStatus(statusContext, {
      stage: "uploading",
      status: "processing",
      message: "\u6B63\u5728\u4E0A\u4F20\u52A0\u5BC6\u9644\u4EF6"
    });
    const adapter = this.getAdapter();
    const uploadAdapter = adapter.upload;
    if (!uploadAdapter) {
      throw new HelperFlowError(
        "UNSUPPORTED_OPERATION",
        "\u5F53\u524D SDK adapter \u4E0D\u652F\u6301\u9644\u4EF6\u4E0A\u4F20"
      );
    }
    const response = await uploadAdapter.upload({
      url: buildApiUrl3(this.options.apiBaseUrl, "/api/chat/attachments"),
      headers: this.createAuthHeaders(),
      ...adapter.platform === "browser" && typeof FormData !== "undefined" && typeof Blob !== "undefined" ? {
        file: createBrowserAttachmentFormData(
          encryptedPayload,
          formData
        )
      } : {
        file: JSON.stringify(encryptedPayload),
        fileName: "payload.json",
        name: "file",
        formData
      }
    });
    if (response.status === 401) {
      throw new HelperFlowError(
        "AUTH_UNAUTHORIZED",
        "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0 token \u540E\u91CD\u8BD5"
      );
    }
    if (!response.ok) {
      throw new HelperFlowError(
        "NETWORK_ERROR",
        await readResponseErrorMessage(response),
        {
          status: response.status
        }
      );
    }
    return normalizeAttachment(await response.json());
  }
  async fetchAttachmentStatus(attachmentId, options) {
    const id = attachmentId.trim();
    if (!id) {
      throw new HelperFlowError(
        "ATTACHMENT_METADATA_MISSING",
        "\u9644\u4EF6 ID \u4E0D\u80FD\u4E3A\u7A7A"
      );
    }
    const response = await this.getAdapter().http.request({
      url: buildApiUrl3(
        this.options.apiBaseUrl,
        buildAttachmentStatusPath(id, options?.preprocessModel)
      ),
      method: "GET",
      headers: this.createJsonHeaders()
    });
    if (response.status === 401) {
      throw new HelperFlowError(
        "AUTH_UNAUTHORIZED",
        "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0 token \u540E\u91CD\u8BD5"
      );
    }
    if (!response.ok) {
      throw new HelperFlowError(
        "NETWORK_ERROR",
        await readResponseErrorMessage(response),
        {
          status: response.status
        }
      );
    }
    return normalizeAttachment(await response.json());
  }
  async fetchAttachmentStatuses(attachmentIds, options) {
    const ids = normalizeAttachmentIds(attachmentIds);
    if (ids.length === 1) {
      return [await this.fetchAttachmentStatus(ids[0], options)];
    }
    const response = await this.getAdapter().http.request({
      url: buildApiUrl3(
        this.options.apiBaseUrl,
        buildAttachmentStatusesPath(ids, options?.preprocessModel)
      ),
      method: "GET",
      headers: this.createJsonHeaders()
    });
    if (response.status === 401) {
      throw new HelperFlowError(
        "AUTH_UNAUTHORIZED",
        "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0 token \u540E\u91CD\u8BD5"
      );
    }
    if (response.status === 404 || response.status === 405) {
      return Promise.all(
        ids.map((id) => this.fetchAttachmentStatus(id, options))
      );
    }
    if (!response.ok) {
      throw new HelperFlowError(
        "NETWORK_ERROR",
        await readResponseErrorMessage(response),
        {
          status: response.status
        }
      );
    }
    const payload = await response.json();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const attachments = items.map((item) => normalizeAttachment(item));
    const attachmentMap = new Map(
      attachments.map((attachment) => [attachment.id, attachment])
    );
    return ids.map((id) => {
      const attachment = attachmentMap.get(id);
      if (!attachment) {
        throw new HelperFlowError(
          "ATTACHMENT_METADATA_MISSING",
          "\u9644\u4EF6\u72B6\u6001\u8FD4\u56DE\u7F3A\u5C11\u5BF9\u5E94\u9644\u4EF6",
          { attachmentId: id }
        );
      }
      return attachment;
    });
  }
  watchAttachmentProcessingIfNeeded(attachment, options, stateVersion = this.destroyVersion) {
    if (!this.isStateVersionCurrent(stateVersion)) {
      return;
    }
    if (this.removedAttachmentIds.has(attachment.id) || !options?.watchProcessing || !shouldPollAttachmentProcessing(attachment)) {
      return;
    }
    const existing = this.attachmentProcessingWatchMap.get(attachment.id);
    this.attachmentProcessingWatchMap.set(attachment.id, {
      current: attachment,
      preprocessModel: options.preprocessModel?.trim() || void 0,
      startedAt: existing?.startedAt ?? Date.now(),
      intervalMs: clampPollInterval(options.processingPollIntervalMs),
      timeoutMs: clampProcessingTimeout(options.processingTimeoutMs),
      stateVersion
    });
    this.ensureAttachmentProcessingWatcher();
  }
  ensureAttachmentProcessingWatcher() {
    if (this.attachmentProcessingWatcher) {
      return;
    }
    this.attachmentProcessingWatcher = this.runAttachmentProcessingWatcher().catch(() => void 0).finally(() => {
      this.attachmentProcessingWatcher = void 0;
      if (this.attachmentProcessingWatchMap.size > 0) {
        this.ensureAttachmentProcessingWatcher();
      }
    });
  }
  async runAttachmentProcessingWatcher() {
    while (this.attachmentProcessingWatchMap.size > 0) {
      const entries = Array.from(this.attachmentProcessingWatchMap.values());
      const intervalMs = Math.min(...entries.map((entry) => entry.intervalMs));
      await sleep(intervalMs);
      const activeEntries = this.collectActiveAttachmentWatchEntries();
      if (activeEntries.length === 0) {
        continue;
      }
      try {
        const attachments = (await Promise.all(
          groupAttachmentWatchEntriesByPreprocessModel(activeEntries).map(
            (entries2) => this.fetchAttachmentStatuses(
              entries2.map((entry) => entry.current.id),
              { preprocessModel: entries2[0]?.preprocessModel }
            )
          )
        )).flat();
        const attachmentMap = new Map(
          attachments.map((attachment) => [attachment.id, attachment])
        );
        activeEntries.forEach((entry) => {
          if (!this.isStateVersionCurrent(entry.stateVersion)) {
            this.attachmentProcessingWatchMap.delete(entry.current.id);
            return;
          }
          if (this.removedAttachmentIds.has(entry.current.id)) {
            this.attachmentProcessingWatchMap.delete(entry.current.id);
            return;
          }
          const nextAttachment = attachmentMap.get(entry.current.id);
          if (!nextAttachment) {
            this.failAttachmentProcessingWatch(
              entry.current,
              "\u9644\u4EF6\u72B6\u6001\u8FD4\u56DE\u7F3A\u5C11\u5BF9\u5E94\u9644\u4EF6"
            );
            return;
          }
          if (this.removedAttachmentIds.has(nextAttachment.id)) {
            this.attachmentProcessingWatchMap.delete(nextAttachment.id);
            return;
          }
          this.rememberAttachment(nextAttachment);
          this.emitAttachmentStatus(nextAttachment);
          if (shouldPollAttachmentProcessing(nextAttachment)) {
            this.attachmentProcessingWatchMap.set(nextAttachment.id, {
              ...entry,
              current: nextAttachment
            });
            return;
          }
          this.attachmentProcessingWatchMap.delete(nextAttachment.id);
        });
      } catch (error) {
        const message = error instanceof HelperFlowError ? error.message : "\u9644\u4EF6\u72B6\u6001\u67E5\u8BE2\u5931\u8D25";
        activeEntries.forEach((entry) => {
          if (!this.isStateVersionCurrent(entry.stateVersion)) {
            this.attachmentProcessingWatchMap.delete(entry.current.id);
            return;
          }
          this.failAttachmentProcessingWatch(entry.current, message);
        });
      }
    }
  }
  collectActiveAttachmentWatchEntries() {
    const now = Date.now();
    const activeEntries = [];
    this.attachmentProcessingWatchMap.forEach((entry, attachmentId) => {
      if (!this.isStateVersionCurrent(entry.stateVersion)) {
        this.attachmentProcessingWatchMap.delete(attachmentId);
        return;
      }
      if (this.removedAttachmentIds.has(attachmentId)) {
        this.attachmentProcessingWatchMap.delete(attachmentId);
        return;
      }
      if (!shouldPollAttachmentProcessing(entry.current)) {
        this.attachmentProcessingWatchMap.delete(attachmentId);
        return;
      }
      if (now - entry.startedAt >= entry.timeoutMs) {
        this.failAttachmentProcessingWatch(
          entry.current,
          "\u9644\u4EF6\u89E3\u6790\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"
        );
        return;
      }
      activeEntries.push(entry);
    });
    return activeEntries;
  }
  failAttachmentProcessingWatch(attachment, message) {
    if (this.removedAttachmentIds.has(attachment.id)) {
      return;
    }
    this.attachmentProcessingWatchMap.delete(attachment.id);
    this.emitAttachmentStatus({
      ...attachment,
      processingReady: false,
      processingErrorMessage: message
    });
  }
  async consumeSystemPromptResponse(response) {
    if (response.status === 401) {
      return this.fail(
        "AUTH_UNAUTHORIZED",
        "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0 token \u540E\u91CD\u8BD5"
      );
    }
    if (!response.ok) {
      return this.fail("NETWORK_ERROR", await readResponseErrorMessage(response), {
        status: response.status
      });
    }
    return this.ok(normalizeSystemPromptList(await response.json()));
  }
  normalizeSystemPromptOptions(options) {
    const sessionId = options?.sessionId?.trim() || "";
    if (!sessionId) {
      return {};
    }
    return {
      sessionId
    };
  }
  async consumeDekInitResponse(response) {
    if (response.status === 401) {
      return this.fail(
        "AUTH_UNAUTHORIZED",
        "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0 token \u540E\u91CD\u8BD5"
      );
    }
    if (response.status === 403) {
      return this.fail(
        "AUTH_UNAUTHORIZED",
        "\u53EA\u80FD\u8BBF\u95EE\u5F53\u524D\u767B\u5F55\u7528\u6237\u7684\u79C1\u94A5\u521D\u59CB\u5316\u72B6\u6001",
        {
          status: response.status
        }
      );
    }
    if (!response.ok) {
      return this.fail("NETWORK_ERROR", await readResponseErrorMessage(response), {
        status: response.status
      });
    }
    return this.ok(normalizeDekInitState(await response.json()));
  }
  async consumeCloudDeviceKeyResponse(response) {
    if (response.status === 401) {
      return this.fail(
        "AUTH_UNAUTHORIZED",
        "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0 token \u540E\u91CD\u8BD5"
      );
    }
    if (response.status === 403) {
      return this.fail("AUTH_UNAUTHORIZED", "\u53EA\u80FD\u8BBF\u95EE\u5F53\u524D\u767B\u5F55\u7528\u6237\u7684\u4E91\u7AEF DEK", {
        status: response.status
      });
    }
    if (!response.ok) {
      return this.fail("NETWORK_ERROR", await readResponseErrorMessage(response), {
        status: response.status
      });
    }
    return this.ok(normalizeUserDekCurrentState(await response.json()));
  }
  async resolveAttachments(files, options) {
    const activeFiles = files.filter((file) => !this.isRemovedAttachmentInput(file));
    if (activeFiles.length === 0) {
      return [];
    }
    if (activeFiles.length > options.attachmentMaxCount) {
      throw new HelperFlowError(
        "FILE_COUNT_EXCEEDED",
        `\u5355\u6761\u6D88\u606F\u6700\u591A\u652F\u6301 ${options.attachmentMaxCount} \u4E2A\u9644\u4EF6`
      );
    }
    const attachments = [];
    for (const file of activeFiles) {
      if (isUploadFileInput(file)) {
        const result = await this.uploadFile([file], {
          attachmentMaxCount: options.attachmentMaxCount,
          attachmentMaxSizeMb: options.attachmentMaxSizeMb
        });
        if (!result.ok) {
          throw new HelperFlowError(result.code, result.message, result.details);
        }
        const failedItem = result.data.items.find(
          (item) => !item.ok
        );
        if (failedItem) {
          throw new HelperFlowError(
            failedItem.code,
            failedItem.message,
            failedItem.details
          );
        }
        result.data.attachments.forEach((attachment2) => {
          attachments.push(attachment2);
        });
        continue;
      }
      if (typeof file === "string") {
        const attachment2 = this.attachmentMap.get(file.trim());
        if (!attachment2) {
          throw new HelperFlowError(
            "ATTACHMENT_METADATA_MISSING",
            "\u9644\u4EF6 metadata \u4E0D\u5B58\u5728\uFF0C\u8BF7\u5148\u8C03\u7528 uploadFile \u4E0A\u4F20\u6216\u4F20\u5165\u5B8C\u6574\u9644\u4EF6\u5BF9\u8C61",
            {
              attachmentId: file
            }
          );
        }
        attachments.push(attachment2);
        continue;
      }
      const attachment = normalizeAttachment(file);
      if (this.removedAttachmentIds.has(attachment.id)) {
        continue;
      }
      this.rememberAttachment(attachment);
      attachments.push(attachment);
    }
    return dedupeAttachmentsById(attachments);
  }
  isRemovedAttachmentInput(file) {
    const attachmentId = resolveAttachmentInputId(file);
    return attachmentId ? this.removedAttachmentIds.has(attachmentId) : false;
  }
  async resolveHistoryState(sessionId, options) {
    const cachedState = this.historyMap.get(sessionId);
    if (cachedState && !options?.refresh) {
      return cachedState;
    }
    const sessionMode = resolveHelperSessionMode(
      sessionId,
      options?.sessionMode ?? this.options.sessionMode
    );
    if (sessionMode === "temporary") {
      const state2 = cachedState ?? createHistoryState(sessionId, "memory", [], []);
      this.historyMap.set(sessionId, state2);
      return state2;
    }
    const state = await this.fetchPersistedHistoryState(sessionId);
    this.historyMap.set(sessionId, state);
    return state;
  }
  async fetchPersistedHistoryState(sessionId) {
    const response = await this.getAdapter().http.request({
      url: buildApiUrl3(
        this.options.apiBaseUrl,
        `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`
      ),
      method: "GET",
      headers: this.createJsonHeaders()
    });
    if (response.status === 401) {
      throw new HelperFlowError(
        "AUTH_UNAUTHORIZED",
        "\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0 token \u540E\u91CD\u8BD5"
      );
    }
    if (!response.ok) {
      throw new HelperFlowError(
        "NETWORK_ERROR",
        await readResponseErrorMessage(response),
        {
          status: response.status
        }
      );
    }
    const payload = await response.json();
    const wireMessages = Array.isArray(payload.items) ? payload.items : [];
    const messages = await Promise.all(
      wireMessages.map((item) => this.decryptHistoryMessage(item))
    );
    return createHistoryState(sessionId, "api", messages, wireMessages);
  }
  appendHistory(sessionId, messages, wireMessages, sessionMode) {
    const currentState = this.historyMap.get(sessionId) ?? createHistoryState(
      sessionId,
      historySourceFromSessionMode(sessionMode),
      [],
      []
    );
    const updatedAt = Date.now();
    this.historyMap.set(sessionId, {
      ...currentState,
      messages: [...currentState.messages, ...messages],
      wireMessages: [...currentState.wireMessages, ...wireMessages],
      updatedAt
    });
  }
  async decryptHistoryMessage(message) {
    try {
      const content = await Promise.all(
        message.content.map((block) => this.decryptContentBlock(block))
      );
      const reasoning = message.reasoning ? await Promise.all(
        message.reasoning.map(async (block) => ({
          type: "text",
          text: await this.sdk.decryptText(block.text)
        }))
      ) : null;
      return {
        id: message.id ?? null,
        role: message.role,
        content,
        reasoning,
        requestId: message.requestId ?? null,
        tokenCount: message.tokenCount ?? null,
        sequenceNo: message.sequenceNo ?? null,
        createdAt: message.createdAt,
        webSearchSources: normalizeWebSearchSources(message.webSearchSources)
      };
    } catch (error) {
      throw new HelperFlowError(
        "DECRYPT_FAILED",
        "\u6D88\u606F\u89E3\u5BC6\u5931\u8D25\uFF0C\u8BF7\u786E\u8BA4\u5F53\u524D\u79C1\u94A5\u662F\u5426\u5339\u914D",
        normalizeErrorDetails(error)
      );
    }
  }
  async decryptContentBlock(block) {
    if (block.type === "text") {
      return {
        type: "text",
        text: await this.sdk.decryptText(block.text)
      };
    }
    const file = block.file;
    return {
      type: "file",
      file: {
        file_name: file.file_name ?? file.attachment_id ?? "attachment",
        file_type: file.file_type ?? "application/octet-stream",
        file_size: file.file_size ?? 1,
        attachment_id: file.attachment_id,
        kind: file.kind
      }
    };
  }
  async decryptTextDelta(encryptedText) {
    try {
      return await this.sdk.decryptText(encryptedText);
    } catch (error) {
      throw new HelperFlowError(
        "DECRYPT_FAILED",
        "\u6D41\u5F0F\u5BC6\u6587\u89E3\u5BC6\u5931\u8D25\uFF0C\u8BF7\u786E\u8BA4\u5F53\u524D\u79C1\u94A5\u662F\u5426\u5339\u914D",
        normalizeErrorDetails(error)
      );
    }
  }
  async assertSecretReady() {
    const userId = this.resolveCurrentUserId();
    const activeDeviceKey = userId ? this.getCurrentSecret(userId) : null;
    if (!activeDeviceKey) {
      throw new HelperFlowError("SECRET_MISSING", "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u79C1\u94A5");
    }
    try {
      await this.sdk.ensureReady();
    } catch (error) {
      throw new HelperFlowError(
        "SDK_NOT_READY",
        "SDK \u5C1A\u672A\u5C31\u7EEA\uFF0C\u8BF7\u5148\u5B8C\u6210\u79C1\u94A5\u521D\u59CB\u5316",
        normalizeErrorDetails(error)
      );
    }
  }
  assertTokenReady() {
    const token = this.token;
    if (!token?.accessToken) {
      throw new HelperFlowError("TOKEN_MISSING", "\u8BF7\u5148\u8BBE\u7F6E access token");
    }
    if (token.expiresAt && token.expiresAt <= Date.now()) {
      throw new HelperFlowError("TOKEN_EXPIRED", "access token \u5DF2\u8FC7\u671F");
    }
  }
  assertModelReady(options) {
    if (!options.model?.trim()) {
      throw new HelperFlowError("INVALID_MESSAGE", "\u8BF7\u5148\u901A\u8FC7 setOptions \u8BBE\u7F6E\u6A21\u578B");
    }
  }
  resolveCurrentUserId() {
    return this.sdk.getUserId?.().trim() || "";
  }
  resolveDekInitUserId(userId) {
    const sdkUserId = this.resolveCurrentUserId();
    const tokenUserId = resolveUserIdFromAccessToken(
      this.token?.accessToken,
      this.getAdapter().runtime
    );
    const requestedUserId = userId?.trim() || "";
    const expectedUserId = tokenUserId || sdkUserId;
    if (sdkUserId && tokenUserId && sdkUserId !== tokenUserId) {
      throw new HelperFlowError(
        "AUTH_UNAUTHORIZED",
        "\u5F53\u524D SDK \u7528\u6237\u4E0E\u767B\u5F55\u7528\u6237\u4E0D\u4E00\u81F4"
      );
    }
    if (requestedUserId && expectedUserId && requestedUserId !== expectedUserId) {
      throw new HelperFlowError(
        "AUTH_UNAUTHORIZED",
        "\u5F53\u524D\u7528\u6237\u4E0E\u79C1\u94A5\u521D\u59CB\u5316\u7528\u6237\u4E0D\u4E00\u81F4"
      );
    }
    const resolvedUserId = sdkUserId || requestedUserId || tokenUserId;
    if (!resolvedUserId) {
      throw new HelperFlowError(
        "SECRET_MISSING",
        "DEK helper API \u9700\u8981\u5148\u8C03\u7528 sdk.init({ userId }) \u6216\u8BBE\u7F6E\u767B\u5F55 token"
      );
    }
    return resolvedUserId;
  }
  getCurrentSecret(userId = this.resolveCurrentUserId()) {
    const activeDeviceKey = this.dek && this.dekUserId === userId ? this.dek : null;
    return activeDeviceKey ? cloneDeviceKeyRecord(activeDeviceKey) : null;
  }
  setRuntimeSecret(deviceKey, userId) {
    this.sdk.setActiveDeviceKeyRecord(deviceKey);
    this.dek = cloneDeviceKeyRecord(deviceKey);
    this.dekUserId = userId;
  }
  clearSecretState(userId) {
    if (userId && this.dekUserId && this.dekUserId !== userId) {
      return;
    }
    this.dek = void 0;
    this.dekUserId = void 0;
    this.sdk.clearActiveDeviceKeyRecord();
  }
  resolveSessionId(sessionId) {
    const targetSessionId = (sessionId ?? this.sessionId ?? "").trim();
    if (!targetSessionId) {
      throw new HelperFlowError("SESSION_ID_REQUIRED", "\u8BF7\u5148\u8BBE\u7F6E sessionId");
    }
    return targetSessionId;
  }
  createJsonHeaders() {
    const headers = this.createAuthHeaders();
    headers.Accept = "application/json, text/event-stream";
    headers["Content-Type"] = "application/json";
    return headers;
  }
  createAuthHeaders() {
    this.assertTokenReady();
    const token = this.token;
    return {
      Authorization: `${token.tokenType} ${token.accessToken}`
    };
  }
  startStatusRun(mid) {
    const existingRun = this.statusRunMap.get(mid);
    if (existingRun) {
      return existingRun;
    }
    const nextRun = {
      sendTimestamp: Date.now(),
      emittedCodes: /* @__PURE__ */ new Set()
    };
    this.statusRunMap.set(mid, nextRun);
    return nextRun;
  }
  finishStatusRun(mid) {
    this.statusRunMap.delete(mid);
  }
  emitQueueStatus(preparedMessage, queueEvent) {
    const queue = {
      stage: queueEvent.stage,
      model: queueEvent.model,
      resourceKey: queueEvent.resourceKey,
      position: normalizePositiveInteger2(queueEvent.position),
      estimatedWaitMs: normalizePositiveInteger2(queueEvent.estimatedWaitMs)
    };
    const title = queue.stage === "retrieval" ? "\u68C0\u7D22\u6392\u961F\u4E2D" : "\u6A21\u578B\u6392\u961F\u4E2D";
    const positionText = queue.position ? `\uFF0C\u524D\u65B9\u7EA6 ${queue.position} \u4E2A\u8BF7\u6C42` : "";
    const waitText = queue.estimatedWaitMs ? `\uFF0C\u9884\u8BA1\u7B49\u5F85 ${Math.ceil(queue.estimatedWaitMs / 1e3)} \u79D2` : "";
    const message = `${title}${positionText}${waitText}`;
    this.emitStatus(
      preparedMessage.mid,
      preparedMessage.sessionId,
      "inference_queued",
      {
        title,
        info: [message],
        message,
        queue,
        dedupe: false
      }
    );
  }
  emitInferenceBusyStatus(preparedMessage, details) {
    const normalizedDetails = normalizeInferenceBusyDetails(details);
    const retrySeconds = Math.max(
      1,
      Math.ceil(normalizedDetails.retryAfterMs / 1e3)
    );
    const message = `\u6A21\u578B\u670D\u52A1\u7E41\u5FD9\uFF0C\u5EFA\u8BAE ${retrySeconds} \u79D2\u540E\u91CD\u8BD5`;
    this.emitStatus(
      preparedMessage.mid,
      preparedMessage.sessionId,
      "inference_busy",
      {
        title: "\u6A21\u578B\u670D\u52A1\u7E41\u5FD9",
        info: [message],
        message,
        details: normalizedDetails,
        dedupe: false
      }
    );
  }
  emitStreamFallbackStatus(preparedMessage) {
    const message = "\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u6D41\u5F0F\u8BFB\u53D6\uFF0C\u5DF2\u81EA\u52A8\u5207\u6362\u4E3A\u975E\u6D41\u5F0F\u8F93\u51FA";
    this.emitStatus(
      preparedMessage.mid,
      preparedMessage.sessionId,
      "STREAM_ERROR",
      {
        message,
        info: [message]
      }
    );
  }
  emitStatus(mid, sessionId, code, options) {
    const definition = HELPER_STATUS_DEFINITIONS[code];
    const run = this.startStatusRun(mid);
    if (options?.dedupe !== false && run.emittedCodes.has(code)) {
      return;
    }
    if (options?.dedupe !== false) {
      run.emittedCodes.add(code);
    }
    const title = options?.title ?? definition.title;
    const info = options?.info ?? definition.info;
    const event = {
      mid,
      sessionId,
      code,
      step: definition.step,
      title,
      info: [...info],
      ...options?.queue ? { queue: options.queue } : {},
      ...options?.details ? { details: options.details } : {},
      sendTimestamp: run.sendTimestamp,
      status: title,
      message: options?.message ?? title,
      timestamp: Date.now()
    };
    this.statusListeners.forEach((listener) => {
      void listener(event, mid);
    });
  }
  emitAttachmentStatus(attachment) {
    if (attachment.indexStatus === void 0 && attachment.ocrStatus === void 0 && attachment.processingReady === void 0 && attachment.processingErrorMessage === void 0) {
      return false;
    }
    const event = {
      attachmentId: attachment.id,
      kind: attachment.kind,
      attachment,
      indexStatus: attachment.indexStatus,
      ocrStatus: attachment.ocrStatus,
      processingReady: attachment.processingReady,
      processingErrorMessage: attachment.processingErrorMessage,
      timestamp: Date.now()
    };
    this.attachmentStatusListeners.forEach((listener) => {
      void listener(event);
    });
    this.emitUploadFileStatusFromAttachment(attachment, true);
    return true;
  }
  rememberUploadFileStatusContext(attachment, context) {
    this.uploadFileStatusContextMap.set(attachment.id, {
      ...context,
      kind: attachment.kind,
      extension: attachment.extension ?? context.extension
    });
  }
  emitUploadFileStatus(context, event) {
    const attachment = event.attachment;
    const statusEvent = {
      uploadId: context.uploadId,
      fileId: context.fileId,
      fileName: attachment?.fileName ?? context.fileName,
      fileType: attachment?.fileType ?? context.fileType,
      fileSize: attachment?.fileSize ?? context.fileSize,
      kind: attachment?.kind ?? context.kind,
      extension: attachment?.extension ?? context.extension,
      stage: event.stage,
      status: event.status,
      attachmentId: attachment?.id,
      attachment,
      indexStatus: attachment?.indexStatus,
      ocrStatus: attachment?.ocrStatus,
      processingReady: attachment?.processingReady,
      processingErrorMessage: attachment?.processingErrorMessage,
      message: event.message,
      errorCode: event.errorCode,
      errorDetails: event.errorDetails,
      timestamp: Date.now()
    };
    this.uploadFileStatusListeners.forEach((listener) => {
      void listener(statusEvent);
    });
  }
  emitUploadFileStatusFromAttachment(attachment, attachmentStatusEmitted) {
    const context = this.uploadFileStatusContextMap.get(attachment.id);
    if (!context) {
      return;
    }
    if (isAttachmentProcessingFailed(attachment)) {
      this.emitUploadFileStatus(context, {
        stage: "failed",
        status: "failed",
        attachment,
        message: attachment.processingErrorMessage || (attachment.kind === "image" ? "\u56FE\u7247\u89E3\u6790\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u4E0A\u4F20\u6216\u91CD\u8BD5" : "\u6587\u6863\u89E3\u6790\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u4E0A\u4F20\u6216\u91CD\u8BD5")
      });
      this.uploadFileStatusContextMap.delete(attachment.id);
      return;
    }
    if (attachment.processingReady === true) {
      this.emitUploadFileStatus(context, {
        stage: "ready",
        status: "success",
        attachment,
        message: attachment.kind === "image" ? "\u56FE\u7247\u89E3\u6790\u5B8C\u6210" : "\u6587\u6863\u5411\u91CF\u5316\u5B8C\u6210"
      });
      this.emitUploadFileStatus(context, {
        stage: "completed",
        status: "completed",
        attachment,
        message: "\u9644\u4EF6\u5904\u7406\u5B8C\u6210"
      });
      this.uploadFileStatusContextMap.delete(attachment.id);
      return;
    }
    if (shouldPollAttachmentProcessing(attachment)) {
      if (attachmentStatusEmitted) {
        this.emitUploadFileStatus(context, {
          stage: "vectorizing",
          status: "processing",
          attachment,
          message: attachment.kind === "image" ? "\u56FE\u7247 OCR \u5904\u7406\u4E2D" : "\u6587\u6863\u5411\u91CF\u5316\u5904\u7406\u4E2D"
        });
      }
      if (!context.watchProcessing) {
        this.emitUploadFileStatus(context, {
          stage: "completed",
          status: "completed",
          attachment,
          message: "\u9644\u4EF6\u4E0A\u4F20\u5B8C\u6210\uFF0C\u540E\u7AEF\u5904\u7406\u72B6\u6001\u8BF7\u540E\u7EED\u67E5\u8BE2"
        });
        this.uploadFileStatusContextMap.delete(attachment.id);
      }
      return;
    }
    this.emitUploadFileStatus(context, {
      stage: "completed",
      status: "completed",
      attachment,
      message: "\u9644\u4EF6\u4E0A\u4F20\u5B8C\u6210"
    });
    this.uploadFileStatusContextMap.delete(attachment.id);
  }
  emitMessage(event) {
    this.messageListeners.forEach((listener) => {
      void listener(event);
    });
  }
  releaseBusySessionForMid(mid) {
    this.busySessionMap.forEach((activeMid, sessionId) => {
      if (activeMid === mid) {
        this.busySessionMap.delete(sessionId);
      }
    });
  }
  resolveBusySessionIdForMid(mid) {
    for (const [sessionId, activeMid] of this.busySessionMap.entries()) {
      if (activeMid === mid) {
        return sessionId;
      }
    }
    return void 0;
  }
  markSessionRecentlyCanceled(sessionId) {
    if (sessionId.trim()) {
      this.recentCanceledSessionMap.set(sessionId, Date.now());
    }
  }
  isRecentlyCanceledSession(sessionId) {
    const canceledAt = this.recentCanceledSessionMap.get(sessionId);
    if (!canceledAt) {
      return false;
    }
    if (Date.now() - canceledAt > RECENT_CANCELED_SESSION_WINDOW_MS) {
      this.recentCanceledSessionMap.delete(sessionId);
      return false;
    }
    return true;
  }
  shouldRetryServerBusy(sessionId, errorInfo, attemptIndex) {
    if (errorInfo.code !== "SESSION_BUSY" || !this.isRecentlyCanceledSession(sessionId)) {
      return false;
    }
    if (attemptIndex >= SERVER_BUSY_RETRY_DELAYS_MS.length) {
      this.recentCanceledSessionMap.delete(sessionId);
      return false;
    }
    return true;
  }
  shouldRetryWithFreshCpuTeeCertificate(errorInfo, alreadyRetried) {
    if (alreadyRetried || errorInfo.code === "INFERENCE_BUSY" || errorInfo.code === "SESSION_BUSY" || errorInfo.code === "AUTH_UNAUTHORIZED" || errorInfo.code === "CANCELED") {
      return false;
    }
    if (errorInfo.serverCode && CERTIFICATE_STALE_RETRY_CODES.has(errorInfo.serverCode)) {
      return true;
    }
    if (!CERTIFICATE_STALE_RETRY_STATUSES.has(errorInfo.status)) {
      return false;
    }
    const haystack = `${errorInfo.message} ${stringifyErrorDetailsForMatch(
      errorInfo.details
    )}`.toLowerCase();
    return CERTIFICATE_STALE_RETRY_KEYWORDS.some(
      (keyword) => haystack.includes(keyword.toLowerCase())
    );
  }
  async tryRefreshCpuTeeCertificate(signal) {
    assertNotCanceled(signal);
    if (!this.sdk.refreshCpuTeeCertificate) {
      return false;
    }
    try {
      this.sdk.clearCpuTeeCertificateCache?.();
      await this.sdk.refreshCpuTeeCertificate({ attempts: 3 });
      assertNotCanceled(signal);
      return true;
    } catch (error) {
      if (isCanceledError(error)) {
        throw error;
      }
      return false;
    }
  }
  clearLastUnauthorizedRequestForMid(mid) {
    if (!mid || this.lastUnauthorizedRequest?.mid === mid) {
      this.lastUnauthorizedRequest = void 0;
    }
  }
  isStateVersionCurrent(stateVersion) {
    return this.destroyVersion === stateVersion;
  }
  assertStateVersion(stateVersion) {
    if (!this.isStateVersionCurrent(stateVersion)) {
      throw new HelperFlowError("CANCELED", "SDK helper \u72B6\u6001\u5DF2\u91CD\u7F6E");
    }
  }
  ok(data, mid) {
    return {
      ok: true,
      code: "OK",
      message: "OK",
      data,
      timestamp: Date.now(),
      mid
    };
  }
  fail(code, message, details, mid) {
    return {
      ok: false,
      code,
      message,
      details,
      timestamp: Date.now(),
      mid
    };
  }
  errorToResult(error, mid) {
    if (error instanceof HelperFlowError) {
      return this.fail(error.code, error.message, error.details, mid);
    }
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return this.fail("CANCELED", "\u8BF7\u6C42\u5DF2\u53D6\u6D88", normalizeErrorDetails(error), mid);
    }
    return this.fail(
      "NETWORK_ERROR",
      "\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
      normalizeErrorDetails(error),
      mid
    );
  }
  applyStreamReadableFallback(options) {
    return this.streamReadableUnsupported && options.stream ? {
      ...options,
      stream: false
    } : options;
  }
  disableStreamReadableFallback() {
    this.streamReadableUnsupported = true;
    this.options = this.applyStreamReadableFallback(this.options);
  }
};
function createDefaultOptions() {
  return {
    apiBaseUrl: DEFAULT_HELPER_API_BASE_URL,
    sessionMode: "auto",
    stream: true,
    chatContextLimit: DEFAULT_CHAT_CONTEXT_LIMIT,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    attachmentMaxCount: DEFAULT_CHAT_ATTACHMENT_MAX_COUNT,
    attachmentMaxSizeMb: DEFAULT_CHAT_ATTACHMENT_MAX_SIZE_MB,
    presencePenalty: 0,
    frequencyPenalty: 0
  };
}
function normalizeOptions(options) {
  const defaults = createDefaultOptions();
  const chatContextLimit = typeof options.chatContextLimit === "number" && Number.isFinite(options.chatContextLimit) ? Math.min(
    MAX_CHAT_CONTEXT_LIMIT,
    Math.max(0, Math.floor(options.chatContextLimit))
  ) : defaults.chatContextLimit;
  const requestTimeoutMs = typeof options.requestTimeoutMs === "number" && Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs >= 1e3 ? Math.floor(options.requestTimeoutMs) : defaults.requestTimeoutMs;
  const attachmentMaxCount = normalizeAttachmentMaxCount(
    options.attachmentMaxCount,
    defaults.attachmentMaxCount
  );
  const attachmentMaxSizeMb = normalizeAttachmentMaxSizeMb(
    options.attachmentMaxSizeMb,
    defaults.attachmentMaxSizeMb
  );
  return {
    ...options,
    apiBaseUrl: normalizeBaseUrl(options.apiBaseUrl || defaults.apiBaseUrl),
    sessionMode: normalizeSessionMode(
      options.sessionMode,
      defaults.sessionMode
    ),
    stream: options.stream ?? defaults.stream,
    chatContextLimit,
    requestTimeoutMs,
    attachmentMaxCount,
    attachmentMaxSizeMb,
    presencePenalty: options.presencePenalty ?? defaults.presencePenalty,
    frequencyPenalty: options.frequencyPenalty ?? defaults.frequencyPenalty
  };
}
function toPublicOptions(options) {
  return {
    ...options
  };
}
function normalizeBaseUrl(value) {
  return value.trim().replace(/\/+$/, "") || DEFAULT_HELPER_API_BASE_URL;
}
function normalizeAttachmentMaxCount(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(
    MAX_CHAT_ATTACHMENT_MAX_COUNT,
    Math.max(1, Math.floor(value))
  ) : fallback;
}
function normalizeAttachmentMaxSizeMb(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_CHAT_ATTACHMENT_MAX_SIZE_MB, Math.max(0, value)) : fallback;
}
function normalizePositiveInteger2(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : void 0;
}
function resolveAttachmentLimits(currentOptions, uploadOptions) {
  return {
    attachmentMaxCount: normalizeAttachmentMaxCount(
      uploadOptions?.attachmentMaxCount,
      currentOptions.attachmentMaxCount
    ),
    attachmentMaxSizeMb: normalizeAttachmentMaxSizeMb(
      uploadOptions?.attachmentMaxSizeMb,
      currentOptions.attachmentMaxSizeMb
    )
  };
}
function buildApiUrl3(apiBaseUrl, path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(apiBaseUrl)}${normalizedPath}`;
}
function buildAttachmentStatusPath(attachmentId, preprocessModel) {
  const normalizedModel = preprocessModel?.trim();
  const query = normalizedModel ? `?preprocessModel=${encodeURIComponent(normalizedModel)}` : "";
  return `/api/chat/attachments/${encodeURIComponent(attachmentId)}/status${query}`;
}
function buildAttachmentStatusesPath(attachmentIds, preprocessModel) {
  const query = new URLSearchParams({
    ids: attachmentIds.join(",")
  });
  const normalizedModel = preprocessModel?.trim();
  if (normalizedModel) {
    query.set("preprocessModel", normalizedModel);
  }
  return `/api/chat/attachments/status?${query.toString()}`;
}
function createBrowserAttachmentFormData(encryptedPayload, fields) {
  const encryptedBlob = new Blob([JSON.stringify(encryptedPayload)], {
    type: "application/json"
  });
  const formData = new FormData();
  formData.append("file", encryptedBlob, "payload.json");
  Object.entries(fields).forEach(([key, value]) => {
    formData.append(key, value);
  });
  return formData;
}
function groupAttachmentWatchEntriesByPreprocessModel(entries) {
  const grouped = /* @__PURE__ */ new Map();
  entries.forEach((entry) => {
    const key = entry.preprocessModel?.trim() || "";
    const items = grouped.get(key) ?? [];
    items.push(entry);
    grouped.set(key, items);
  });
  return Array.from(grouped.values());
}
function normalizeSystemPromptList(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const items = Array.isArray(source.items) ? source.items.map((item) => normalizeSystemPromptItem(item)).filter((item) => Boolean(item)) : [];
  const selectedPromptId = typeof source.selectedPromptId === "string" && source.selectedPromptId.trim() ? source.selectedPromptId.trim() : null;
  return {
    selectedPromptId,
    items,
    scope: source.scope === "session" ? "session" : "user",
    ...typeof source.sessionId === "string" && source.sessionId.trim() ? {
      sessionId: source.sessionId.trim()
    } : {}
  };
}
function normalizeSystemPromptItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const source = item;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const title = typeof source.title === "string" ? source.title.trim() : "";
  if (!id || !title) {
    return null;
  }
  return {
    id,
    title,
    key: typeof source.key === "string" && source.key.trim() ? source.key.trim() : null,
    isDefault: source.isDefault === true,
    isSelected: source.isSelected === true
  };
}
function normalizeDekInitState(payload) {
  const envelope = isPlainRecord2(payload) ? payload : {};
  const source = isPlainRecord2(envelope.data) ? envelope.data : envelope;
  const userId = typeof source.userId === "string" ? source.userId.trim() : "";
  if (!userId) {
    throw new HelperFlowError(
      "NETWORK_ERROR",
      "\u79C1\u94A5\u521D\u59CB\u5316\u72B6\u6001\u54CD\u5E94\u7F3A\u5C11\u7528\u6237 ID",
      payload
    );
  }
  const isInit = normalizeDekInitValue(
    source.isInit ?? source.initialized
  );
  return {
    userId,
    isInit,
    initialized: isInit === 1,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : void 0
  };
}
function normalizeDekInitValue(value) {
  return value === 1 || value === true || value === "1" ? 1 : 0;
}
function normalizeUserDekCurrentState(payload) {
  const envelope = isPlainRecord2(payload) ? payload : {};
  const source = isPlainRecord2(envelope.data) ? envelope.data : envelope;
  const userId = typeof source.userId === "string" ? source.userId.trim() : "";
  if (!userId) {
    throw new HelperFlowError(
      "NETWORK_ERROR",
      "\u4E91\u7AEF DEK \u54CD\u5E94\u7F3A\u5C11\u7528\u6237 ID",
      payload
    );
  }
  const rawDek = source.dek;
  const dek = rawDek === null || rawDek === void 0 ? null : isDeviceKeyRecord(rawDek) ? cloneDeviceKeyRecord(rawDek) : void 0;
  if (dek === void 0) {
    throw new HelperFlowError(
      "NETWORK_ERROR",
      "\u4E91\u7AEF DEK \u54CD\u5E94\u4E2D\u7684\u79C1\u94A5\u7ED3\u6784\u4E0D\u6B63\u786E",
      payload
    );
  }
  const initialized = Boolean(source.initialized ?? dek);
  return {
    userId,
    initialized,
    dek
  };
}
function buildChatPayloadOptions(options) {
  return pruneUndefinedValues({
    model: options.model?.trim(),
    stream: options.stream,
    includeReasoning: options.includeReasoning,
    enableWebSearch: options.enableWebSearch,
    temperature: options.temperature,
    topP: options.topP,
    maxNewTokens: options.maxNewTokens,
    stop: options.stop,
    presencePenalty: options.presencePenalty,
    frequencyPenalty: options.frequencyPenalty
  });
}
function isResponseStreamReadable(response) {
  return Boolean(response.stream) || typeof response.body?.getReader === "function";
}
function pruneUndefinedValues(value) {
  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    if (item !== void 0) {
      result[key] = item;
    }
  });
  return result;
}
function normalizeWebSearchSources(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seenUrls = /* @__PURE__ */ new Set();
  const sources = [];
  value.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const source = item;
    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (!url || seenUrls.has(url)) {
      return;
    }
    const title = typeof source.title === "string" && source.title.trim() ? source.title.trim() : url;
    seenUrls.add(url);
    sources.push({ title, url });
  });
  return sources;
}
function normalizeToken2(token) {
  if (typeof token === "string") {
    const accessToken2 = token.trim();
    return accessToken2 ? {
      accessToken: accessToken2,
      tokenType: "Bearer"
    } : null;
  }
  const accessToken = token.accessToken.trim();
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    tokenType: token.tokenType?.trim() || "Bearer",
    expiresAt: token.expiresAt
  };
}
function resolveUserIdFromAccessToken(accessToken, runtime) {
  const payloadSegment = accessToken?.split(".")[1];
  if (!payloadSegment) {
    return "";
  }
  try {
    const payload = JSON.parse(decodeBase64Url(payloadSegment, runtime));
    return isPlainRecord2(payload) && typeof payload.sub === "string" ? payload.sub.trim() : "";
  } catch {
    return "";
  }
}
function decodeBase64Url(value, runtime) {
  const normalizedValue = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - normalizedValue.length % 4) % 4;
  const paddedValue = `${normalizedValue}${"=".repeat(paddingLength)}`;
  if (runtime) {
    return runtime.utf8Decode(runtime.base64ToBytes(paddedValue));
  }
  return atob(paddedValue);
}
function isPlainRecord2(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isConflictResponseResult(result) {
  return !result.ok && isPlainRecord2(result.details) && result.details.status === 409;
}
function normalizeMessageInput(input) {
  if (typeof input === "string") {
    return {
      text: input,
      files: []
    };
  }
  if (Array.isArray(input)) {
    const textParts = [];
    const files = [];
    input.forEach((part) => {
      if (part.type === "text") {
        textParts.push(part.data);
      } else {
        files.push(part.data);
      }
    });
    return {
      text: textParts.join("\n"),
      files
    };
  }
  return {
    text: input.message ?? "",
    files: input.files ?? []
  };
}
function assertFileList(files, limits) {
  assertFileCount(files, limits);
  files.forEach((file) => {
    const maxSizeBytes = limits.attachmentMaxSizeMb * 1024 * 1024;
    const extension = file.extension;
    if (maxSizeBytes > 0 && file.fileSize > maxSizeBytes) {
      throw new HelperFlowError(
        "FILE_TOO_LARGE",
        `\u5355\u4E2A\u6587\u4EF6\u4E0D\u80FD\u8D85\u8FC7 ${limits.attachmentMaxSizeMb}MB`,
        {
          fileName: file.fileName,
          fileSize: file.fileSize
        }
      );
    }
    if (!CHAT_ATTACHMENT_EXTENSIONS_SET.has(extension)) {
      throw new HelperFlowError(
        "FILE_TYPE_UNSUPPORTED",
        `\u5F53\u524D\u6587\u4EF6\u7C7B\u578B\u6682\u4E0D\u652F\u6301\uFF1A${file.fileName || "attachment"}`,
        {
          fileName: file.fileName,
          extension,
          supportedExtensions: [...CHAT_ATTACHMENT_EXTENSIONS]
        }
      );
    }
  });
}
function assertFileCount(files, limits) {
  if (files.length > limits.attachmentMaxCount) {
    throw new HelperFlowError(
      "FILE_COUNT_EXCEEDED",
      `\u5355\u6B21\u6700\u591A\u4E0A\u4F20 ${limits.attachmentMaxCount} \u4E2A\u9644\u4EF6`
    );
  }
}
function normalizeAttachmentIds(attachmentIds) {
  const ids = Array.from(
    new Set(
      attachmentIds.map((item) => item.trim()).filter((item) => item.length > 0)
    )
  );
  if (ids.length === 0) {
    throw new HelperFlowError(
      "ATTACHMENT_METADATA_MISSING",
      "\u9644\u4EF6 ID \u4E0D\u80FD\u4E3A\u7A7A"
    );
  }
  return ids;
}
function normalizeAttachmentId(attachmentId) {
  return normalizeAttachmentIds([attachmentId])[0];
}
function resolveAttachmentInputId(input) {
  if (typeof input === "string") {
    return input.trim() || null;
  }
  if (isFileLike(input) || isMiniappFileInput(input)) {
    return null;
  }
  return input.id?.trim() || null;
}
function isFileLike(value) {
  return typeof File !== "undefined" && value instanceof File;
}
function isMiniappFileInput(value) {
  if (!isPlainRecord2(value)) {
    return false;
  }
  return typeof value.path === "string" && value.path.trim().length > 0 && typeof value.name === "string" && value.name.trim().length > 0;
}
function isUploadFileInput(value) {
  return isFileLike(value) || isMiniappFileInput(value);
}
function getFileExtension(fileName) {
  const normalizedName = fileName.trim().toLowerCase();
  const dotIndex = normalizedName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === normalizedName.length - 1) {
    return "";
  }
  return normalizedName.slice(dotIndex + 1);
}
function createUploadFileStatusContext(uploadId, file, index, options) {
  return {
    uploadId,
    fileId: `${uploadId}_${index + 1}`,
    fileName: file.fileName,
    fileType: file.fileType,
    fileSize: file.fileSize,
    kind: file.kind,
    extension: file.extension,
    watchProcessing: options?.watchProcessing === true
  };
}
function createRawUploadFileStatusContext(uploadId, file, index, options) {
  const source = isMiniappFileInput(file) ? {
    fileName: file.name.trim(),
    fileType: file.type?.trim() || "application/octet-stream",
    fileSize: typeof file.size === "number" && Number.isFinite(file.size) ? Math.max(0, Math.floor(file.size)) : 0
  } : {
    fileName: file.name.trim() || "attachment",
    fileType: file.type || "application/octet-stream",
    fileSize: file.size
  };
  const extension = getFileExtension(source.fileName);
  return {
    uploadId,
    fileId: `${uploadId}_${index + 1}`,
    fileName: source.fileName,
    fileType: source.fileType,
    fileSize: source.fileSize,
    kind: resolveAttachmentKind({
      fileName: source.fileName,
      fileType: source.fileType,
      extension
    }),
    extension,
    watchProcessing: options?.watchProcessing === true
  };
}
function createUploadFileItemBase(context) {
  return {
    uploadId: context.uploadId,
    fileId: context.fileId,
    fileName: context.fileName,
    fileType: context.fileType,
    fileSize: context.fileSize,
    kind: context.kind,
    extension: context.extension
  };
}
function createUploadFileSuccessItem(context, attachment) {
  return {
    ...createUploadFileItemBase(context),
    ok: true,
    status: "success",
    fileName: attachment.fileName,
    fileType: attachment.fileType,
    fileSize: attachment.fileSize,
    kind: attachment.kind,
    extension: attachment.extension ?? context.extension,
    attachmentId: attachment.id,
    attachment,
    message: "\u9644\u4EF6\u4E0A\u4F20\u5B8C\u6210"
  };
}
function createUploadFileSkippedItem(context, message) {
  return {
    ...createUploadFileItemBase(context),
    ok: true,
    status: "skipped",
    skippedReason: "duplicate_in_batch",
    message
  };
}
function createUploadFileFailedItem(context, error) {
  return {
    ...createUploadFileItemBase(context),
    ok: false,
    status: "failed",
    code: error.code,
    message: error.message,
    details: error.details
  };
}
function createUploadFileResult(uploadId, items, attachments) {
  return {
    uploadId,
    items: [...items],
    attachments: [...attachments],
    successCount: items.filter((item) => item.status === "success").length,
    failureCount: items.filter((item) => item.status === "failed").length,
    skippedCount: items.filter((item) => item.status === "skipped").length,
    timestamp: Date.now()
  };
}
function resolveAttachmentKind(file) {
  const extension = file.extension ?? getFileExtension(file.fileName);
  return CHAT_IMAGE_EXTENSIONS_SET.has(extension) || file.fileType.toLowerCase().startsWith("image/") ? "image" : "file";
}
function normalizeAttachment(value) {
  const candidate = value;
  const id = candidate.id?.trim();
  const fileName = candidate.fileName?.trim();
  const fileType = candidate.fileType?.trim() || "application/octet-stream";
  const fileSize = Number(candidate.fileSize);
  if (!id || !fileName || !Number.isFinite(fileSize) || fileSize < 1) {
    throw new HelperFlowError(
      "ATTACHMENT_METADATA_MISSING",
      "\u9644\u4EF6 metadata \u4E0D\u5B8C\u6574",
      value
    );
  }
  return {
    id,
    fileName,
    fileType,
    fileSize: Math.floor(fileSize),
    extension: candidate.extension,
    kind: candidate.kind === "image" ? "image" : "file",
    downloadUrl: candidate.downloadUrl,
    createdAt: candidate.createdAt,
    fileFingerprint: typeof candidate.fileFingerprint === "string" && candidate.fileFingerprint.trim() ? candidate.fileFingerprint.trim() : void 0,
    fingerprintVersion: typeof candidate.fingerprintVersion === "string" && candidate.fingerprintVersion.trim() ? candidate.fingerprintVersion.trim() : void 0,
    reused: candidate.reused === true,
    indexStatus: normalizeAttachmentProcessingStatus(candidate.indexStatus),
    ocrStatus: normalizeAttachmentProcessingStatus(candidate.ocrStatus),
    processingReady: typeof candidate.processingReady === "boolean" ? candidate.processingReady : void 0,
    processingErrorMessage: typeof candidate.processingErrorMessage === "string" && candidate.processingErrorMessage.trim() ? candidate.processingErrorMessage.trim() : void 0
  };
}
function normalizeAttachmentProcessingStatus(value) {
  if (typeof value === "object" && value !== null && "status" in value) {
    return normalizeAttachmentProcessingStatus(
      value.status
    );
  }
  if (typeof value !== "string") {
    return void 0;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "pending" || normalized === "processing" || normalized === "ready" || normalized === "failed") {
    return normalized;
  }
  return void 0;
}
function shouldPollAttachmentProcessing(attachment) {
  if (attachment.processingReady === true) {
    return false;
  }
  if (attachment.indexStatus === "failed" || attachment.ocrStatus === "failed" || attachment.processingErrorMessage) {
    return false;
  }
  return attachment.processingReady === false || attachment.indexStatus === "pending" || attachment.indexStatus === "processing" || attachment.ocrStatus === "pending" || attachment.ocrStatus === "processing";
}
function isAttachmentProcessingFailed(attachment) {
  return attachment.indexStatus === "failed" || attachment.ocrStatus === "failed" || !!attachment.processingErrorMessage;
}
function clampPollInterval(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval)) {
    return 3e3;
  }
  return Math.min(Math.max(Math.floor(interval), 500), 1e4);
}
function clampProcessingTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout)) {
    return 18e4;
  }
  return Math.min(Math.max(Math.floor(timeout), 1e4), 9e5);
}
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
async function sm3Hex(value) {
  return sm32(typeof value === "string" ? utf8EncodeFallback(value) : value);
}
function utf8EncodeFallback(value) {
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
function toUint8Array(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
function buildFileDedupeKey(input) {
  return [
    input.fileName.trim(),
    input.fileType.trim().toLowerCase() || "application/octet-stream",
    Math.floor(input.fileSize),
    input.fingerprint.trim().toLowerCase()
  ].join("\0");
}
function dedupeAttachmentsById(attachments) {
  const seenIds = /* @__PURE__ */ new Set();
  const uniqueAttachments = [];
  attachments.forEach((attachment) => {
    if (seenIds.has(attachment.id)) {
      return;
    }
    seenIds.add(attachment.id);
    uniqueAttachments.push(attachment);
  });
  return uniqueAttachments;
}
function createWireFileBlock(attachment) {
  return {
    type: "file",
    file: {
      file_name: attachment.fileName,
      file_type: attachment.fileType,
      file_size: attachment.fileSize,
      attachment_id: attachment.id,
      kind: attachment.kind
    }
  };
}
function createPlainFileBlock(attachment) {
  return {
    type: "file",
    file: {
      file_name: attachment.fileName,
      file_type: attachment.fileType,
      file_size: attachment.fileSize,
      attachment_id: attachment.id,
      kind: attachment.kind
    }
  };
}
function createHistoryState(sessionId, source, messages, wireMessages) {
  const timestamp = Date.now();
  return {
    sessionId,
    source,
    messages,
    wireMessages,
    loadedAt: timestamp,
    updatedAt: timestamp
  };
}
function hasSameWireMessageRefs(currentMessages, nextMessages) {
  return currentMessages.length === nextMessages.length && currentMessages.every((message, index) => message === nextMessages[index]);
}
function sliceHistoryMessages(messages, page) {
  const orderedMessages = page?.order === "desc" ? [...messages].reverse() : [...messages];
  const offset = typeof page?.offset === "number" && Number.isFinite(page.offset) ? Math.max(0, Math.floor(page.offset)) : 0;
  const limit = typeof page?.limit === "number" && Number.isFinite(page.limit) ? Math.max(0, Math.floor(page.limit)) : orderedMessages.length;
  return orderedMessages.slice(offset, offset + limit);
}
function slicePersistableHistoryMessages(state, page) {
  const pairs = state.wireMessages.map((wireMessage, index) => ({
    wireMessage,
    plainMessage: state.messages[index]
  }));
  const orderedPairs = page?.order === "desc" ? [...pairs].reverse() : pairs;
  const offset = typeof page?.offset === "number" && Number.isFinite(page.offset) ? Math.max(0, Math.floor(page.offset)) : 0;
  const limit = typeof page?.limit === "number" && Number.isFinite(page.limit) ? Math.max(0, Math.floor(page.limit)) : orderedPairs.length;
  return orderedPairs.slice(offset, offset + limit).map(
    ({ wireMessage, plainMessage }) => toPersistableHistoryMessage(wireMessage, plainMessage)
  ).filter((message) => Boolean(message));
}
function toPersistableHistoryMessage(wireMessage, plainMessage) {
  const content = wireMessage.content.map((block, index) => {
    if (block.type === "file") {
      return normalizePersistableFileBlock(block);
    }
    const plainBlock = plainMessage?.content[index];
    if (plainBlock?.type !== "text" || !plainBlock.text.trim() || !block.text.trim()) {
      return null;
    }
    return {
      type: "text",
      text: block.text.trim()
    };
  }).filter((block) => Boolean(block));
  const reasoning = normalizePersistableReasoning(
    wireMessage.reasoning,
    plainMessage?.reasoning
  );
  if (content.length === 0 && !(wireMessage.role === "assistant" && reasoning?.length)) {
    return null;
  }
  const { webSearchSources: _webSearchSources, ...persistableMessage } = wireMessage;
  return {
    ...persistableMessage,
    content,
    reasoning
  };
}
function normalizePersistableFileBlock(block) {
  const attachmentId = block.file.attachment_id?.trim();
  const encryptionData = block.file.encryption_data?.trim();
  if (!attachmentId && !encryptionData) {
    return null;
  }
  return {
    ...block,
    file: {
      ...block.file,
      attachment_id: attachmentId || void 0,
      encryption_data: encryptionData || void 0
    }
  };
}
function normalizePersistableReasoning(wireReasoning, plainReasoning) {
  if (!wireReasoning?.length || !plainReasoning?.length) {
    return null;
  }
  const reasoning = wireReasoning.map((block, index) => {
    const plainBlock = plainReasoning[index];
    if (!plainBlock?.text.trim() || !block.text.trim()) {
      return null;
    }
    return {
      type: "text",
      text: block.text.trim()
    };
  }).filter((block) => Boolean(block));
  return reasoning.length > 0 ? reasoning : null;
}
function collectPlainText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function isTemporarySessionId(sessionId) {
  return sessionId.startsWith("temp_");
}
function normalizeSessionMode(value, fallback) {
  return value === "temporary" || value === "persisted" || value === "auto" ? value : fallback;
}
function resolveHelperSessionMode(sessionId, mode = "auto") {
  if (mode === "temporary" || mode === "persisted") {
    return mode;
  }
  return isTemporarySessionId(sessionId) ? "temporary" : "persisted";
}
function historySourceFromSessionMode(mode) {
  return mode === "temporary" ? "memory" : "api";
}
function createMessageId() {
  return `mid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function createUploadFileId() {
  return `upload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function cloneDeviceKeyRecord(record) {
  return {
    encryptionKeyId: record.encryptionKeyId,
    dekHex: record.dekHex,
    certFingerprint: record.certFingerprint,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}
function isDeviceKeyRecord(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return typeof candidate.encryptionKeyId === "string" && candidate.encryptionKeyId.trim().length > 0 && typeof candidate.dekHex === "string" && DEK_HEX_PATTERN.test(candidate.dekHex.trim()) && typeof candidate.certFingerprint === "string" && candidate.certFingerprint.trim().length > 0 && typeof candidate.createdAt === "string" && candidate.createdAt.trim().length > 0 && typeof candidate.updatedAt === "string" && candidate.updatedAt.trim().length > 0;
}
function cloneDeviceKeyRecordForExport(record) {
  if (!isDeviceKeyRecord(record)) {
    throw new Error("\u79C1\u94A5\u7ED3\u6784\u4E0D\u5B8C\u6574\u6216\u683C\u5F0F\u4E0D\u6B63\u786E");
  }
  return cloneDeviceKeyRecord(record);
}
function serializeDeviceKeyRecordAsJson(deviceKey) {
  return JSON.stringify(cloneDeviceKeyRecordForExport(deviceKey), null, 2);
}
function buildDeviceKeyExportFileName(phone) {
  const normalizedPhone = typeof phone === "string" ? phone.trim().replace(/[\s()-]/g, "") : "";
  const phoneTail = normalizedPhone.slice(-4);
  return phoneTail.length === 4 ? `\u8346\u534E\u5BC6\u7B97\u79C1\u94A5(${phoneTail}).json` : DEFAULT_DEVICE_KEY_EXPORT_FILE_NAME;
}
function parseDeviceKeyRecordFromJson(rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("\u79C1\u94A5\u5185\u5BB9\u4E0D\u662F\u5408\u6CD5 JSON\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u540E\u518D\u8BD5");
  }
  const record = parsed && typeof parsed === "object" && "deviceKey" in parsed ? parsed.deviceKey : parsed;
  if (!isDeviceKeyRecord(record)) {
    throw new Error("\u79C1\u94A5\u5185\u5BB9\u7F3A\u5C11\u5FC5\u8981\u5B57\u6BB5\uFF0C\u65E0\u6CD5\u5B8C\u6210\u9A8C\u8BC1");
  }
  return cloneDeviceKeyRecord(record);
}
function normalizeDeviceKeyBackupErrorMessage(error, fallbackMessage) {
  return error instanceof Error && error.message.trim() ? error.message : fallbackMessage;
}
function getResponseHeader(response, name) {
  if (typeof response.headers.get === "function") {
    return response.headers.get(name) ?? void 0;
  }
  const targetName = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === targetName) {
      return value;
    }
  }
  return void 0;
}
async function readResponseErrorMessage(response) {
  const errorInfo = await readResponseErrorInfo(response);
  return errorInfo.message;
}
async function readResponseErrorInfo(response) {
  const contentType = getResponseHeader(response, "content-type")?.toLowerCase() || "";
  const rawText = await response.text();
  let message = rawText.trim() || "\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
  let details;
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawText);
      details = parsed.code === "INFERENCE_BUSY" ? normalizeInferenceBusyDetails(parsed.error, response) : parsed;
      if (Array.isArray(parsed.message) && parsed.message.length > 0) {
        message = parsed.message.join("\uFF1B");
      } else if (typeof parsed.message === "string" && parsed.message.trim()) {
        message = parsed.message;
      } else if (parsed.error?.message?.trim()) {
        message = parsed.error.message;
      }
      return {
        code: parsed.code === "INFERENCE_BUSY" ? "INFERENCE_BUSY" : isServerSessionBusyError(response.status, message) ? "SESSION_BUSY" : "NETWORK_ERROR",
        serverCode: typeof parsed.code === "string" ? parsed.code : void 0,
        message,
        details,
        status: response.status
      };
    } catch {
      return {
        code: isServerSessionBusyError(response.status, message) ? "SESSION_BUSY" : "NETWORK_ERROR",
        message,
        status: response.status
      };
    }
  }
  return {
    code: isServerSessionBusyError(response.status, message) ? "SESSION_BUSY" : "NETWORK_ERROR",
    message,
    status: response.status
  };
}
function isServerSessionBusyError(status, message) {
  return status === 409 && (message.includes("\u5F53\u524D\u4F1A\u8BDD\u6B63\u5728\u5904\u7406\u4E0A\u4E00\u6761\u6D88\u606F") || message.includes("\u5F53\u524D\u4F1A\u8BDD\u6B63\u5728\u751F\u6210\u56DE\u590D"));
}
function stringifyErrorDetailsForMatch(details) {
  if (details === void 0 || details === null) {
    return "";
  }
  if (typeof details === "string") {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return "";
  }
}
function shouldRetryAsrWithFreshCpuTeeCertificate(payload) {
  if (payload.code === 1002) {
    return true;
  }
  if (typeof payload.code === "string" && CERTIFICATE_STALE_RETRY_CODES.has(payload.code)) {
    return true;
  }
  const message = typeof payload.message === "string" ? payload.message.toLowerCase() : "";
  return CERTIFICATE_STALE_RETRY_KEYWORDS.some(
    (keyword) => message.includes(keyword.toLowerCase())
  );
}
function buildHttpErrorDetails(errorInfo) {
  if (errorInfo.code === "INFERENCE_BUSY") {
    return normalizeInferenceBusyDetails(errorInfo.details);
  }
  if (errorInfo.details && typeof errorInfo.details === "object" && !Array.isArray(errorInfo.details)) {
    return {
      status: errorInfo.status,
      ...errorInfo.details
    };
  }
  return {
    status: errorInfo.status,
    ...errorInfo.details !== void 0 ? { error: errorInfo.details } : {}
  };
}
function resultToHttpErrorInfo(result) {
  const details = result.details;
  const serverCode = details && typeof details === "object" && !Array.isArray(details) && "code" in details && typeof details.code === "string" ? details.code : void 0;
  return {
    code: result.code,
    serverCode,
    message: result.message,
    details: result.details,
    status: result.code === "SESSION_BUSY" ? 409 : result.code === "INFERENCE_BUSY" ? 429 : 0
  };
}
function normalizeInferenceBusyDetails(details, response) {
  const source = details && typeof details === "object" && !Array.isArray(details) ? details : {};
  const retryAfterMs = normalizePositiveInteger2(source.retryAfterMs) ?? normalizePositiveInteger2(source.retry_after_ms) ?? normalizeRetryAfterHeader(response) ?? 1e4;
  const retryAt = typeof source.retryAt === "string" && source.retryAt.trim() ? source.retryAt.trim() : new Date(Date.now() + retryAfterMs).toISOString();
  const stage = source.stage === "generation" || source.stage === "retrieval" ? source.stage : void 0;
  const reason = Array.isArray(source.reason) ? source.reason.filter((item) => typeof item === "string") : [];
  return {
    retryAfterMs,
    retryAt,
    ...stage ? { stage } : {},
    ...typeof source.model === "string" && source.model.trim() ? { model: source.model.trim() } : {},
    ...typeof source.resourceKey === "string" && source.resourceKey.trim() ? { resourceKey: source.resourceKey.trim() } : typeof source.resource_key === "string" && source.resource_key.trim() ? { resourceKey: source.resource_key.trim() } : {},
    reason
  };
}
function normalizeRetryAfterHeader(response) {
  const value = response ? getResponseHeader(response, "Retry-After") : void 0;
  if (!value) {
    return void 0;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1e3) : void 0;
}
function delayWithAbort(ms, signal) {
  if (signal.aborted) {
    return Promise.reject(new HelperFlowError("CANCELED", "\u8BF7\u6C42\u5DF2\u53D6\u6D88"));
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener?.("abort", handleAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const handleAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener?.("abort", handleAbort);
      reject(new HelperFlowError("CANCELED", "\u8BF7\u6C42\u5DF2\u53D6\u6D88"));
    };
    signal.addEventListener?.("abort", handleAbort, {
      once: true
    });
  });
}
async function* parsePrivateChatSse(response, signal) {
  if (response.stream) {
    yield* parsePrivateChatSseTextChunks(response.stream, signal);
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new HelperFlowError("STREAM_ERROR", "\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u6D41\u5F0F\u8BFB\u53D6");
  }
  yield* parsePrivateChatSseTextChunks(
    readResponseBodyTextChunks(reader, signal),
    signal
  );
}
async function* readResponseBodyTextChunks(reader, signal) {
  const decoder = new TextDecoder();
  const cancelReader = () => {
    void reader.cancel().catch(() => void 0);
  };
  if (signal?.aborted) {
    cancelReader();
    assertNotCanceled(signal);
  }
  signal?.addEventListener?.("abort", cancelReader, {
    once: true
  });
  try {
    while (true) {
      if (signal) {
        assertNotCanceled(signal);
      }
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) {
          throw new HelperFlowError("CANCELED", "\u8BF7\u6C42\u5DF2\u53D6\u6D88");
        }
        throw error;
      }
      const { done, value } = chunk;
      if (done) {
        if (signal?.aborted) {
          throw new HelperFlowError("CANCELED", "\u8BF7\u6C42\u5DF2\u53D6\u6D88");
        }
        const tail = decoder.decode();
        if (tail) {
          yield tail;
        }
        break;
      }
      yield decoder.decode(value, {
        stream: true
      });
    }
  } finally {
    signal?.removeEventListener?.("abort", cancelReader);
  }
}
async function* parsePrivateChatSseTextChunks(chunks, signal) {
  let buffer = "";
  try {
    for await (const chunk of chunks) {
      if (signal) {
        assertNotCanceled(signal);
      }
      buffer += chunk;
      buffer = buffer.replace(/\r\n/g, "\n");
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const event = parsePrivateChatSseBlock(block);
        if (event) {
          yield event;
        }
        separatorIndex = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new HelperFlowError("CANCELED", "\u8BF7\u6C42\u5DF2\u53D6\u6D88");
    }
    throw error;
  }
  if (signal) {
    assertNotCanceled(signal);
  }
  const tail = buffer.trim();
  if (tail) {
    const event = parsePrivateChatSseBlock(tail);
    if (event) {
      yield event;
    }
  }
}
function parsePrivateChatSseBlock(block) {
  const lines = block.split(/\n/);
  const dataLines = [];
  let eventName = "";
  for (const line of lines) {
    if (!line.trim() || line.startsWith(":")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line.trim();
    const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") {
      eventName = value.trim();
      continue;
    }
    if (field === "data") {
      dataLines.push(value);
    }
  }
  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") {
    return null;
  }
  try {
    const parsed = JSON.parse(payload);
    if (eventName && parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.type !== "string") {
      return {
        type: eventName,
        ...parsed
      };
    }
    return parsed;
  } catch {
    return null;
  }
}
function assertNotCanceled(signal) {
  if (signal.aborted) {
    throw new HelperFlowError("CANCELED", "\u8BF7\u6C42\u5DF2\u53D6\u6D88");
  }
}
function isCanceledError(error) {
  if (error instanceof HelperFlowError) {
    return error.code === "CANCELED";
  }
  return typeof DOMException !== "undefined" && error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
function normalizeErrorDetails(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      cause: error.cause
    };
  }
  return error;
}
function normalizeHelperFlowError(error) {
  if (error instanceof HelperFlowError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return {
      code: "CANCELED",
      message: "\u8BF7\u6C42\u5DF2\u53D6\u6D88",
      details: normalizeErrorDetails(error)
    };
  }
  return {
    code: "NETWORK_ERROR",
    message: "\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
    details: normalizeErrorDetails(error)
  };
}

export {
  ANALYTICS_QUEUE_STORAGE_KEY,
  ANALYTICS_ANONYMOUS_ID_STORAGE_KEY,
  ANALYTICS_SESSION_ID_STORAGE_KEY,
  MARKETING_VISITOR_ID_STORAGE_KEY,
  MARKETING_FIRST_TOUCH_STORAGE_KEY,
  MARKETING_LAST_TOUCH_STORAGE_KEY,
  DEFAULT_DEVICE_KEY_EXPORT_FILE_NAME,
  SDKHelper,
  isDeviceKeyRecord,
  serializeDeviceKeyRecordAsJson,
  buildDeviceKeyExportFileName,
  parseDeviceKeyRecordFromJson
};
//# sourceMappingURL=chunk-EGIUQFFH.js.map
