#!/usr/bin/env bash
set -euo pipefail

APP_NAME="SClaw.app"
VERSION="0.1.4"
EXPECTED_NODE_VERSION="v24.14.0"
EXPECTED_SDK_VERSION="1.0.15"
LOCAL_DMG_NAME="SClaw-local-unsigned.dmg"
LEGACY_LOCAL_DMG_NAME="SClaw.dmg"
RELEASE_DMG_NAME="SClaw-$VERSION-arm64.dmg"
VOLUME_NAME="SClaw"

MODE="local"
if [[ $# -gt 1 ]] || [[ $# -eq 1 && "${1:-}" != "--release" ]]; then
  echo "Usage: bash scripts/package-macos-dmg.sh [--release]" >&2
  exit 2
fi
if [[ ${1:-} == "--release" ]]; then
  MODE="release"
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/target"
TEMPLATE_APP="$ROOT_DIR/assets/$APP_NAME"
ENTITLEMENTS_PATH="$ROOT_DIR/assets/SClaw.entitlements"
BUILT_BINARY="$TARGET_DIR/release/ironclaw"
APP_PATH="$TARGET_DIR/$APP_NAME"
NODE_BINARY="${SCLAW_NODE_BINARY:-}"
SIDECAR_SOURCE_DIR="$ROOT_DIR/sidecar/src"
SDK_SOURCE_DIR="$ROOT_DIR/sidecar/vendor/client-tssdk"
if [[ "$MODE" == "release" ]]; then
  OUTPUT_PATH="$TARGET_DIR/$RELEASE_DMG_NAME"
  CHECKSUM_PATH="$OUTPUT_PATH.sha256"
else
  OUTPUT_PATH="$TARGET_DIR/$LOCAL_DMG_NAME"
  CHECKSUM_PATH=""
fi
STAGING_DIR=""
RELEASE_OUTPUT_STARTED="false"
RELEASE_COMPLETE="false"

cleanup() {
  if [[ "$RELEASE_OUTPUT_STARTED" == "true" && "$RELEASE_COMPLETE" != "true" ]]; then
    rm -f "$OUTPUT_PATH" "$CHECKSUM_PATH"
  fi
  if [[ -n "$STAGING_DIR" ]]; then
    rm -rf "$STAGING_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$TARGET_DIR"
rm -f "$TARGET_DIR/$LEGACY_LOCAL_DMG_NAME"
if [[ "$MODE" == "release" ]]; then
  RELEASE_OUTPUT_STARTED="true"
  rm -f "$TARGET_DIR/$LOCAL_DMG_NAME" "$OUTPUT_PATH" "$CHECKSUM_PATH"
else
  rm -f "$OUTPUT_PATH"
fi

fail() {
  echo "$1" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

version_lte() {
  awk -v left="$1" -v right="$2" 'BEGIN {
    left_count = split(left, left_parts, ".")
    right_count = split(right, right_parts, ".")
    count = left_count > right_count ? left_count : right_count
    for (i = 1; i <= count; i++) {
      left_part = left_parts[i] + 0
      right_part = right_parts[i] + 0
      if (left_part < right_part) exit 0
      if (left_part > right_part) exit 1
    }
    exit 0
  }'
}

[[ -d "$TEMPLATE_APP" ]] || fail "App template not found: $TEMPLATE_APP"
[[ -n "$NODE_BINARY" ]] || fail "SCLAW_NODE_BINARY must point to the approved arm64 Node $EXPECTED_NODE_VERSION executable."
[[ -f "$NODE_BINARY" ]] || fail "SCLAW_NODE_BINARY was not found: $NODE_BINARY"
[[ -x "$NODE_BINARY" ]] || fail "SCLAW_NODE_BINARY is not executable: $NODE_BINARY"

BUNDLED_JINGHUA_API_KEY="${SCLAW_BUNDLED_JINGHUA_API_KEY:-}"
[[ -n "$BUNDLED_JINGHUA_API_KEY" ]] || fail "A dedicated bundled Jinghua credential is required. Set SCLAW_BUNDLED_JINGHUA_API_KEY in the environment."
[[ "$BUNDLED_JINGHUA_API_KEY" != *[[:space:]]* ]] || fail "SCLAW_BUNDLED_JINGHUA_API_KEY must not contain whitespace."

for command_name in cargo file hdiutil lipo otool plutil realpath shasum; do
  require_command "$command_name"
done

NODE_BINARY="$(realpath "$NODE_BINARY")"
if [[ "$NODE_BINARY" == "$APP_PATH"/* ]]; then
  fail "SCLAW_NODE_BINARY must be outside $APP_PATH because packaging replaces that App bundle."
fi

NODE_KIND="$(file -b "$NODE_BINARY")"
[[ "$NODE_KIND" == *"Mach-O 64-bit executable arm64"* ]] || fail "Bundled Node is not an arm64 Mach-O executable: $NODE_KIND"
NODE_ARCHS="$(lipo -archs "$NODE_BINARY")"
[[ "$NODE_ARCHS" == "arm64" ]] || fail "Bundled Node must contain only arm64, found: $NODE_ARCHS"
NODE_VERSION="$("$NODE_BINARY" --version)"
[[ "$NODE_VERSION" == "$EXPECTED_NODE_VERSION" ]] || fail "Bundled Node must be $EXPECTED_NODE_VERSION, found: $NODE_VERSION"
NODE_MIN_MACOS="$(otool -l "$NODE_BINARY" | awk '$1 == "minos" { print $2; exit }')"
[[ -n "$NODE_MIN_MACOS" ]] || fail "Could not read the bundled Node LC_BUILD_VERSION minos."
APP_MIN_MACOS="$(plutil -extract LSMinimumSystemVersion raw -o - "$TEMPLATE_APP/Contents/Info.plist")"
version_lte "$NODE_MIN_MACOS" "$APP_MIN_MACOS" || fail "Bundled Node requires macOS $NODE_MIN_MACOS, but the App declares $APP_MIN_MACOS."

for sidecar_file in server.mjs protocol.mjs; do
  [[ -f "$SIDECAR_SOURCE_DIR/$sidecar_file" ]] || fail "Sidecar runtime file not found: $SIDECAR_SOURCE_DIR/$sidecar_file"
done
for sdk_file in VERSION SHA256SUMS index.js; do
  [[ -f "$SDK_SOURCE_DIR/$sdk_file" ]] || fail "Vendored JSSDK file not found: $SDK_SOURCE_DIR/$sdk_file"
done
SDK_VERSION="$(tr -d '\r\n' <"$SDK_SOURCE_DIR/VERSION")"
[[ "$SDK_VERSION" == "$EXPECTED_SDK_VERSION" ]] || fail "Vendored JSSDK must be $EXPECTED_SDK_VERSION, found: $SDK_VERSION"
(
  cd "$SDK_SOURCE_DIR"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || fail "Vendored JSSDK SHA256 verification failed."

if [[ "$MODE" == "release" ]]; then
  for variable_name in CSC_NAME APPLE_TEAM_ID APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
    if [[ -z "${!variable_name:-}" ]]; then
      fail "Required environment variable is not set: $variable_name"
    fi
  done

  for command_name in codesign security spctl xcrun; do
    require_command "$command_name"
  done
  [[ -f "$ENTITLEMENTS_PATH" ]] || fail "Entitlements file not found: $ENTITLEMENTS_PATH"
  [[ -r "$APPLE_API_KEY" ]] || fail "APPLE_API_KEY does not point to a readable file."
  plutil -lint "$ENTITLEMENTS_PATH" "$TEMPLATE_APP/Contents/Info.plist" >/dev/null
  xcrun --find notarytool >/dev/null 2>&1 || fail "notarytool is not available through xcrun."
  xcrun --find stapler >/dev/null 2>&1 || fail "stapler is not available through xcrun."

  IDENTITY_LINE="$(security find-identity -v -p codesigning | grep -F "$CSC_NAME" | head -n 1 || true)"
  [[ -n "$IDENTITY_LINE" ]] || fail "Signing identity from CSC_NAME was not found in the keychain."
  [[ "$IDENTITY_LINE" == *"Developer ID Application:"* ]] || fail "CSC_NAME must select a Developer ID Application identity."
fi

echo "Building release binary with the bundled Jinghua distribution credential."
SCLAW_BUNDLED_JINGHUA_API_KEY="$BUNDLED_JINGHUA_API_KEY" cargo build --release --manifest-path "$ROOT_DIR/Cargo.toml"
unset BUNDLED_JINGHUA_API_KEY
[[ -f "$BUILT_BINARY" ]] || fail "Release build did not create: $BUILT_BINARY"

if [[ "$MODE" == "release" ]]; then
  BINARY_KIND="$(file -b "$BUILT_BINARY")"
  [[ "$BINARY_KIND" == *"Mach-O 64-bit executable arm64"* ]] || fail "Release binary is not an arm64 Mach-O executable: $BINARY_KIND"
  BINARY_ARCHS="$(lipo -archs "$BUILT_BINARY")"
  [[ "$BINARY_ARCHS" == "arm64" ]] || fail "Release binary must contain only arm64, found: $BINARY_ARCHS"
fi

rm -rf "$APP_PATH"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sclaw-dmg.XXXXXX")"

cp -R "$TEMPLATE_APP" "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS"
cp "$BUILT_BINARY" "$APP_PATH/Contents/MacOS/ironclaw"
chmod +x "$APP_PATH/Contents/MacOS/ironclaw"

RESOURCES_DIR="$APP_PATH/Contents/Resources"
BUNDLED_NODE="$RESOURCES_DIR/node/bin/node"
CRYPTO_BRIDGE_DIR="$RESOURCES_DIR/crypto-bridge"
SDK_BUNDLE_DIR="$CRYPTO_BRIDGE_DIR/vendor/client-tssdk"
mkdir -p "$(dirname "$BUNDLED_NODE")" "$(dirname "$SDK_BUNDLE_DIR")"
cp "$NODE_BINARY" "$BUNDLED_NODE"
chmod +x "$BUNDLED_NODE"
cp "$SIDECAR_SOURCE_DIR/server.mjs" "$SIDECAR_SOURCE_DIR/protocol.mjs" "$CRYPTO_BRIDGE_DIR/"
cp -R "$SDK_SOURCE_DIR" "$SDK_BUNDLE_DIR"

(
  cd "$SDK_BUNDLE_DIR"
  shasum -a 256 -c SHA256SUMS >/dev/null
) || fail "Bundled JSSDK SHA256 verification failed after copying."

BUNDLED_NODE_VERSION="$(env -i HOME="${TMPDIR:-/tmp}" PATH="/usr/bin:/bin" "$BUNDLED_NODE" --version)"
[[ "$BUNDLED_NODE_VERSION" == "$EXPECTED_NODE_VERSION" ]] || fail "Bundled Node could not execute from App Resources."
(
  cd "$CRYPTO_BRIDGE_DIR"
  env -i HOME="${TMPDIR:-/tmp}" PATH="/usr/bin:/bin" "$BUNDLED_NODE" --input-type=module -e '
    await import("./server.mjs");
    await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array([1]));
    if (new Function("return 42")() !== 42) process.exit(1);
  '
) || fail "Bundled Node failed the JSSDK, WebCrypto, or V8 runtime probe."

if [[ "$MODE" == "release" ]]; then
  codesign \
    --force \
    --sign "$CSC_NAME" \
    --options runtime \
    --timestamp \
    --entitlements "$ENTITLEMENTS_PATH" \
    "$BUNDLED_NODE"
  codesign --verify --strict --verbose=2 "$BUNDLED_NODE"

  codesign \
    --force \
    --sign "$CSC_NAME" \
    --options runtime \
    --timestamp \
    --entitlements "$ENTITLEMENTS_PATH" \
    "$APP_PATH"

  codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  SIGNING_INFO="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)"
  TEAM_IDENTIFIER="$(printf '%s\n' "$SIGNING_INFO" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
  [[ "$TEAM_IDENTIFIER" == "$APPLE_TEAM_ID" ]] || fail "Signed app TeamIdentifier '$TEAM_IDENTIFIER' does not match APPLE_TEAM_ID."
  printf '%s\n' "$SIGNING_INFO" | grep -Eq 'flags=.*\(runtime\)' || fail "Signed app does not have Hardened Runtime enabled."
fi

cp -R "$APP_PATH" "$STAGING_DIR/$APP_NAME"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$OUTPUT_PATH"

if [[ "$MODE" == "release" ]]; then
  codesign --force --sign "$CSC_NAME" --timestamp "$OUTPUT_PATH"
  codesign --verify --strict --verbose=2 "$OUTPUT_PATH"

  NOTARY_RESULT="$STAGING_DIR/notary-result.json"
  if ! xcrun notarytool submit "$OUTPUT_PATH" \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait \
    --output-format json >"$NOTARY_RESULT"; then
    fail "Notarization submission failed."
  fi

  if ! NOTARY_STATUS="$(plutil -extract status raw -o - "$NOTARY_RESULT")"; then
    fail "Could not read the notarization result."
  fi
  NOTARY_ID="$(plutil -extract id raw -o - "$NOTARY_RESULT" 2>/dev/null || true)"
  if [[ "$NOTARY_STATUS" != "Accepted" ]]; then
    fail "Notarization was not accepted (status: $NOTARY_STATUS, submission: ${NOTARY_ID:-unknown})."
  fi

  xcrun stapler staple "$OUTPUT_PATH"
  xcrun stapler validate "$OUTPUT_PATH"

  if ! SPCTL_OUTPUT="$(spctl --assess --type open --context context:primary-signature --verbose=4 "$OUTPUT_PATH" 2>&1)"; then
    printf '%s\n' "$SPCTL_OUTPUT" >&2
    fail "Gatekeeper rejected the notarized DMG."
  fi
  printf '%s\n' "$SPCTL_OUTPUT"
  printf '%s\n' "$SPCTL_OUTPUT" | grep -Fq 'source=Notarized Developer ID' || fail "Gatekeeper did not report source=Notarized Developer ID."
  if printf '%s\n' "$SPCTL_OUTPUT" | grep -Fq 'override=security disabled'; then
    echo "Warning: Gatekeeper is disabled locally; acceptance was verified from source=Notarized Developer ID, not from the override." >&2
  fi

  hdiutil verify "$OUTPUT_PATH"
  (
    cd "$TARGET_DIR"
    shasum -a 256 "$RELEASE_DMG_NAME" >"$RELEASE_DMG_NAME.sha256"
  )
  [[ -s "$CHECKSUM_PATH" ]] || fail "Could not create the release SHA-256 file."
  RELEASE_COMPLETE="true"
  echo "Notarization accepted (submission: ${NOTARY_ID:-unknown})."
fi

echo "Created app bundle: $APP_PATH"
echo "Created DMG: $OUTPUT_PATH"
if [[ "$MODE" == "release" ]]; then
  echo "Install or distribute this release DMG: $OUTPUT_PATH"
  echo "Created SHA-256: $CHECKSUM_PATH"
  echo "SHA-256: $(awk '{ print $1 }' "$CHECKSUM_PATH")"
else
  echo "Local unsigned DMG for development only; do not distribute: $OUTPUT_PATH"
fi
echo "Bundled Node: $NODE_VERSION (arm64, macOS >= $NODE_MIN_MACOS)"
echo "Bundled JSSDK: $SDK_VERSION"
