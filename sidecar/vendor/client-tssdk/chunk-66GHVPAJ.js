// src/errors.ts
var BROWSER_SDK_ERROR_CODES = {
  CERTIFICATE_FETCH_FAILED: "CERTIFICATE_FETCH_FAILED",
  CERTIFICATE_PAYLOAD_INVALID: "CERTIFICATE_PAYLOAD_INVALID",
  TDX_CERTIFICATE_VERIFY_FAILED: "TDX_CERTIFICATE_VERIFY_FAILED",
  TDX_QUOTE_VERIFY_FAILED: "TDX_QUOTE_VERIFY_FAILED",
  DEVICE_KEY_UNAVAILABLE: "DEVICE_KEY_UNAVAILABLE",
  EMPTY_PLAINTEXT: "EMPTY_PLAINTEXT",
  ENCRYPT_TEXT_FAILED: "ENCRYPT_TEXT_FAILED",
  ENCRYPT_FILE_FAILED: "ENCRYPT_FILE_FAILED",
  INVALID_CIPHERTEXT: "INVALID_CIPHERTEXT",
  DECRYPT_DEVICE_KEY_MISMATCH: "DECRYPT_DEVICE_KEY_MISMATCH",
  INVALID_FILE_PAYLOAD: "INVALID_FILE_PAYLOAD",
  PLAINTEXT_MODE_UNSUPPORTED: "PLAINTEXT_MODE_UNSUPPORTED"
};
var browserSdkErrorCodeSet = new Set(
  Object.values(BROWSER_SDK_ERROR_CODES)
);
function createBrowserSdkError(code, message, cause) {
  const sdkError = new Error(
    message,
    cause === void 0 ? void 0 : { cause }
  );
  sdkError.name = "BrowserSdkError";
  sdkError.code = code;
  return sdkError;
}
function isBrowserSdkError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return browserSdkErrorCodeSet.has(
    error.code || ""
  );
}
function getBrowserSdkErrorCode(error) {
  if (!isBrowserSdkError(error)) {
    return null;
  }
  return error.code;
}
function hasBrowserSdkErrorCode(error, code) {
  return getBrowserSdkErrorCode(error) === code;
}

export {
  BROWSER_SDK_ERROR_CODES,
  createBrowserSdkError,
  isBrowserSdkError,
  getBrowserSdkErrorCode,
  hasBrowserSdkErrorCode
};
//# sourceMappingURL=chunk-66GHVPAJ.js.map
