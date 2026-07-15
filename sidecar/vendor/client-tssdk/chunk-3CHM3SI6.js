import {
  createBrowserAdapter
} from "./chunk-5TENKU3C.js";
import {
  BROWSER_SDK_ERROR_CODES,
  createBrowserSdkError,
  isBrowserSdkError
} from "./chunk-66GHVPAJ.js";
import {
  clearCpuTeeCertificatePayload,
  readCpuTeeCertificatePayload,
  writeCpuTeeCertificatePayload
} from "./chunk-TUJODFD4.js";
import {
  extractSm2PublicKeyBase64FromCertificate,
  verifyTdxCertificate,
  verifyTdxQuote,
  verifyTdxQuoteCertificatePublicKey
} from "./chunk-HJPAFGF2.js";
import {
  base64ToBytes,
  bytesToBase64,
  createEncryptionKeyIdAsync,
  createRequestIdAsync,
  decodeFakeBytesCipher,
  decodeFakeTextCipher,
  decryptBytesFromBlobEncoded,
  decryptTextFromBlobEncoded,
  encodeFakeBytesCipher,
  encodeFakeTextCipher,
  encryptBytesToBlobBase64,
  encryptTextToBlobBase64,
  generateDekHexAsync,
  hexToBytes,
  normalizeBytesInput,
  normalizeFileToBytes
} from "./chunk-RD53EFK2.js";

