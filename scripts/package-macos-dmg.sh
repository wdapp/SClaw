#!/usr/bin/env bash
set -euo pipefail

APP_NAME="SClaw.app"
VERSION="0.1.3"
LOCAL_DMG_NAME="SClaw.dmg"
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
if [[ "$MODE" == "release" ]]; then
  OUTPUT_PATH="$TARGET_DIR/$RELEASE_DMG_NAME"
else
  OUTPUT_PATH="$TARGET_DIR/$LOCAL_DMG_NAME"
fi
STAGING_DIR=""
RELEASE_OUTPUT_STARTED="false"
RELEASE_COMPLETE="false"

cleanup() {
  if [[ "$RELEASE_OUTPUT_STARTED" == "true" && "$RELEASE_COMPLETE" != "true" ]]; then
    rm -f "$OUTPUT_PATH"
  fi
  if [[ -n "$STAGING_DIR" ]]; then
    rm -rf "$STAGING_DIR"
  fi
}
trap cleanup EXIT

fail() {
  echo "$1" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

[[ -d "$TEMPLATE_APP" ]] || fail "App template not found: $TEMPLATE_APP"
[[ -f "$BUILT_BINARY" ]] || fail "Built binary not found: $BUILT_BINARY. Run 'cargo build --release' first."
require_command hdiutil

if [[ "$MODE" == "release" ]]; then
  for variable_name in CSC_NAME APPLE_TEAM_ID APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
    if [[ -z "${!variable_name:-}" ]]; then
      fail "Required environment variable is not set: $variable_name"
    fi
  done

  for command_name in codesign file lipo plutil security spctl xcrun; do
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

  BINARY_KIND="$(file -b "$BUILT_BINARY")"
  [[ "$BINARY_KIND" == *"Mach-O 64-bit executable arm64"* ]] || fail "Release binary is not an arm64 Mach-O executable: $BINARY_KIND"
  BINARY_ARCHS="$(lipo -archs "$BUILT_BINARY")"
  [[ "$BINARY_ARCHS" == "arm64" ]] || fail "Release binary must contain only arm64, found: $BINARY_ARCHS"
fi

mkdir -p "$TARGET_DIR"
rm -rf "$APP_PATH"
if [[ "$MODE" == "release" ]]; then
  RELEASE_OUTPUT_STARTED="true"
fi
rm -f "$OUTPUT_PATH"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sclaw-dmg.XXXXXX")"

cp -R "$TEMPLATE_APP" "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS"
cp "$BUILT_BINARY" "$APP_PATH/Contents/MacOS/ironclaw"
chmod +x "$APP_PATH/Contents/MacOS/ironclaw"

if [[ "$MODE" == "release" ]]; then
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
  RELEASE_COMPLETE="true"
  echo "Notarization accepted (submission: ${NOTARY_ID:-unknown})."
fi

echo "Created app bundle: $APP_PATH"
echo "Created DMG: $OUTPUT_PATH"
