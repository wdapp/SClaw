#!/bin/bash
# 启动 SClaw (ironclaw)，完全使用自己的文件，不依赖 OpenClaw

SCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
export STAR_OFFICE_PATH="$SCLAW_DIR/star-office-ui"
export STAR_OFFICE_PORT="19001"

cd "$SCLAW_DIR"
./target/release/ironclaw