// src/client.ts
var STATUS_MESSAGES = {
  cpu_tee_processing: "CPU-TEE \u9A8C\u8BC1\u548C\u5904\u7406\u4E2D",
  gpu_cipher_computing: "GPU \u5BC6\u6587\u8BA1\u7B97\u4E2D",
  ciphertext_ready: "\u5BC6\u6587\u7ED3\u679C\u5DF2\u751F\u6210"
};
var SDK_CAPABILITIES = [
  "local_init",
  "env_init",
  "remote_dek_init_state",
  "encrypt_text",
  "decrypt_text",
  "encrypt_bytes",
  "decrypt_bytes",
  "encrypt_file",
  "decrypt_file",
  "verify_cpu_tee_certificate",
  "verify_tdx_quote",
  "verify_tdx_quote_certificate_public_key"
];
var SDK_API_BASE_URL = "https://api.jinghua.security";
var DEFAULT_OPTIONS = {
  appName: "browser-sdk",
  apiBaseUrl: SDK_API_BASE_URL,
  certificateUrl: `${SDK_API_BASE_URL}/api/internal/cpu-tee/certificate`,
  verifyQuoteUrl: `${SDK_API_BASE_URL}/api/verify-quote`,
  fakeCipherMode: false,
  adapter: createBrowserAdapter()
};
var DEK_HEX_PATTERN = /^[0-9a-f]{64}$/i;
function isInvalidCiphertextError(error) {
  return error instanceof Error && (error.message === "invalid hex" || error.message === "invalid base64" || error.message === "blob too short");
}
function isDecryptKeyMismatchError(error) {
  return error instanceof Error && error.name === "OperationError";
}
function toSdkError(error, code, message) {
  if (isBrowserSdkError(error)) {
    return error;
  }
  return createBrowserSdkError(code, message, error);
}
function normalizeApiMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if ("message" in payload && typeof payload.message === "string") {
    return payload.message;
  }
  if ("error" in payload && typeof payload.error === "string") {
    return payload.error;
  }
  if ("error" in payload && payload.error && typeof payload.error === "object" && "message" in payload.error && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return null;
}
function isCertificateEnvelope(payload) {
  return Boolean(payload && typeof payload === "object" && "data" in payload);
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
function normalizeCertificatePayload(payload, runtime) {
  const data = isCertificateEnvelope(payload) ? payload.data : payload;
  if (isCertificateEnvelope(payload) && typeof payload.code === "number" && payload.code !== 0) {
    throw createBrowserSdkError(
      BROWSER_SDK_ERROR_CODES.CERTIFICATE_FETCH_FAILED,
      payload.message || "\u83B7\u53D6 CPU-TEE \u8BC1\u4E66\u5931\u8D25"
    );
  }
  if (!data || typeof data !== "object") {
    throw createBrowserSdkError(
      BROWSER_SDK_ERROR_CODES.CERTIFICATE_PAYLOAD_INVALID,
      "certificate payload is invalid"
    );
  }
  const certificate = data;
  const certificatePem = typeof certificate.certificate_pem === "string" && certificate.certificate_pem.trim() ? certificate.certificate_pem : typeof certificate.cert_data === "string" && certificate.cert_data.trim() ? derBase64ToCertificatePem(certificate.cert_data, runtime) : "";
  const publicKey = typeof certificate.public_key === "string" && certificate.public_key.trim() ? certificate.public_key : typeof certificate.public_key_hex === "string" && certificate.public_key_hex.trim() ? bytesToBase64(hexToBytes(certificate.public_key_hex), runtime) : certificatePem ? extractSm2PublicKeyBase64FromCertificate(certificatePem) : "";
  if (!certificatePem || !publicKey || typeof certificate.fingerprint !== "string" || typeof certificate.issued_at !== "string" || typeof certificate.expires_at !== "string" || typeof certificate.tdx_quote !== "string") {
    throw createBrowserSdkError(
      BROWSER_SDK_ERROR_CODES.CERTIFICATE_PAYLOAD_INVALID,
      "certificate payload is missing required fields"
    );
  }
  return {
    certificate_pem: certificatePem,
    public_key: publicKey,
    public_key_hex: typeof certificate.public_key_hex === "string" ? certificate.public_key_hex : void 0,
    fingerprint: certificate.fingerprint,
    issued_at: certificate.issued_at,
    expires_at: certificate.expires_at,
    tdx_quote: certificate.tdx_quote,
    certificate_sn: typeof certificate.certificate_sn === "string" ? certificate.certificate_sn : void 0,
    version: typeof certificate.version === "string" ? certificate.version : void 0
  };
}
function normalizeBaseUrl(value, fallback) {
  return (value || fallback).trim().replace(/\/+$/, "") || fallback;
}
function normalizeEndpointUrl(value, fallback) {
  return (value || fallback).trim() || fallback;
}
async function emitStatusSequence(onStatusChange, requestId) {
  if (!onStatusChange) {
    return;
  }
  const sequence = [
    "cpu_tee_processing",
    "gpu_cipher_computing",
    "ciphertext_ready"
  ];
  for (const status of sequence) {
    await onStatusChange({
      status,
      message: STATUS_MESSAGES[status],
      request_id: requestId
    });
  }
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
var BrowserTSSDK = class {
  // options 在 init 后稳定下来，后续 envInit / encrypt / decrypt 都基于这份配置工作。
  options = DEFAULT_OPTIONS;
  initialized = false;
  envReady = false;
  phaseLabel = "\u672A\u521D\u59CB\u5316";
  activeDeviceKey = null;
  activeCertificate = null;
  initPromise = null;
  envInitPromise = null;
  destroyVersion = 0;
  getRuntime() {
    return this.options.adapter.runtime;
  }
  // 初始化 SDK 基础配置；这是轻量初始化，不会触发远端环境校验。
  init(options) {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = (async () => {
      this.options = {
        ...DEFAULT_OPTIONS,
        ...this.options,
        ...options,
        apiBaseUrl: normalizeBaseUrl(
          options?.apiBaseUrl || this.options.apiBaseUrl,
          DEFAULT_OPTIONS.apiBaseUrl
        ),
        certificateUrl: normalizeEndpointUrl(
          options?.certificateUrl || (options?.apiBaseUrl ? `${normalizeBaseUrl(options.apiBaseUrl, DEFAULT_OPTIONS.apiBaseUrl)}/api/internal/cpu-tee/certificate` : this.options.certificateUrl),
          DEFAULT_OPTIONS.certificateUrl
        ),
        verifyQuoteUrl: normalizeEndpointUrl(
          options?.verifyQuoteUrl || (options?.apiBaseUrl ? `${normalizeBaseUrl(options.apiBaseUrl, DEFAULT_OPTIONS.apiBaseUrl)}/api/verify-quote` : this.options.verifyQuoteUrl),
          DEFAULT_OPTIONS.verifyQuoteUrl
        ),
        fakeCipherMode: options?.fakeCipherMode ?? this.options.fakeCipherMode ?? DEFAULT_OPTIONS.fakeCipherMode,
        adapter: options?.adapter || this.options.adapter || DEFAULT_OPTIONS.adapter
      };
      this.initialized = true;
      this.phaseLabel = "\u5DF2\u521D\u59CB\u5316";
      return {
        ok: true,
        appName: this.options.appName
      };
    })();
    return this.initPromise;
  }
  // 完成可信环境初始化：拉证书、验 TDX，并确保当前运行态存在可用 DEK。
  async envInit() {
    if (this.envInitPromise) {
      return this.envInitPromise;
    }
    const stateVersion = this.destroyVersion;
    this.envInitPromise = (async () => {
      await this.init();
      this.assertStateVersion(stateVersion);
      if (this.options.fakeCipherMode) {
        const now2 = (/* @__PURE__ */ new Date()).toISOString();
        let created2 = false;
        const activeRecord2 = this.activeDeviceKey?.dekHex.trim() ? {
          ...this.activeDeviceKey,
          updatedAt: now2
        } : await (async () => {
          created2 = true;
          return {
            encryptionKeyId: await createEncryptionKeyIdAsync(this.getRuntime()),
            dekHex: await generateDekHexAsync(this.getRuntime()),
            certFingerprint: "fake-cipher",
            createdAt: now2,
            updatedAt: now2
          };
        })();
        this.assertStateVersion(stateVersion);
        this.activeDeviceKey = cloneDeviceKeyRecord(activeRecord2);
        this.activeCertificate = {
          certificate_pem: "fake-cipher",
          public_key: "fake-cipher",
          fingerprint: "fake-cipher",
          issued_at: now2,
          expires_at: now2,
          tdx_quote: "fake-cipher"
        };
        this.envReady = true;
        this.phaseLabel = "\u8BBE\u5907\u7EA7\u672C\u5730\u5BC6\u94A5\u5DF2\u5C31\u7EEA";
        return {
          ok: true,
          appName: this.options.appName,
          encryptionKeyId: activeRecord2.encryptionKeyId,
          certFingerprint: activeRecord2.certFingerprint,
          created: created2
        };
      }
      this.phaseLabel = "CPU-TEE \u6821\u9A8C\u4E2D";
      let certificateFromCache = false;
      let certificate = null;
      const cachedPayload = readCpuTeeCertificatePayload(
        this.options.certificateUrl,
        Date.now(),
        this.options.adapter.storage
      );
      if (cachedPayload) {
        try {
          certificate = normalizeCertificatePayload(cachedPayload, this.getRuntime());
          certificateFromCache = true;
        } catch {
          clearCpuTeeCertificatePayload(
            this.options.certificateUrl,
            this.options.adapter.storage
          );
        }
      }
      if (!certificate) {
        const requestId = await createRequestIdAsync(this.getRuntime());
        const response = await this.options.adapter.http.request({
          url: this.options.certificateUrl,
          method: "GET",
          headers: {
            "X-Request-Id": requestId
          }
        });
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!response.ok) {
          this.phaseLabel = "\u521D\u59CB\u5316\u5931\u8D25";
          throw createBrowserSdkError(
            BROWSER_SDK_ERROR_CODES.CERTIFICATE_FETCH_FAILED,
            normalizeApiMessage(payload) || `\u83B7\u53D6 CPU-TEE \u8BC1\u4E66\u5931\u8D25\uFF0C\u72B6\u6001\u7801 ${response.status}`
          );
        }
        certificate = normalizeCertificatePayload(payload, this.getRuntime());
        writeCpuTeeCertificatePayload(
          this.options.certificateUrl,
          certificate,
          Date.now(),
          this.options.adapter.storage
        );
      }
      this.assertStateVersion(stateVersion);
      try {
        await verifyTdxCertificate(certificate.certificate_pem, {
          expectedFingerprint: certificate.fingerprint,
          issuedAt: certificate.issued_at,
          expiresAt: certificate.expires_at,
          caCertificatePem: this.options.caCertificatePem,
          caPublicKeyPem: this.options.caPublicKeyPem
        });
      } catch (error) {
        if (certificateFromCache) {
          clearCpuTeeCertificatePayload(
            this.options.certificateUrl,
            this.options.adapter.storage
          );
        }
        throw toSdkError(
          error,
          BROWSER_SDK_ERROR_CODES.TDX_CERTIFICATE_VERIFY_FAILED,
          "CPU-TEE \u8BC1\u4E66\u6821\u9A8C\u5931\u8D25"
        );
      }
      try {
        await verifyTdxQuote(
          this.options.verifyQuoteUrl,
          certificate.tdx_quote,
          this.options.adapter.http
        );
      } catch (error) {
        if (certificateFromCache) {
          clearCpuTeeCertificatePayload(
            this.options.certificateUrl,
            this.options.adapter.storage
          );
        }
        throw toSdkError(
          error,
          BROWSER_SDK_ERROR_CODES.TDX_QUOTE_VERIFY_FAILED,
          "TDX quote \u6821\u9A8C\u5931\u8D25"
        );
      }
      try {
        verifyTdxQuoteCertificatePublicKey(
          certificate.tdx_quote,
          certificate.certificate_pem
        );
      } catch (error) {
        if (certificateFromCache) {
          clearCpuTeeCertificatePayload(
            this.options.certificateUrl,
            this.options.adapter.storage
          );
        }
        throw toSdkError(
          error,
          BROWSER_SDK_ERROR_CODES.TDX_QUOTE_VERIFY_FAILED,
          "TDX quote \u8BC1\u4E66\u7ED1\u5B9A\u6821\u9A8C\u5931\u8D25"
        );
      }
      this.assertStateVersion(stateVersion);
      this.activeCertificate = certificate;
      this.phaseLabel = "CPU-TEE \u6821\u9A8C\u5B8C\u6210";
      const now = (/* @__PURE__ */ new Date()).toISOString();
      let activeRecord;
      let created = false;
      if (this.activeDeviceKey?.encryptionKeyId && this.activeDeviceKey.dekHex.trim()) {
        activeRecord = {
          ...this.activeDeviceKey,
          updatedAt: now
        };
      } else {
        created = true;
        activeRecord = {
          encryptionKeyId: await createEncryptionKeyIdAsync(this.getRuntime()),
          dekHex: await generateDekHexAsync(this.getRuntime()),
          certFingerprint: certificate.fingerprint,
          createdAt: now,
          updatedAt: now
        };
      }
      this.assertStateVersion(stateVersion);
      this.activeDeviceKey = cloneDeviceKeyRecord(activeRecord);
      this.envReady = true;
      this.phaseLabel = "\u8BBE\u5907\u7EA7\u672C\u5730\u5BC6\u94A5\u5DF2\u5C31\u7EEA";
      return {
        ok: true,
        appName: this.options.appName,
        encryptionKeyId: activeRecord.encryptionKeyId,
        certFingerprint: activeRecord.certFingerprint,
        created
      };
    })();
    try {
      return await this.envInitPromise;
    } catch (error) {
      if (this.destroyVersion === stateVersion) {
        this.envReady = false;
        this.envInitPromise = null;
        this.phaseLabel = "\u521D\u59CB\u5316\u5931\u8D25";
      }
      throw error;
    }
  }
  // 使用当前设备 DEK 对纯文本做本地 SM4-GCM 加密。
  async encryptText(text, options) {
    await this.envInit();
    if (!text.trim()) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.EMPTY_PLAINTEXT,
        "\u5F85\u52A0\u5BC6\u6587\u672C\u4E0D\u80FD\u4E3A\u7A7A"
      );
    }
    try {
      const requestId = await createRequestIdAsync(this.getRuntime());
      await emitStatusSequence(options?.onStatusChange, requestId);
      if (this.options.fakeCipherMode) {
        return encodeFakeTextCipher({
          encryptionKeyId: this.getActiveEncryptionKeyId(),
          text,
          requestId
        });
      }
      return encryptTextToBlobBase64(text, this.getActiveDekHex(), this.getRuntime());
    } catch (error) {
      throw toSdkError(
        error,
        BROWSER_SDK_ERROR_CODES.ENCRYPT_TEXT_FAILED,
        "\u6587\u672C\u52A0\u5BC6\u5931\u8D25"
      );
    }
  }
  // 使用当前设备 DEK 解密文本密文；若本地 DEK 不匹配则直接失败。
  async decryptText(cipher) {
    await this.envInit();
    try {
      if (this.options.fakeCipherMode) {
        return decodeFakeTextCipher(cipher);
      }
      return await decryptTextFromBlobEncoded(
        cipher,
        this.getActiveDekHex(),
        this.getRuntime()
      );
    } catch (error) {
      if (isInvalidCiphertextError(error)) {
        throw createBrowserSdkError(
          BROWSER_SDK_ERROR_CODES.INVALID_CIPHERTEXT,
          "\u5BC6\u6587\u683C\u5F0F\u4E0D\u5408\u6CD5\uFF0C\u65E0\u6CD5\u89E3\u5BC6",
          error
        );
      }
      if (isDecryptKeyMismatchError(error)) {
        throw createBrowserSdkError(
          BROWSER_SDK_ERROR_CODES.DECRYPT_DEVICE_KEY_MISMATCH,
          "\u5F53\u524D\u8BBE\u5907\u672C\u5730\u5BC6\u94A5\u4E0D\u5339\u914D\uFF0C\u65E0\u6CD5\u89E3\u5BC6",
          error
        );
      }
      throw toSdkError(
        error,
        BROWSER_SDK_ERROR_CODES.DECRYPT_DEVICE_KEY_MISMATCH,
        "\u5F53\u524D\u8BBE\u5907\u672C\u5730\u5BC6\u94A5\u4E0D\u5339\u914D\uFF0C\u65E0\u6CD5\u89E3\u5BC6"
      );
    }
  }
  // 使用当前设备 DEK 直接加密原始字节，避免先把文件体转成 base64。
  async encryptBytes(input, options) {
    await this.envInit();
    try {
      const fileBytes = await normalizeBytesInput(input);
      const requestId = await createRequestIdAsync(this.getRuntime());
      await emitStatusSequence(options?.onStatusChange, requestId);
      if (this.options.fakeCipherMode) {
        return encodeFakeBytesCipher({
          encryptionKeyId: this.getActiveEncryptionKeyId(),
          bytes: fileBytes,
          requestId
        });
      }
      return encryptBytesToBlobBase64(
        fileBytes,
        this.getActiveDekHex(),
        this.getRuntime()
      );
    } catch (error) {
      throw toSdkError(
        error,
        BROWSER_SDK_ERROR_CODES.ENCRYPT_FILE_FAILED,
        "\u5B57\u8282\u52A0\u5BC6\u5931\u8D25"
      );
    }
  }
  // 使用当前设备 DEK 解密 bytes 密文，返回原始字节。
  async decryptBytes(cipher) {
    await this.envInit();
    try {
      if (this.options.fakeCipherMode) {
        return decodeFakeBytesCipher(cipher);
      }
      return await decryptBytesFromBlobEncoded(
        cipher,
        this.getActiveDekHex(),
        this.getRuntime()
      );
    } catch (error) {
      if (isInvalidCiphertextError(error)) {
        throw createBrowserSdkError(
          BROWSER_SDK_ERROR_CODES.INVALID_CIPHERTEXT,
          "\u5B57\u8282\u5BC6\u6587\u683C\u5F0F\u4E0D\u5408\u6CD5\uFF0C\u65E0\u6CD5\u89E3\u5BC6",
          error
        );
      }
      if (isDecryptKeyMismatchError(error)) {
        throw createBrowserSdkError(
          BROWSER_SDK_ERROR_CODES.DECRYPT_DEVICE_KEY_MISMATCH,
          "\u5F53\u524D\u8BBE\u5907\u672C\u5730\u5BC6\u94A5\u4E0D\u5339\u914D\uFF0C\u65E0\u6CD5\u89E3\u5BC6\u5B57\u8282\u5BC6\u6587",
          error
        );
      }
      throw toSdkError(
        error,
        BROWSER_SDK_ERROR_CODES.DECRYPT_DEVICE_KEY_MISMATCH,
        "\u5F53\u524D\u8BBE\u5907\u672C\u5730\u5BC6\u94A5\u4E0D\u5339\u914D\uFF0C\u65E0\u6CD5\u89E3\u5BC6\u5B57\u8282\u5BC6\u6587"
      );
    }
  }
  // 对文件内容和元数据做整体加密，返回适合传输/存储的密文结构。
  async encryptFile(input, options) {
    await this.envInit();
    try {
      const fileBytes = await normalizeFileToBytes(input.file);
      const fileBase64 = bytesToBase64(fileBytes, this.getRuntime());
      const requestId = await createRequestIdAsync(this.getRuntime());
      await emitStatusSequence(options?.onStatusChange, requestId);
      const plainPayload = JSON.stringify({
        file_name: input.fileName,
        file_type: input.fileType,
        file_size: fileBytes.byteLength,
        file_base64: fileBase64
      });
      if (this.options.fakeCipherMode) {
        return {
          file_name: input.fileName,
          file_type: input.fileType,
          file_size: fileBytes.byteLength,
          encryption_data: encodeFakeTextCipher({
            encryptionKeyId: this.getActiveEncryptionKeyId(),
            text: plainPayload,
            requestId
          })
        };
      }
      const encryptionData = await encryptTextToBlobBase64(
        plainPayload,
        this.getActiveDekHex(),
        this.getRuntime()
      );
      return {
        file_name: input.fileName,
        file_type: input.fileType,
        file_size: fileBytes.byteLength,
        encryption_data: encryptionData
      };
    } catch (error) {
      throw toSdkError(
        error,
        BROWSER_SDK_ERROR_CODES.ENCRYPT_FILE_FAILED,
        "\u6587\u4EF6\u52A0\u5BC6\u5931\u8D25"
      );
    }
  }
  // 解密文件密文，并还原出文件元数据与 base64 文件内容。
  async decryptFile(cipher) {
    await this.envInit();
    try {
      const payload = JSON.parse(
        this.options.fakeCipherMode ? decodeFakeTextCipher(cipher) : await decryptTextFromBlobEncoded(
          cipher,
          this.getActiveDekHex(),
          this.getRuntime()
        )
      );
      if (typeof payload.file_name !== "string" || typeof payload.file_type !== "string" || typeof payload.file_size !== "number" || typeof payload.file_base64 !== "string") {
        throw createBrowserSdkError(
          BROWSER_SDK_ERROR_CODES.INVALID_FILE_PAYLOAD,
          "\u89E3\u5BC6\u540E\u7684\u6587\u4EF6\u5185\u5BB9\u683C\u5F0F\u4E0D\u6B63\u786E"
        );
      }
      return {
        file_name: payload.file_name,
        file_type: payload.file_type,
        file_size: payload.file_size,
        encryption_data: cipher,
        file_base64: payload.file_base64
      };
    } catch (error) {
      if (isInvalidCiphertextError(error)) {
        throw createBrowserSdkError(
          BROWSER_SDK_ERROR_CODES.INVALID_CIPHERTEXT,
          "\u6587\u4EF6\u5BC6\u6587\u683C\u5F0F\u4E0D\u5408\u6CD5\uFF0C\u65E0\u6CD5\u89E3\u5BC6",
          error
        );
      }
      if (isDecryptKeyMismatchError(error)) {
        throw createBrowserSdkError(
          BROWSER_SDK_ERROR_CODES.DECRYPT_DEVICE_KEY_MISMATCH,
          "\u5F53\u524D\u8BBE\u5907\u672C\u5730\u5BC6\u94A5\u4E0D\u5339\u914D\uFF0C\u65E0\u6CD5\u89E3\u5BC6\u6587\u4EF6",
          error
        );
      }
      if (error instanceof SyntaxError) {
        throw createBrowserSdkError(
          BROWSER_SDK_ERROR_CODES.INVALID_FILE_PAYLOAD,
          "\u89E3\u5BC6\u540E\u7684\u6587\u4EF6\u5185\u5BB9\u683C\u5F0F\u4E0D\u6B63\u786E",
          error
        );
      }
      throw toSdkError(
        error,
        BROWSER_SDK_ERROR_CODES.DECRYPT_DEVICE_KEY_MISMATCH,
        "\u5F53\u524D\u8BBE\u5907\u672C\u5730\u5BC6\u94A5\u4E0D\u5339\u914D\uFF0C\u65E0\u6CD5\u89E3\u5BC6\u6587\u4EF6"
      );
    }
  }
  // 返回 SDK 当前运行状态，供上层做展示、诊断或能力探测。
  getStatus() {
    const activeRecord = this.activeDeviceKey;
    return {
      initialized: this.initialized,
      envReady: this.envReady,
      phaseLabel: activeRecord?.encryptionKeyId && this.envReady ? "\u8BBE\u5907\u7EA7\u672C\u5730\u5BC6\u94A5\u5DF2\u5C31\u7EEA" : this.phaseLabel,
      capabilities: [...SDK_CAPABILITIES],
      encryptionKeyId: activeRecord?.encryptionKeyId ?? null,
      certFingerprint: this.activeCertificate?.fingerprint ?? activeRecord?.certFingerprint ?? null
    };
  }
  // 返回当前运行态中的设备密钥快照，避免调用方直接篡改内部对象。
  getActiveDeviceKeyRecord() {
    return this.activeDeviceKey ? cloneDeviceKeyRecord(this.activeDeviceKey) : null;
  }
  // 显式装载业务层恢复或导入的设备密钥；不会触发本地持久化副作用。
  setActiveDeviceKeyRecord(record) {
    this.activeDeviceKey = cloneDeviceKeyRecord(record);
    if (this.envReady) {
      this.phaseLabel = "\u8BBE\u5907\u7EA7\u672C\u5730\u5BC6\u94A5\u5DF2\u5C31\u7EEA";
    } else if (this.initialized) {
      this.phaseLabel = "\u5DF2\u521D\u59CB\u5316";
    }
    return cloneDeviceKeyRecord(this.activeDeviceKey);
  }
  // 强制生成新的运行态设备密钥，供云端 DEK reset 流程使用。
  async rotateActiveDeviceKeyRecord() {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const certFingerprint = this.activeCertificate?.fingerprint || (this.options.fakeCipherMode ? "fake-cipher" : "");
    if (!certFingerprint) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        "\u5F53\u524D\u53EF\u4FE1\u73AF\u5883\u5C1A\u672A\u5C31\u7EEA\uFF0C\u65E0\u6CD5\u91CD\u7F6E\u8BBE\u5907\u5BC6\u94A5"
      );
    }
    this.activeDeviceKey = {
      encryptionKeyId: await createEncryptionKeyIdAsync(this.getRuntime()),
      dekHex: await generateDekHexAsync(this.getRuntime()),
      certFingerprint,
      createdAt: now,
      updatedAt: now
    };
    if (this.envReady) {
      this.phaseLabel = "\u8BBE\u5907\u7EA7\u672C\u5730\u5BC6\u94A5\u5DF2\u5C31\u7EEA";
    }
    return cloneDeviceKeyRecord(this.activeDeviceKey);
  }
  // 清空当前运行态私钥，供业务层在退出、重置或等待重新导入时调用。
  clearActiveDeviceKeyRecord() {
    this.activeDeviceKey = null;
    if (this.envReady && this.activeCertificate) {
      this.phaseLabel = "CPU-TEE \u6821\u9A8C\u5B8C\u6210";
      return;
    }
    this.phaseLabel = this.initialized ? "\u5DF2\u521D\u59CB\u5316" : "\u672A\u521D\u59CB\u5316";
  }
  destroy() {
    this.destroyVersion += 1;
    this.initialized = false;
    this.envReady = false;
    this.phaseLabel = "\u672A\u521D\u59CB\u5316";
    this.activeDeviceKey = null;
    this.activeCertificate = null;
    this.initPromise = null;
    this.envInitPromise = null;
    this.options = {
      ...this.options,
      userId: void 0
    };
  }
  assertStateVersion(stateVersion) {
    if (this.destroyVersion !== stateVersion) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        "SDK \u72B6\u6001\u5DF2\u91CD\u7F6E\uFF0C\u8BF7\u91CD\u65B0\u521D\u59CB\u5316"
      );
    }
  }
  // 获取当前活跃 DEK；不再隐式从持久化存储恢复。
  getActiveDekHex() {
    const record = this.activeDeviceKey;
    if (!record?.dekHex || !DEK_HEX_PATTERN.test(record.dekHex.trim())) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        "\u5F53\u524D\u8BBE\u5907\u672C\u5730\u5BC6\u94A5\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u521D\u59CB\u5316"
      );
    }
    this.activeDeviceKey = cloneDeviceKeyRecord(record);
    return record.dekHex;
  }
  getActiveEncryptionKeyId() {
    const record = this.activeDeviceKey;
    if (!record?.encryptionKeyId) {
      throw createBrowserSdkError(
        BROWSER_SDK_ERROR_CODES.DEVICE_KEY_UNAVAILABLE,
        "\u5F53\u524D\u8BBE\u5907\u672C\u5730\u5BC6\u94A5\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u521D\u59CB\u5316"
      );
    }
    this.activeDeviceKey = cloneDeviceKeyRecord(record);
    return record.encryptionKeyId;
  }
};

export {
  BrowserTSSDK
};
//# sourceMappingURL=chunk-3CHM3SI6.js.map
