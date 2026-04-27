本地项目能跑起来，并能正常聊天

只改用户可见文案，把 IronClaw/ironclaw 改成 SClaw/sclaw

聊天中的动态品牌文案也要改，比如自我介绍、系统提示里出现 ironclaw

接入你们的模型接口 https://openvpn.longlast.xyz:18443/v1

先允许自签名证书，保证演示版能直接访问接口

 mac 打包

安装后用户尽量双击就能用

ps aux | grep ironclaw

cd /Users/wanda/Mac/Workspace/SClaw/sclaw

cargo build --release

测试

./target/release/ironclaw

bash scripts/package-macos-dmg.sh

cargo run -- onboard --quick

后续再做 Feishu 对接、飞书机器人里的可见文案后续也要改成 SClaw

修改文案 Calling SClaw...，修改浏览器icon

1. 验证本机工具能力
2. 启动体验优化
3. Windows msi
4. mac TODO
5. Feishu TODO
