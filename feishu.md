# SClaw 飞书对接文档

本文档面向当前仓库 `SClaw/sclaw`。

目标是把当前已经存在的 `feishu` channel 接到飞书机器人上，完成最小可行链路：

- 飞书事件通过长连接进入 SClaw
- SClaw 收到 `im.message.receive_v1`
- Agent 处理消息
- SClaw 调飞书接口回复消息

本文档基于当前仓库实现，不另起一套新方案。

## 1. 当前仓库里的 Feishu 现状

当前仓库已经有 Feishu / Lark channel：

- channel 源码：`channels-src/feishu`
- registry 清单：`registry/channels/feishu.json`
- capabilities：`channels-src/feishu/feishu.capabilities.json`

当前实现已经具备：

- 宿主侧 Feishu 长连接模式
- 无需公网 webhook URL
- 接收 `im.message.receive_v1`
- 通过 `app_id + app_secret` 换取 `tenant_access_token`
- 调飞书消息回复接口回消息
- DM 配对策略 `dm_policy`
- `owner_id` / `allow_from` 限制来源

当前实现的边界：

- 优先支持文本消息
- 状态事件不会转发到飞书
- 群聊只在识别到 `@bot` 时才触发；第一轮仍建议先测 DM
- `feishu_verification_token` 仍保留在扩展配置里，但长连接模式本身不依赖公网回调验证

## 2. 先决条件

在本机上，下面这些已经准备好才建议开始联调：

- SClaw 可正常启动
- 扩展安装 Feishu channel 成功
- 本机已安装 `cargo-component`
- Rust target 已具备：
  - `wasm32-wasip1`
  - `wasm32-wasip2`

如果还没安装 `cargo-component`：

```bash
cargo install cargo-component
```

如果缺 target：

```bash
rustup target add wasm32-wasip1
rustup target add wasm32-wasip2
```

如果要手工预编译 Feishu channel：

```bash
cargo component build --release --manifest-path /Users/wanda/Mac/Workspace/SClaw/sclaw/channels-src/feishu/Cargo.toml
```

## 3. 飞书侧需要准备什么

在飞书开放平台创建一个机器人应用。

至少需要拿到这些信息：

- `App ID`
- `App Secret`

在当前 SClaw 实现下，最小需要开启：

- 事件订阅
- 订阅方式切到“长连接”
- 事件：`im.message.receive_v1`

最小需要的机器人能力：

- 接收消息事件
- 发送消息
- 回复消息

建议第一轮只验证单聊 DM，不要先从群聊开始。

## 4. SClaw 侧需要配置什么

### 4.1 必需 secrets

当前仓库中的 Feishu channel 使用这些 secret 名称：

- `feishu_app_id`
- `feishu_app_secret`
- `feishu_verification_token`

含义：

- `feishu_app_id`
  - 飞书应用的 App ID
- `feishu_app_secret`
  - 飞书应用的 App Secret
- `feishu_verification_token`
  - 兼容旧 webhook 配置保留，可先空着

### 4.2 channel config

当前 channel 默认配置项来自 `channels-src/feishu/feishu.capabilities.json`：

```json
{
  "app_id": null,
  "app_secret": null,
  "api_base": "https://open.feishu.cn",
  "owner_id": null,
  "dm_policy": "pairing",
  "allow_from": []
}
```

各字段说明：

- `api_base`
  - 国内飞书默认用 `https://open.feishu.cn`
  - 如果是 Lark 国际版，再切到 `https://open.larksuite.com`
- `owner_id`
  - 只允许一个指定用户与机器人交互
  - 不确定时先留空
- `dm_policy`
  - 推荐先用默认值 `pairing`
  - 如果希望更直接放开 DM，可改成 `open`
- `allow_from`
  - 白名单用户列表
  - 第一轮联调建议只放自己的 `open_id`

## 5. 回调地址怎么配

长连接模式下，不需要配置公网回调地址。

你只需要在飞书开放平台里把事件订阅方式切到：

```text
使用长连接接收事件
```

本地 `http://127.0.0.1:3180` 仍然可以工作，不需要 tunnel。

## 6. 当前实现里的鉴权方式

当前仓库实现分成两段。

### 6.1 入站鉴权

长连接模式下，入站鉴权由飞书长连接端点完成。

SClaw 会用：

