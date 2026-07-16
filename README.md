# SClaw

SClaw 是一个面向本地桌面使用的 AI 助手项目，基于 `ironclaw` 定制，支持浏览器网关访问和飞书机器人接入。

这份文档只保留最常用的内容：

1. 安装依赖
2. 运行项目
3. 使用内置荆华密态 SaaS
4. 打包 macOS 应用

## 1. 安装依赖

### 必需依赖

- macOS
- Xcode Command Line Tools
- [Rust](https://www.rust-lang.org/tools/install)
- `rustup`
- `cargo`
- `wasm-tools`

### 一次性安装命令

如果你的机器是第一次安装 Rust，建议按下面顺序执行：

```bash
# 安装 Rust / rustup
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 安装项目依赖
rustup toolchain install stable
rustup default stable
rustup target add wasm32-wasip2
cargo install wasm-tools
```

安装完成后，可以用下面命令检查是否成功：

```bash
rustc --version
cargo --version
rustup --version
wasm-tools --version
```

### 可选依赖

- Docker Desktop

说明：

- Docker 只在你需要沙盒工具执行时使用。
- 不安装 Docker，SClaw 也可以正常启动和聊天。

### 获取项目代码

```bash
git clone <仓库地址>
cd SClaw
```

## 2. 运行项目

### 第一步：编译

```bash
cargo build --release
```

### 第二步：启动

```bash
cargo run
```

启动后，SClaw 会自动打开本地浏览器页面。

## 3. 使用内置荆华密态 SaaS

从 `0.1.4` 开始，SClaw 默认使用 `荆华密态 SaaS`（Provider ID：`jinghua_saas`）和 `nvidia/Kimi-K2.6-NVFP4`。正式包会在编译阶段注入发行凭据；首次安装后直接打开 App 即可使用，不需要运行配置向导或输入 API Key。凭据不会提交到 Git，也不会作为 App Resources 明文文件分发。

启用后，SClaw 会自动启动仅监听 `127.0.0.1:3190` 的本地加密 sidecar。SClaw 仍按标准 OpenAI Compatible 协议发送请求；sidecar 使用内置 JSSDK 加密消息、构造 TEE transport，并在本机解密 SaaS 响应。退出 SClaw 时 sidecar 会一并关闭。

当前 V1 边界：

- 当前内置 sidecar 固定连接荆华 SaaS 测试环境，仅用于测试与演示；生产环境尚未启用这条工具调用链路，生产发布需另行完成推理服务与 SaaS 开关切换。
- 支持非流式纯文本聊天和标准 OpenAI function tools；`tools` 非空时默认 `tool_choice=auto`，也支持 `none` / `required` / 指定函数。
- 工具 schema 和函数名明文透传给 TEE 内的 vLLM；用户消息、assistant 工具参数、本地工具结果和最终正文均由 sidecar 加解密。工具仍由 SClaw 现有权限/审批与本地执行链路处理。
- 不支持流式工具调用；`stream=true` 会返回能力错误。工具调用不能与附件、图片、语音、RAG 或 Web Search 组合。
- UI、SClaw/sidecar 进程内存和本地聊天历史仍是明文；密态保护范围是 sidecar 到 SaaS/密态推理服务的传输与推理链路。
- Apple Silicon 安装包内置 Node.js v24.14.0 和 JSSDK 1.0.15，最低支持 macOS 13.5；目标 Mac 不需要安装 Node、npm、pnpm、Rust 或 Homebrew。

开发环境不设置任何 LLM 环境变量时也会选择同一默认链路；若二进制没有注入发行凭据，请用 `JINGHUA_API_KEY` 提供本地凭据。需要切换到其他 Provider 时，仍可通过现有配置向导、`LLM_BACKEND` 和对应的 API Key 环境变量覆盖默认值。

发行凭据最终存在于客户端二进制中，具备逆向能力的用户仍可能提取。该凭据必须使用可撤销、可轮换、限模型/限额度的 SClaw 专用 Key，不能复用管理员或其他生产权限凭据。

实现协议、安全边界和验收证据见[密态 SClaw 加解密方案](%E5%AF%86%E6%80%81SClaw%E5%8A%A0%E8%A7%A3%E5%AF%86%E6%96%B9%E6%A1%88.md)及[密态 sidecar V1 验收记录](docs/JINGHUA_CONFIDENTIAL_SIDECAR_ACCEPTANCE.md)。

## 4. 打包项目

macOS 正式包是仅支持 Apple Silicon 的签名、公证 DMG。安装包内置 Node、加密 sidecar 和 JSSDK；`SCLAW_NODE_BINARY` 只在打包机上使用，最终用户不需要安装 Node、npm、pnpm、Rust 或 Homebrew。

打包输出如下：

- `target/SClaw.app`：生成并签名后的 App
- `target/SClaw-local-unsigned.dmg`：本地未签名验证包，不可分发
- `target/SClaw-<版本号>-arm64.dmg`：签名、公证后的正式包

以下命令均在仓库根目录执行。

### 一次性准备 arm64 Node

打包脚本固定要求 Node.js v24.14.0 的纯 arm64 Mach-O 文件，不能直接使用包含 `x86_64 arm64` 的 universal Node。下面的命令会下载官方 arm64 压缩包、校验固定 SHA-256，并解压到用户缓存目录：

```zsh
NODE_VERSION=24.14.0
NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_ARCHIVE_SHA256=a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3
NODE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/sclaw/node-v${NODE_VERSION}-darwin-arm64"

mkdir -p "$NODE_DIR"
curl -fL --retry 3 \
  "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
  -o "$NODE_DIR/$NODE_ARCHIVE"
(
  cd "$NODE_DIR"
  printf '%s  %s\n' "$NODE_ARCHIVE_SHA256" "$NODE_ARCHIVE" | shasum -a 256 -c -
  tar -xzf "$NODE_ARCHIVE" --strip-components=1
)

"$NODE_DIR/bin/node" --version
file "$NODE_DIR/bin/node"
lipo -archs "$NODE_DIR/bin/node"
export SCLAW_NODE_BINARY="$NODE_DIR/bin/node"
```

最后三行应分别显示 `v24.14.0`、`Mach-O 64-bit executable arm64` 和 `arm64`。

### 准备发行凭据

正式包需要钥匙串中已有公司 `Developer ID Application` 证书，并准备 App Store Connect API Key。当前打包机在 `~/.zshrc` 中加载以下变量；换机器时也必须配置：

- `SCLAW_NODE_BINARY`：经过校验的 Node.js v24.14.0 arm64 可执行文件
- `CSC_NAME`：Developer ID Application 签名身份名称或哈希
- `APPLE_TEAM_ID`：Apple Developer Team ID
- `APPLE_API_KEY`：可读的 App Store Connect API Key `.p8` 路径
- `APPLE_API_KEY_ID`：API Key ID
- `APPLE_API_ISSUER`：API Issuer ID

还必须通过当前 shell 提供 `SCLAW_BUNDLED_JINGHUA_API_KEY`。它必须是可撤销、可轮换、限模型和限额度的 SClaw 专用发行 Key；不要复用管理员、压测或其他通用 Key。打包脚本不会从仓库 `.env` 回退读取发行 Key。

### 本地未签名打包

本地模式也会重新编译 release 二进制并内置发行凭据，但不签名或公证，只用于打包流程验证：

```zsh
source ~/.zshrc
bash scripts/package-macos-dmg.sh
```

输出为 `target/SClaw-local-unsigned.dmg`，不要交给最终用户安装。

### 正式签名、公证与验收：复制执行

```zsh
source ~/.zshrc
bash scripts/package-macos-dmg.sh --release
```

脚本会重新编译二进制，校验 Node v24.14.0 arm64、macOS `minos`、JSSDK 1.0.15 和 SHA-256 清单，再完成内置 Node 签名、App Hardened Runtime 签名、DMG 签名、Apple 公证、staple、Gatekeeper 检查、DMG 完整性验证，并自动生成同名 `.sha256` 文件。任何一步失败都会以非零状态退出，并删除本次未完成的正式 DMG 和校验文件。

`spctl` 输出必须包含 `source=Notarized Developer ID`。正式分发 `target/SClaw-<版本号>-arm64.dmg` 和同名 `.sha256` 文件；不要分发旧名称 `target/SClaw.dmg` 或本地未签名包。

### 发布到 GitHub Release：复制执行

先安装并登录 GitHub CLI：

```zsh
brew install gh
gh auth login
```

代码必须已经提交并推送到 `origin/main`，且版本标签必须指向当前提交。下面的函数会自动读取 `Cargo.toml` 版本号，检查工作区、远端主分支、标签和正式 DMG，再创建 GitHub Release；任何检查不通过都会停止，不会误发旧提交或旧安装包。

```zsh
publish_sclaw_release() {
  local version tag dmg checksum head_commit tag_commit

  version="$(awk -F'"' '/^version = "/ { print $2; exit }' Cargo.toml)"
  tag="v${version}"
  dmg="target/SClaw-${version}-arm64.dmg"
  checksum="${dmg}.sha256"

  [[ -z "$(git status --porcelain)" ]] || {
    echo "工作区还有未提交改动，请先提交并推送。" >&2
    return 1
  }
  [[ "$(git branch --show-current)" == "main" ]] || {
    echo "当前分支不是 main。" >&2
    return 1
  }
  [[ -f "$dmg" && -f "$checksum" ]] || {
    echo "缺少正式 DMG 或 SHA-256 文件，请先执行正式打包命令。" >&2
    return 1
  }

  gh auth status || return 1
  git fetch origin main --tags || return 1
  head_commit="$(git rev-parse HEAD)"
  [[ "$head_commit" == "$(git rev-parse origin/main)" ]] || {
    echo "当前提交尚未推送到 origin/main，或本地 main 不是远端最新提交。" >&2
    return 1
  }

  tag_commit="$(git rev-list -n 1 "$tag" 2>/dev/null || true)"
  if [[ -n "$tag_commit" && "$tag_commit" != "$head_commit" ]]; then
    echo "标签 $tag 已指向其他提交；不要继续发布，请改用新版本号或先人工处理错误标签。" >&2
    return 1
  fi
  if [[ -z "$tag_commit" ]]; then
    git tag -a "$tag" -m "SClaw ${tag}" || return 1
  fi

  git push origin "refs/tags/${tag}" || return 1
  gh release create "$tag" "$dmg" "$checksum" \
    --verify-tag \
    --title "SClaw ${tag}" \
    --generate-notes
}

publish_sclaw_release
```

如果函数提示标签已指向其他提交，优先升级版本号。只有在确认该标签确实是误建、尚未创建 GitHub Release、并且需要继续使用同一版本号时，才执行下面的清理命令，然后重新运行发布函数：

```zsh
remove_unreleased_sclaw_tag() {
  local version tag

  version="$(awk -F'"' '/^version = "/ { print $2; exit }' Cargo.toml)"
  tag="v${version}"

  gh auth status || return 1
  gh repo view --json nameWithOwner >/dev/null || return 1
  if gh release view "$tag" >/dev/null 2>&1; then
    echo "GitHub Release $tag 已存在，禁止删除标签；请升级版本号。" >&2
    return 1
  fi

  if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
    git push origin --delete "$tag" || return 1
  fi
  git tag -d "$tag" 2>/dev/null || true
}

remove_unreleased_sclaw_tag
```

如果 GitHub Release 已存在，不要重新创建；确认确实要替换同版本附件后再执行：

```zsh
VERSION="$(awk -F'"' '/^version = "/ { print $2; exit }' Cargo.toml)"
TAG="v${VERSION}"
DMG="target/SClaw-${VERSION}-arm64.dmg"
gh release upload "$TAG" "$DMG" "${DMG}.sha256" --clobber
```

## 说明

- `target/` 目录只存放编译和打包产物，不需要提交到 Git。

## 安装应用

- 下载正式签名的 SClaw dmg，双击打开，把 SClaw 拖到 Applications 文件夹中。

![安装界面](docs/images/install.png)

- 正式签名并公证的安装包不需要执行 `xattr -dr`；首次打开仍会显示 macOS 标准的互联网下载确认框。本地无参数模式生成的未签名包只用于开发验证，不用于分发。

- 安装完成后打开 SClaw.app

![启动应用](docs/images/app.png)

- SClaw.app 启动以后会自动打开弹出浏览器，地址: http://127.0.0.1:3180/

![启动页面](docs/images/sclaw.png)

## 对接飞书

- 获取飞书秘钥，打开 [飞书开放平台](https://open.feishu.cn/app?lang=zh-CN)  - 开发者后台 - 创建企业自建应用

![创建企业自建应用](docs/images/create.png)

- 创建企业自建应用，填写 应用名称、应用描述、应用图标

![创建企业自建应用](docs/images/yingyong.png)

- 获取 App ID 、 App Secret 、 Verification Token，填写到 SClaw - 扩展 - 配置feishu

![获取秘钥](docs/images/aksk.png)

![获取token](docs/images/token.png)

- SClaw 安装扩展 - 飞书

![安装扩展](docs/images/feishu.png)

- 配置飞书秘钥 App ID 、 App Secret 、 Verification Token

![配置feishu](docs/images/save.png)

- 等待配对

![等待配对](docs/images/wait.png)

注意：如果配置失败，先移除Feishu扩展，然后强制退出SClaw，重新打开SClaw应用，快速配置 App ID 、 App Secret 、 Verification Token，否则可能会因为长时间未配置导致socket长连接断开而无法连接。

- 配置飞书应用权限

在 权限管理 页面，点击 批量导入 按钮，粘贴以下 JSON 配置一键导入所需权限：
```
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:write",
      "contact:contact.base:readonly",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "docs:document.content:read",
      "event:ip_list",
      "im:chat",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource",
      "sheets:spreadsheet",
      "wiki:wiki:readonly"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```
注意：im:message.group_msg 权限（获取群组中所有消息，属于敏感权限）允许机器人接收群组中所有消息（不仅仅是 @机器人的）。如果您需要配置 requireMention: false 让机器人无需 @ 也能响应，则必须添加此权限。

![image](docs/images/quanxian.png)

![image](docs/images/daoru.png)

- 启用机器人能力

在 应用能力 > 机器人 页面：

  1. 开启机器人能力
  2. 配置机器人名称

  ![机器人](docs/images/bot.png)

- 配置事件订阅, 添加事件：im.message.receive_v1（接收消息）

![image](docs/images/event.png)

- 发布应用
 1. 在 版本管理与发布 页面创建版本
 2. 提交审核并发布
 3. 等待管理员审批（企业自建应用通常自动通过）

 ![image](docs/images/push.png)

 - 飞书聊天机器人发送 DM 配对

 ![image](docs/images/DM.png)

 ![image](docs/images/approve.png)

 - 最后就可以和飞书机器人进行加密对话了
