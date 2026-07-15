import {
  BrowserTSSDK
} from "./chunk-3CHM3SI6.js";
import {
  SDKHelper
} from "./chunk-EGIUQFFH.js";
import {
  createBrowserAdapter
} from "./chunk-5TENKU3C.js";
import {
  BROWSER_SDK_ERROR_CODES,
  createBrowserSdkError
} from "./chunk-66GHVPAJ.js";
import {
  clearCpuTeeCertificatePayload,
  readCpuTeeCertificatePayload,
  writeCpuTeeCertificatePayload
} from "./chunk-TUJODFD4.js";
import {
  decodeTdxQuote,
  extractSm2PublicKeyBase64FromCertificate
} from "./chunk-HJPAFGF2.js";
import {
  base64ToBytes,
  bytesToBase64,
  encryptDekWithPublicKeyBase64,
  encryptTextToBlobBase64,
  hexToBytes,
  isEncryptedBlobString,
  isFakeCipherPayload
} from "./chunk-RD53EFK2.js";

// src/facade.ts
var SDK_API_BASE_URL = "https://api.jinghua.security";
var SDK_CERTIFICATE_URL = `${SDK_API_BASE_URL}/api/internal/cpu-tee/certificate`;
var SDK_DEK_INIT_URL = `${SDK_API_BASE_URL}/api/sdk/dek/init`;
var SDK_VERSION = "1.0.15";
var version = SDK_VERSION;
var DEFAULT_CLIENT_SDK_OPTIONS = {
  appName: "client-tssdk",
  plaintextMode: false,
  apiBaseUrl: SDK_API_BASE_URL,
  certificateUrl: SDK_CERTIFICATE_URL,
  verifyQuoteUrl: `${SDK_API_BASE_URL}/api/verify-quote`,
  dekInitUrl: SDK_DEK_INIT_URL,
  fakeCipherMode: false,
  adapter: createBrowserAdapter()
};
var DEFAULT_MAX_CONVERSATION_ROUNDS = 20;
var CERTIFICATE_REFRESH_RETRY_DELAYS_MS = [200, 500, 1e3];
function createPlaintextStatus() {
  return {
    initialized: true,
    envReady: true,
    phaseLabel: "\u660E\u6587\u8054\u8C03\u6A21\u5F0F",
    capabilities: ["plaintext_transport"],
    encryptionKeyId: null,
    certFingerprint: null
  };
}
function isRecord(value) {
  return Boolean(value && typeof value === "object");
}
function derBase64ToCertificatePem(certData, runtime) {
  const certBase64 = bytesToBase64(base64ToBytes(certData, runtime), runtime);
  const lines = certBase64.match(/.{1,64}/g) || [];
  return [
    "-----BEGIN CERTIFICATE-----",
    ...lines,
    "-----END CERTIFICATE-----",
    ""
  ].join("\n");
}
function extractCertificatePublicKey(payload, runtime) {
  if (!isRecord(payload)) {
    throw createBrowserSdkError(
      BROWSER_SDK_ERROR_CODES.CERTIFICATE_PAYLOAD_INVALID,
      "certificate payload is invalid"
    );
  }
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw createBrowserSdkError(
      BROWSER_SDK_ERROR_CODES.CERTIFICATE_FETCH_FAILED,
      typeof payload.message === "string" && payload.message.trim() ? payload.message : "\u83B7\u53D6 CPU-TEE \u8BC1\u4E66\u5931\u8D25"
    );
  }
  const data = isRecord(payload.data) ? payload.data : payload;
  const publicKey = typeof data.public_key === "string" ? data.public_key.trim() : "";
  const publicKeyHex = typeof data.public_key_hex === "string" ? data.public_key_hex.trim() : "";
  const certificatePem = typeof data.certificate_pem === "string" && data.certificate_pem.trim() ? data.certificate_pem : typeof data.cert_data === "string" && data.cert_data.trim() ? derBase64ToCertificatePem(data.cert_data, runtime) : "";
  if (publicKey) {
    return publicKey;
  }
  if (publicKeyHex) {
    try {
      return bytesToBase64(hexToBytes(publicKeyHex), runtime);
    } catch {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.CERTIFICATE_PAYLOAD_INVALID,
        "CPU-TEE \u8BC1\u4E66 public_key_hex \u65E0\u6548"
      );
    }
  }
  if (certificatePem) {
    return extractSm2PublicKeyBase64FromCertificate(certificatePem);
  }
  throw createBrowserSdkError(
    BROWSER_SDK_ERROR_CODES.CERTIFICATE_PAYLOAD_INVALID,
    "CPU-TEE \u8BC1\u4E66\u7F3A\u5C11 public_key"
  );
}
function normalizeUserId(userId) {
  return userId.trim();
}
function normalizeBaseUrl(value, fallback) {
  return (value || fallback).trim().replace(/\/+$/, "") || fallback;
}
function normalizeEndpointUrl(value, fallback) {
  return (value || fallback).trim() || fallback;
}
function normalizeRefreshAttempts(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 3;
  }
  return Math.min(3, Math.max(1, Math.floor(value)));
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var ClientTSSDK = class {
  static version = SDK_VERSION;
  version = SDK_VERSION;
  browserSdk = new BrowserTSSDK();
  helper;
  initPromise = null;
  options = {
    ...DEFAULT_CLIENT_SDK_OPTIONS
  };
  constructor(options) {
    this.helper = new SDKHelper(this);
    if (options) {
      this.options = this.mergeOptions(options);
    }
  }
  getFileTypes() {
    return this.helper.getFileTypes();
  }
  init(options) {
    if (options) {
      this.options = this.mergeOptions(options);
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    const nextInitPromise = (async () => {
      if (this.isPlaintextMode()) {
        return {
          ok: true,
          appName: this.options.appName,
          plaintextMode: true
        };
      }
      const result = await this.browserSdk.init(this.options);
      return {
        ok: true,
        appName: result.appName,
        plaintextMode: false
      };
    })().catch((error) => {
      this.initPromise = null;
      throw error;
    });
    this.initPromise = nextInitPromise;
    return nextInitPromise;
  }
  getUserId() {
    return this.resolveUserId();
  }
  getApiBaseUrl() {
    return this.options.apiBaseUrl;
  }
  getAdapter() {
    return this.options.adapter;
  }
  decodeTdxQuote(input) {
    return decodeTdxQuote(input);
  }
  async envInit() {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      return {
        ok: true,
        appName: this.options.appName,
        encryptionKeyId: "plaintext-mode",
        certFingerprint: "plaintext-mode",
        created: false
      };
    }
    return this.browserSdk.envInit();
  }
  clearCpuTeeCertificateCache() {
    clearCpuTeeCertificatePayload(
      this.options.certificateUrl || SDK_CERTIFICATE_URL,
      this.options.adapter.storage
    );
  }
  async refreshCpuTeeCertificate(options) {
    await this.ensureInitialized();
    if (this.isPlaintextMode() || this.options.fakeCipherMode) {
      return;
    }
    const certificateUrl = this.options.certificateUrl || SDK_CERTIFICATE_URL;
    const attempts = normalizeRefreshAttempts(options?.attempts);
    let lastError = null;
    for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
      try {
        const payload = await this.fetchCertificatePayload(certificateUrl);
        extractCertificatePublicKey(payload, this.options.adapter.runtime);
        writeCpuTeeCertificatePayload(
          certificateUrl,
          payload,
          Date.now(),
          this.options.adapter.storage
        );
        return;
      } catch (error) {
        lastError = error;
        if (attemptIndex < attempts - 1) {
          await delay(CERTIFICATE_REFRESH_RETRY_DELAYS_MS[attemptIndex] || 1e3);
        }
      }
    }
    throw lastError;
  }
  async ensureReady() {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      return this;
    }
    const activeDeviceKey = this.browserSdk.getActiveDeviceKeyRecord();
    if (!activeDeviceKey?.dekHex.trim()) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        "\u5F53\u524D\u79C1\u94A5\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5148\u5BFC\u5165\u5E76\u9A8C\u8BC1\u79C1\u94A5"
      );
    }
    await this.browserSdk.envInit();
    return this;
  }
  async generateDeviceKey(options) {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      return null;
    }
    if (!options?.force) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        "\u4E91\u7AEF DEK \u65B9\u6848\u4E0D\u518D\u652F\u6301\u76F4\u63A5\u751F\u6210\u672C\u5730\u79C1\u94A5\uFF0C\u8BF7\u8C03\u7528 ensureCloudDeviceKey()"
      );
    }
    await this.browserSdk.envInit();
    const deviceKey = await this.browserSdk.rotateActiveDeviceKeyRecord();
    return deviceKey;
  }
  async ensureCloudDeviceKey() {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      return null;
    }
    const result = await this.helper.ensureCloudDeviceKey();
    if (!result.ok) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        result.message,
        result.details
      );
    }
    return result.data;
  }
  async getDeviceKeyState() {
    await this.ensureInitialized();
    const result = await this.helper.getDeviceKeyState();
    if (!result.ok) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        result.message,
        result.details
      );
    }
    return result.data;
  }
  async getCloudDeviceKey() {
    await this.ensureInitialized();
    const result = await this.helper.getCloudDeviceKey();
    if (!result.ok) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        result.message,
        result.details
      );
    }
    return result.data;
  }
  async uploadCloudDeviceKey(deviceKey) {
    await this.ensureInitialized();
    const result = await this.helper.uploadCloudDeviceKey(deviceKey);
    if (!result.ok) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        result.message,
        result.details
      );
    }
    return result.data;
  }
  async resetCloudDeviceKey() {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      return null;
    }
    const result = await this.helper.resetCloudDeviceKey();
    if (!result.ok) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        result.message,
        result.details
      );
    }
    return result.data;
  }
  exportActiveDeviceKey() {
    if (this.isPlaintextMode()) {
      return null;
    }
    return this.helper.exportActiveDeviceKey();
  }
  async getDekInitState(userId) {
    await this.ensureInitialized();
    const result = await this.helper.getDekInitState(userId);
    if (!result.ok) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        result.message,
        result.details
      );
    }
    return result.data;
  }
  async setDekInitState(input = {}) {
    await this.ensureInitialized();
    const result = await this.helper.setDekInitState(input);
    if (!result.ok) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        result.message,
        result.details
      );
    }
    return result.data;
  }
  async activateDeviceKey(deviceKey) {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      return this;
    }
    this.browserSdk.setActiveDeviceKeyRecord(deviceKey);
    await this.browserSdk.envInit();
    return this;
  }
  getActiveDeviceKeyRecord() {
    if (this.isPlaintextMode()) {
      return null;
    }
    return this.browserSdk.getActiveDeviceKeyRecord();
  }
  setActiveDeviceKeyRecord(record) {
    if (this.isPlaintextMode()) {
      return null;
    }
    return this.browserSdk.setActiveDeviceKeyRecord(record);
  }
  clearActiveDeviceKeyRecord() {
    if (this.isPlaintextMode()) {
      return;
    }
    this.browserSdk.clearActiveDeviceKeyRecord();
  }
  destroy() {
    this.helper.destroy();
    this.browserSdk.destroy();
    this.initPromise = null;
    this.options = {
      ...this.options,
      userId: void 0
    };
  }
  destory() {
    this.destroy();
  }
  async encryptText(text, options) {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      await options?.onStatusChange?.({
        status: "ciphertext_ready",
        message: "\u660E\u6587\u76F4\u4F20\u5DF2\u542F\u7528",
        request_id: "plaintext-mode"
      });
      return text;
    }
    return this.browserSdk.encryptText(text, options);
  }
  async decryptText(cipher) {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      return cipher;
    }
    return this.browserSdk.decryptText(cipher);
  }
  async encryptBytes(input, options) {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.PLAINTEXT_MODE_UNSUPPORTED,
        "\u5F53\u524D\u660E\u6587\u8054\u8C03\u6A21\u5F0F\u6682\u4E0D\u652F\u6301\u9644\u4EF6\uFF0C\u8BF7\u5148\u53EA\u6D4B\u8BD5\u6587\u672C\u63A5\u53E3"
      );
    }
    return this.browserSdk.encryptBytes(input, options);
  }
  async decryptBytes(cipher) {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.PLAINTEXT_MODE_UNSUPPORTED,
        "\u5F53\u524D\u660E\u6587\u8054\u8C03\u6A21\u5F0F\u6682\u4E0D\u652F\u6301\u9644\u4EF6\u89E3\u5BC6"
      );
    }
    return this.browserSdk.decryptBytes(cipher);
  }
  async encryptFile(input, options) {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.PLAINTEXT_MODE_UNSUPPORTED,
        "\u5F53\u524D\u660E\u6587\u8054\u8C03\u6A21\u5F0F\u6682\u4E0D\u652F\u6301\u9644\u4EF6\uFF0C\u8BF7\u5148\u53EA\u6D4B\u8BD5\u6587\u672C\u63A5\u53E3"
      );
    }
    return this.browserSdk.encryptFile(input, options);
  }
  async decryptFile(cipher) {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.PLAINTEXT_MODE_UNSUPPORTED,
        "\u5F53\u524D\u660E\u6587\u8054\u8C03\u6A21\u5F0F\u6682\u4E0D\u652F\u6301\u9644\u4EF6\u89E3\u5BC6"
      );
    }
    return this.browserSdk.decryptFile(cipher);
  }
  getStatus() {
    if (this.isPlaintextMode()) {
      return createPlaintextStatus();
    }
    return this.browserSdk.getStatus();
  }
  assertEncryptedBlobHex(value, fieldName = "ciphertext") {
    const normalizedValue = value.trim();
    if (this.options.fakeCipherMode && isFakeCipherPayload(normalizedValue)) {
      return normalizedValue;
    }
    if (!isEncryptedBlobString(normalizedValue, this.options.adapter.runtime)) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.INVALID_CIPHERTEXT,
        `${fieldName} \u4E0D\u662F\u5408\u6CD5\u5BC6\u6587\uFF0C\u8BF7\u786E\u8BA4\u5F53\u524D\u4F20\u5165\u7684\u662F\u5BC6\u6587\u800C\u4E0D\u662F\u660E\u6587`
      );
    }
    return normalizedValue;
  }
  async buildGenerationTransport(input) {
    if (this.isPlaintextMode()) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.PLAINTEXT_MODE_UNSUPPORTED,
        "\u5F53\u524D\u660E\u6587\u8054\u8C03\u6A21\u5F0F\u4E0D\u751F\u6210\u5BC6\u6001 generation_transport"
      );
    }
    await this.ensureReady();
    const deviceKey = this.browserSdk.getActiveDeviceKeyRecord();
    if (!deviceKey) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        "\u5F53\u524D\u79C1\u94A5\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5148\u5BFC\u5165\u5E76\u9A8C\u8BC1\u79C1\u94A5"
      );
    }
    const encryptedUserData = this.assertEncryptedBlobHex(
      input.encryptedUserData,
      "encrypted_user_data"
    );
    if (this.options.fakeCipherMode) {
      const encryptedTimestamp2 = await this.encryptText(`${Date.now() / 1e3}`);
      const encryptedSystemData2 = input.encryptedSystemData ? this.assertEncryptedBlobHex(
        input.encryptedSystemData,
        "encrypted_system_data"
      ) : "";
      const encryptedDek2 = deviceKey.dekHex || `fake-dek-${deviceKey.encryptionKeyId}`;
      return {
        function: "Encryption_Generation",
        encrypted_dek: encryptedDek2,
        encrypted_dek_len: encryptedDek2.length,
        encrypted_timestamp: encryptedTimestamp2,
        encrypted_timestamp_len: encryptedTimestamp2.length,
        encrypted_system_data: encryptedSystemData2,
        encrypted_system_data_len: encryptedSystemData2.length,
        encrypted_user_data: encryptedUserData,
        encrypted_user_data_len: encryptedUserData.length,
        session_id: input.sessionId || null
      };
    }
    const publicKey = await this.getCurrentCertificatePublicKey();
    const encryptedTimestamp = await encryptTextToBlobBase64(
      `${Date.now() / 1e3}`,
      deviceKey.dekHex,
      this.options.adapter.runtime
    );
    const encryptedDek = await encryptDekWithPublicKeyBase64(
      deviceKey.dekHex,
      publicKey,
      this.options.adapter.runtime
    );
    const encryptedSystemData = input.encryptedSystemData ? this.assertEncryptedBlobHex(
      input.encryptedSystemData,
      "encrypted_system_data"
    ) : "";
    return {
      function: "Encryption_Generation",
      encrypted_dek: encryptedDek,
      encrypted_dek_len: encryptedDek.length,
      encrypted_timestamp: encryptedTimestamp,
      encrypted_timestamp_len: encryptedTimestamp.length,
      encrypted_system_data: encryptedSystemData,
      encrypted_system_data_len: encryptedSystemData.length,
      encrypted_user_data: encryptedUserData,
      encrypted_user_data_len: encryptedUserData.length,
      session_id: input.sessionId || null
    };
  }
  async buildAsrTransport(input) {
    if (this.isPlaintextMode()) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.PLAINTEXT_MODE_UNSUPPORTED,
        "\u5F53\u524D\u660E\u6587\u8054\u8C03\u6A21\u5F0F\u4E0D\u652F\u6301\u5BC6\u6001 ASR"
      );
    }
    await this.ensureReady();
    const deviceKey = this.browserSdk.getActiveDeviceKeyRecord();
    if (!deviceKey) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        "\u5F53\u524D\u79C1\u94A5\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5148\u5BFC\u5165\u5E76\u9A8C\u8BC1\u79C1\u94A5"
      );
    }
    const encryptedAudio = this.assertEncryptedBlobHex(
      input.encryptedAudio,
      "encrypted_audio"
    );
    const userId = input.userId.trim();
    const sessionId = input.sessionId?.trim();
    const asrModel = input.asrModel?.trim();
    const encryptedDek = this.options.fakeCipherMode ? deviceKey.dekHex || `fake-dek-${deviceKey.encryptionKeyId}` : await encryptDekWithPublicKeyBase64(
      deviceKey.dekHex,
      await this.getCurrentCertificatePublicKey(),
      this.options.adapter.runtime
    );
    return {
      function: "speechAsr",
      params: {
        encrypted_dek: encryptedDek,
        encrypted_dek_len: encryptedDek.length,
        encrypted_audio: encryptedAudio,
        alg_id: 4,
        user_id: userId,
        ...sessionId ? { session_id: sessionId } : {},
        timestamp: Date.now() / 1e3,
        ...asrModel ? { asr_model: asrModel } : {}
      }
    };
  }
  async prepareChatMessage(input) {
    await this.ensureInitialized();
    if (this.isPlaintextMode()) {
      return {
        contentText: input.text,
        plaintextMode: true
      };
    }
    const contentText = this.assertEncryptedBlobHex(
      await this.encryptText(input.text, input.encryptOptions),
      "encrypted_user_data"
    );
    const generationTransport = await this.buildGenerationTransport({
      encryptedUserData: contentText,
      sessionId: input.sessionId,
      encryptedSystemData: input.encryptedSystemData
    });
    return {
      contentText,
      plaintextMode: false,
      generationTransport
    };
  }
  async compactStreamedAssistantMessage(input) {
    const contentDeltas = normalizeCipherTextList(input.contentDeltas);
    const reasoningDeltas = normalizeCipherTextList(input.reasoningDeltas);
    const compactReasoning = input.compactReasoning !== false;
    const content = await this.compactTextValues(contentDeltas);
    const reasoning = reasoningDeltas.length === 0 ? null : compactReasoning ? await this.compactTextValues(reasoningDeltas) : reasoningDeltas.map((text) => ({ type: "text", text }));
    return {
      message: {
        role: "assistant",
        content,
        reasoning,
        requestId: input.requestId ?? null,
        tokenCount: input.tokenCount ?? null,
        createdAt: input.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
        ...input.webSearchSources?.length ? { webSearchSources: input.webSearchSources } : {}
      },
      stats: {
        contentDeltaCount: input.contentDeltas.length,
        reasoningDeltaCount: input.reasoningDeltas?.length ?? 0,
        compactedContent: contentDeltas.length > 1,
        compactedReasoning: compactReasoning && reasoningDeltas.length > 1
      }
    };
  }
  async compactAssistantHistoryMessage(message) {
    if (message.role !== "assistant") {
      return message;
    }
    const content = await this.compactAssistantContent(message.content);
    const reasoning = await this.compactReasoning(message.reasoning);
    if (content === message.content && (reasoning === message.reasoning || !message.reasoning && reasoning === null)) {
      return message;
    }
    return {
      ...message,
      content,
      reasoning
    };
  }
  async buildConversationMessages(input) {
    const maxRounds = normalizeMaxRounds(input.maxRounds);
    const selectedHistory = selectRecentConversationHistory(
      input.history,
      maxRounds
    );
    const compactedHistory = await Promise.all(
      selectedHistory.messages.map(
        (message) => this.compactAssistantHistoryMessage(
          stripTransportOnlyMessageFields(message)
        )
      )
    );
    return {
      messages: [...compactedHistory, input.currentUserMessage].map(
        stripTransportOnlyMessageFields
      ),
      includedRounds: selectedHistory.includedRounds,
      droppedMessages: input.history.length - selectedHistory.messages.length
    };
  }
  mergeOptions(options) {
    const apiBaseUrl = normalizeBaseUrl(
      options?.apiBaseUrl || this.options.apiBaseUrl,
      DEFAULT_CLIENT_SDK_OPTIONS.apiBaseUrl
    );
    const shouldDeriveUrlsFromApiBase = Boolean(options?.apiBaseUrl);
    return {
      ...DEFAULT_CLIENT_SDK_OPTIONS,
      ...this.options,
      ...options,
      apiBaseUrl,
      appName: options?.appName || this.options.appName || DEFAULT_CLIENT_SDK_OPTIONS.appName,
      plaintextMode: options?.plaintextMode ?? this.options.plaintextMode ?? DEFAULT_CLIENT_SDK_OPTIONS.plaintextMode,
      fakeCipherMode: options?.fakeCipherMode ?? this.options.fakeCipherMode ?? DEFAULT_CLIENT_SDK_OPTIONS.fakeCipherMode,
      certificateUrl: normalizeEndpointUrl(
        options?.certificateUrl || (shouldDeriveUrlsFromApiBase ? `${apiBaseUrl}/api/internal/cpu-tee/certificate` : this.options.certificateUrl),
        DEFAULT_CLIENT_SDK_OPTIONS.certificateUrl
      ),
      verifyQuoteUrl: normalizeEndpointUrl(
        options?.verifyQuoteUrl || (shouldDeriveUrlsFromApiBase ? `${apiBaseUrl}/api/verify-quote` : this.options.verifyQuoteUrl),
        DEFAULT_CLIENT_SDK_OPTIONS.verifyQuoteUrl
      ),
      dekInitUrl: normalizeEndpointUrl(
        options?.dekInitUrl || (shouldDeriveUrlsFromApiBase ? `${apiBaseUrl}/api/sdk/dek/init` : this.options.dekInitUrl),
        DEFAULT_CLIENT_SDK_OPTIONS.dekInitUrl
      ),
      adapter: options?.adapter || this.options.adapter || DEFAULT_CLIENT_SDK_OPTIONS.adapter
    };
  }
  async ensureInitialized() {
    if (this.initPromise) {
      return this.initPromise;
    }
    return this.init();
  }
  isPlaintextMode() {
    return Boolean(this.options.plaintextMode);
  }
  resolveUserId(userId) {
    return normalizeUserId(userId || this.options.userId || "");
  }
  resolveDekInitStatusUrl() {
    return this.options.dekInitUrl || SDK_DEK_INIT_URL;
  }
  resolveDekInitUpdateUrl() {
    return this.options.dekInitUrl || SDK_DEK_INIT_URL;
  }
  async getCurrentCertificatePublicKey() {
    const certificateUrl = this.options.certificateUrl || SDK_CERTIFICATE_URL;
    const cachedPayload = readCpuTeeCertificatePayload(
      certificateUrl,
      Date.now(),
      this.options.adapter.storage
    );
    if (cachedPayload) {
      try {
        return extractCertificatePublicKey(
          cachedPayload,
          this.options.adapter.runtime
        );
      } catch {
        clearCpuTeeCertificatePayload(certificateUrl, this.options.adapter.storage);
      }
    }
    const payload = await this.fetchCertificatePayload(certificateUrl);
    const publicKey = extractCertificatePublicKey(
      payload,
      this.options.adapter.runtime
    );
    writeCpuTeeCertificatePayload(
      certificateUrl,
      payload,
      Date.now(),
      this.options.adapter.storage
    );
    return publicKey;
  }
  async fetchCertificatePayload(certificateUrl) {
    const response = await this.options.adapter.http.request({
      url: certificateUrl,
      method: "GET"
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.CERTIFICATE_FETCH_FAILED,
        `\u83B7\u53D6 CPU-TEE \u8BC1\u4E66\u5931\u8D25\uFF0C\u72B6\u6001\u7801 ${response.status}`
      );
    }
    return payload;
  }
  async compactTextValues(values) {
    if (values.length === 0) {
      return [];
    }
    if (values.length === 1) {
      return [{ type: "text", text: values[0] }];
    }
    const plainText = (await Promise.all(values.map((value) => this.decryptText(value)))).join("");
    const encryptedText = await this.encryptText(plainText);
    return [{ type: "text", text: encryptedText }];
  }
  async compactAssistantContent(content) {
    const textBlocks = content.filter(isTextBlock);
    const compactableTextValues = normalizeCipherTextList(
      textBlocks.map((block) => block.text)
    );
    if (compactableTextValues.length <= 1) {
      return content;
    }
    const compactedText = await this.compactTextValues(compactableTextValues);
    const nextContent = [];
    let insertedCompactedText = false;
    for (const block of content) {
      if (isFileBlock(block)) {
        nextContent.push(block);
        continue;
      }
      if (!block.text.trim()) {
        continue;
      }
      if (insertedCompactedText) {
        continue;
      }
      nextContent.push(...compactedText);
      insertedCompactedText = true;
    }
    return nextContent;
  }
  async compactReasoning(reasoning) {
    if (!reasoning?.length) {
      return null;
    }
    const compactableTextValues = normalizeCipherTextList(
      reasoning.map((block) => block.text)
    );
    if (compactableTextValues.length === 0) {
      return null;
    }
    if (compactableTextValues.length === 1) {
      return reasoning;
    }
    return this.compactTextValues(compactableTextValues);
  }
};
function normalizeCipherTextList(values) {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
function normalizeMaxRounds(maxRounds) {
  if (typeof maxRounds !== "number" || !Number.isFinite(maxRounds)) {
    return DEFAULT_MAX_CONVERSATION_ROUNDS;
  }
  return Math.max(0, Math.floor(maxRounds));
}
function isTextBlock(block) {
  return block.type === "text";
}
function isFileBlock(block) {
  return block.type === "file";
}
function hasMessageTransportContent(message) {
  return message.content.some((block) => {
    if (isTextBlock(block)) {
      return Boolean(block.text.trim());
    }
    return Boolean(
      block.file.attachment_id?.trim() || block.file.encryption_data?.trim()
    );
  });
}
function stripTransportOnlyMessageFields(message) {
  if (!("reasoning" in message) && !("webSearchSources" in message)) {
    return message;
  }
  const {
    reasoning: _reasoning,
    webSearchSources: _webSearchSources,
    ...payload
  } = message;
  return payload;
}
function selectRecentConversationHistory(history, maxRounds) {
  const rounds = [];
  let pendingUserIndex = null;
  history.forEach((message, index) => {
    if (message.role === "system") {
      return;
    }
    if (message.role === "user") {
      pendingUserIndex = hasMessageTransportContent(message) ? index : null;
      return;
    }
    if (message.role === "assistant" && pendingUserIndex !== null) {
      if (hasMessageTransportContent(message)) {
        rounds.push({
          userIndex: pendingUserIndex,
          assistantIndex: index
        });
      }
      pendingUserIndex = null;
    }
  });
  const includedRounds = maxRounds === 0 ? [] : rounds.slice(-maxRounds);
  const includedIndexes = /* @__PURE__ */ new Set();
  history.forEach((message, index) => {
    if (message.role === "system") {
      includedIndexes.add(index);
    }
  });
  includedRounds.forEach((round) => {
    includedIndexes.add(round.userIndex);
    includedIndexes.add(round.assistantIndex);
  });
  return {
    messages: history.filter((_, index) => includedIndexes.has(index)),
    includedRounds: includedRounds.length
  };
}

export {
  SDK_VERSION,
  version,
  ClientTSSDK
};
//# sourceMappingURL=chunk-JGOVNYGK.js.map
