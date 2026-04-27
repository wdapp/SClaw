#!/bin/bash
# 一键启动 SClaw + Star Office UI + 状态监控

SCLAW_DIR="$HOME/Downloads/SClaw-main"
STAR_UI_DIR="$SCLAW_DIR/star-office-ui"
TOKEN=$(grep "GATEWAY_AUTH_TOKEN" ~/.ironclaw/.env 2>/dev/null | cut -d'"' -f2)

echo "启动 SClaw + Star Office UI..."

# 启动 ironclaw（后台运行）
cd "$SCLAW_DIR"
./target/release/ironclaw &
SCLAW_PID=$!

# 等待 ironclaw 完全启动
sleep 3

# 启动监控脚本
if [ -n "$TOKEN" ]; then
    echo "启动监控脚本 (token: ${TOKEN:0:8}...)"
    cd "$STAR_UI_DIR"
    python3 monitor_sclaw.py --token "$TOKEN" &
else
    echo "警告: 未找到固定 token，监控脚本需要手动启动"
    cd "$STAR_UI_DIR"
    python3 monitor_sclaw.py &
fi

echo "SClaw 已启动 (PID: $SCLAW_PID)"
echo "Gateway: http://127.0.0.1:3180/"
echo "Star Office UI: http://127.0.0.1:3180/office/"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 等待中断
wait
