#!/usr/bin/env bash
set -euo pipefail

APP_NAME="SClaw.app"
DMG_NAME="SClaw.dmg"
VOLUME_NAME="SClaw"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/target"
TEMPLATE_APP="$ROOT_DIR/assets/$APP_NAME"
BUILT_BINARY="$TARGET_DIR/release/ironclaw"
APP_PATH="$TARGET_DIR/$APP_NAME"
OUTPUT_PATH="$TARGET_DIR/$DMG_NAME"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sclaw-dmg.XXXXXX")"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

if [[ ! -d "$TEMPLATE_APP" ]]; then
  echo "App template not found: $TEMPLATE_APP" >&2
  echo "Expected an empty app bundle template at assets/$APP_NAME." >&2
  exit 1
fi

if [[ ! -f "$BUILT_BINARY" ]]; then
  echo "Built binary not found: $BUILT_BINARY" >&2
  echo "Run 'cargo build --release' first." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
rm -rf "$APP_PATH"
rm -f "$OUTPUT_PATH"

cp -R "$TEMPLATE_APP" "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS"
cp "$BUILT_BINARY" "$APP_PATH/Contents/MacOS/ironclaw"
chmod +x "$APP_PATH/Contents/MacOS/ironclaw"

cp -R "$APP_PATH" "$STAGING_DIR/$APP_NAME"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$OUTPUT_PATH"

echo "Created app bundle: $APP_PATH"
echo "Created DMG: $OUTPUT_PATH"