- `feishu_app_id`
- `feishu_app_secret`

先向飞书获取长连接 endpoint，再建立 WebSocket。

### 6.2 出站调用鉴权

SClaw channel 会：

1. 用 `feishu_app_id + feishu_app_secret`
2. 换取 `tenant_access_token`
3. 再用 Bearer Token 调飞书消息接口

所以如果“能收到消息但回不出去”，优先排查：

- `feishu_app_id`
- `feishu_app_secret`
- 飞书机器人发送消息权限

## 7. 最小对接步骤

建议严格按这个顺序来。

### 第一步：安装 Feishu channel

如果扩展页里已经能安装成功，就直接在 UI 安装。

如果要手工确认 build 产物是否存在：

```bash
find /Users/wanda/Mac/Workspace/SClaw/sclaw/channels-src/feishu/target -path '*release/*' -name '*.wasm'
```

### 第二步：写入 secrets

把以下值写进 SClaw 的 secret 存储：

- `feishu_app_id`
- `feishu_app_secret`
- `feishu_verification_token`

### 第三步：激活 channel

确保 `feishu` channel 已安装并激活。

### 第四步：配置飞书事件订阅

在飞书开放平台里配置：

- 订阅方式：`使用长连接接收事件`
- 订阅事件：`im.message.receive_v1`

### 第五步：不用做 URL 验证

因为当前已经切到长连接模式，所以不再需要 challenge 回调验证。

### 第六步：先测 DM

用你自己的飞书账号给机器人发一条纯文本消息，例如：

```text
你好
```

期望链路：

1. 飞书通过长连接把事件发到 SClaw
2. SClaw 收到 `im.message.receive_v1`
3. Agent 处理
4. SClaw 回复飞书消息

## 8. 推荐的最小配置策略

为了避免一开始接进来太多人，建议这样配：

- 只开 DM，不先测群聊
- `dm_policy = "pairing"` 保持默认
- `allow_from` 先只允许你自己的 `open_id`
- 如果是单人调试，也可以直接配置 `owner_id`

这样最稳。

## 9. 最小验收清单

最小通过标准如下：

- Feishu channel 安装成功
- Feishu channel 激活成功
- 飞书后台 URL 验证成功
- 机器人能收到你的 DM
- SClaw 能回一条文本消息

只要这 5 条都满足，就说明最小可行路径已经打通。

## 10. 常见问题排查

### 10.1 安装时报 `cargo-component not found`

执行：

```bash
cargo install cargo-component
```

### 10.2 安装时报 `Build artifact not found`

先手工构建：

```bash
cargo component build --release --manifest-path /Users/wanda/Mac/Workspace/SClaw/sclaw/channels-src/feishu/Cargo.toml
```

### 10.3 URL 验证失败

优先检查：

- 回调地址是不是 `.../webhook/feishu`
- 公网地址是否真的通到当前 SClaw 实例
- `feishu_verification_token` 是否与飞书后台一致

### 10.4 能收到消息但不回消息

优先检查：

- `feishu_app_id`
- `feishu_app_secret`
- 机器人发送消息权限
- app 是否已发布到可用状态

### 10.5 DM 没反应

优先检查：

- `dm_policy`
- `owner_id`
- `allow_from`
- 是否触发了 pairing 限制

## 11. 现在卡在哪个环节

接飞书时，可以用下面这套分类快速定位：

- 飞书配置
  - App、权限、事件订阅没配好
- 回调验证
  - URL challenge / Verification Token 不通过
- 消息收发
  - 能收不能发，或根本没收到事件
- 权限
  - 机器人没有接收或发送消息能力
- 签名校验
  - webhook 校验头或 secret 不匹配

建议每做完一步，就明确记录：

```text
现在卡在哪个环节：飞书配置、回调验证、消息收发、权限、还是签名校验
```

这样下一轮排查会非常快。

## 12. 推荐的明天联调顺序

建议按下面顺序推进：

1. 确认 Feishu channel 已安装
2. 确认 secret 已写入
3. 确认 channel 已激活
4. 完成飞书后台 URL 验证
5. 先测 DM 文本消息
6. 再决定是否接群聊

不要一开始就同时测：

- 群聊
- @提及
- 白名单
- 配对策略
- 多人访问

先把最小单聊链路打通，再逐步加复杂度。
