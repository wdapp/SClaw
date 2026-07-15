# 荆华密态 sidecar V1 验收记录

> 验收日期：2026-07-15。结论：V1 源码实现、协议回归、SaaS 测试环境部署、无 tools 真实链路、`auto`/`required` 真实两轮密态工具闭环，以及当前源码的 Apple Silicon 签名/公证 DMG 均已完成；生产环境保持未改动。

## 1. 基线与范围

- SClaw Git 基线：`3f89af158d097f211a26753f476cbeb2b65272e9`（`新增 macOS 签名公证打包流程`）。本轮没有提交或推送代码。
- V1 链路：`SClaw Agent → 本机 Sidecar 加密 → SaaS → Gateway → TEE/vLLM → 密态 tool_calls → Sidecar 解密 → SClaw 本地执行 → 加密 tool result 续轮`。
- 入口限定为 `POST /v1/chat/completions`、非流式文本 Agent。`tools` 非空时默认 `tool_choice=auto`，并支持 `none`、`required` 和指定函数。
- 支持纯文本完成、单个或并行 tool-only，以及正文与工具调用混合返回；assistant 参数和 tool result 始终密态传输。
- 无 `tools` 请求保持旧 payload，不补 `tools` / `tool_choice`；未改数据库、chat-web、chat-pc 或私有会话 DTO。SaaS 开关 `OPEN_API_TOOL_CALLING_ENABLED` 默认关闭。
- 工具调用不与流式、附件、图片、语音、RAG 或 Web Search 组合。

## 2. 测试环境与固定版本

| 项目 | 验收值 |
|---|---|
| 测试机 | Apple Silicon（arm64） |
| macOS | 26.5.2（Build 25F84） |
| Rust | rustc 1.94.0 / cargo 1.94.0 |
| Bundled Node | v24.14.0，arm64 Mach-O，最低 macOS 13.5 |
| JSSDK | 1.0.15 |
| App 最低系统 | macOS 13.5 |

## 3. 自动化回归

| 仓库 / 检查 | 结果 | 证据摘要 |
|---|---|---|
| SClaw `node --test sidecar/test/*.test.mjs` | 通过 | 21/21；覆盖无工具兼容、Schema/choice/历史校验、单/并行/混合调用、密态参数和结果、Fake SaaS 两轮本地工具闭环、日志脱敏与进程生命周期 |
| SClaw `cargo test sidecar -- --test-threads=1` | 通过 | 8/8 名称匹配测试；其中 7 个 sidecar supervisor 定向测试，另 1 个既有 schema 测试 |
| SClaw 既有工具/OpenAI 兼容定向集成测试 | 通过 | `e2e_builtin_tool_coverage` 12/12、`e2e_tool_param_coercion` 2/2、`openai_compat_integration` 16/16 |
| SClaw `cargo check --workspace` | 通过 | dev profile 编译成功 |
| SaaS 定向 Jest | 通过 | 86/86；覆盖开关、兼容 payload、工具协议、响应映射、稳定错误码和安全日志 |
| SaaS 全量 `pnpm test --runInBand` | 通过 | 87 个套件、636/636 测试 |
| SaaS `pnpm build` | 通过 | Nest 构建成功 |
| TEE 工具协议与 Worker 采样约束 | 通过 | 14/14；覆盖 choices、并行/混合解析、第二轮 tool history 解密、密态结果，以及 Kimi `auto` marker 保留和 `required` structured outputs 安装 |
| TEE AICC 与 HTTP 鉴权回归 | 通过 | 14/14；AICC 11/11、HTTP auth 3/3；四组定向测试合计 28/28 |
| TEE `python3 -m py_compile ...` | 通过 | `tdx_confidential_tools.py`、`tdx_vllm_openai_chat.py` 与 `tdx_server_tee.py` 均可编译；主文件仍报告一处既有 `return in finally` SyntaxWarning |
| Gateway `go test ./...` | 通过 | 全包通过；新增工具请求/响应逐字节透明转发与日志不泄密回归 |
| DMG bundled Sidecar smoke | 通过 | App 内 `protocol.mjs` / `server.mjs` 与源码逐字节一致；源码和 App 内 JSSDK SHA256 清单均通过；使用 bundled Node 完成工具历史加密和 tool-only 响应解密 |
| 四仓 `git diff --check` | 通过 | 无空白错误 |

SClaw 全量 `cargo test --workspace` 本机结果为 3163 通过、54 失败、3 忽略。失败集中在当前工作树已有的品牌名预期（`ironclaw` / `sclaw`）、NearAI 环境、OAuth 页面、全局环境锁污染和 webhook 时序等测试；sidecar 定向测试、Node 协议测试和 workspace 编译均通过。本记录不把这些失败误报为本功能已解决，也不为此扩大修改范围。

额外尝试的 `e2e_tool_coverage` 5 项在执行测试逻辑前即因仓库未包含其引用的 `tests/fixtures/llm_traces/coverage/*.json` 全部退出；TEE 更广的旧 Agent/Web Search 测试在本机因系统 Python 未安装仓库声明的 `pytest` / `httpx` 依赖而无法加载。两者均记录为既有测试资产/环境缺口，不计为本功能通过，也没有为验收临时安装生产级依赖。

## 4. 工具闭环与安全边界

- Fake SaaS 自动化已验证两轮闭环：第一轮返回加密 tool call，Sidecar 解密标准 OpenAI `tool_calls`；本地执行结果在第二轮重新加密发送，最终正文在本机解密。
- Sidecar 与 SaaS 验证工具名唯一性、函数 Schema、`tool_choice` 和 assistant/tool history 关联；TEE 验证模型支持能力、未知工具、required/none/指定函数约束及并行返回。
- TEE 工具分支要求 system/user/assistant/tool 的文本 part 均携带 `encryption_data`；明文 system、媒体 part 和无效密文均失败关闭。无 tools 分支保留原有 system 兼容行为。
- Gateway 不解析或改写工具字段，只做 byte-for-byte 透明转发。
- 日志仅记录是否启用工具、工具数、调用数、`finish_reason` 和稳定错误码；不记录 Schema、arguments、工具结果、Authorization、DEK 或完整密文。
- 函数名、描述和 JSON Schema 为明文控制面数据；用户消息、assistant `function.arguments` 与 tool result 为密文。SClaw UI、Rust/Node 进程内存和本地聊天历史仍可能存在明文。
- SaaS 测试 API 已部署镜像 `saas:test-dd8cbe45-20260715-160743`，容器确认 `RUNTIME_ENV=test`、`OPEN_API_TOOL_CALLING_ENABLED=true`；测试 Gateway 健康请求返回 `b200-kimi-k26` 正常，生产环境未部署、未打开开关。
- 无 tools 真实回归已通过：当前 debug binary 和 Sidecar 经 `https://api-test.jinghua.security` → SaaS → Gateway → TEE 返回 `5`。首次 request ID `ef774da3-21fe-41cd-99e3-f7eae6ddc81d`；Kimi Worker 最终修复并重启后的复验 request ID `75b584c4-c19c-4816-b8dd-630e4d46b7a8`，证明旧纯文本密态链路未被工具兼容改动破坏。
- `auto` 工具请求 `6d06e2b8-0a73-41ef-8824-351d1b1635ed` 已完整到达 TEE（`tools_enabled=true`、`tool_count=46`），模型合法选择普通文本并以 `finish_reason=stop` 返回；该轮不构成工具执行证据。
- `required` 联调请求 `a007a347-8005-4dce-9591-ee371ae069c9`、`7e2520fd-cb39-415c-82b9-7093cb6da448`、`fa430eaf-653d-4cd4-8da9-d5417448fec0`、`904d01bc-b9ce-4a0c-9037-954390ecbc6c` 均被 SaaS 以 `UPSTREAM_TOOL_RESPONSE_INVALID` 正确失败关闭。根因是自研 Kimi Worker handler 绕过 vLLM OpenAI serving 层，未调用 parser `adjust_request()`，导致 `required` 没有结构化输出约束、Kimi tool marker 也未保留。
- 推理分支 `codex/confidential-tool-calling-tee-v1` 的修复提交 `790ec4b` 部署后，测试环境一度仍返回 0 个 tool calls；上述 request ID 保留为失败关闭和问题定位证据。推理同事进一步修复并重启两个 Kimi Worker 后，以下真实验收全部通过。
- 单 `shell`、`tool_choice=auto` 两轮闭环：第一轮 request ID `f9e3aa90-7174-481d-ac8f-a4f321b38f73` 返回 `tool_call_count=1`、`finish_reason=tool_calls`；SClaw 解密出 `ping -c 1 www.mojingxiong.com`，经本地审批后实际执行成功；第二轮 request ID `020d1539-15d0-4b30-a8b5-b56726ed613f` 携带一组加密调用历史与工具结果，返回 `tool_call_count=0`、`finish_reason=stop` 和最终文本。
- 完整 46 工具、首轮 `tool_choice=required` 两轮闭环：第一轮 request ID `998e206b-70ab-489b-8a88-a57c442fc27c` 返回一个 `shell` 调用；本地执行 exit code 为 0；第二轮 request ID `b191d1df-e676-4016-adca-4b05e2430071` 的上游请求摘要为 `tool_count=46`、`tool_call_count=1`，最终以 `finish_reason=stop` 返回“成功”。这证明完整工具 Schema、密态 arguments、本地执行、密态 result 回传和 TEE 续推理均已打通。
- 完整 46 工具的 `auto` 请求 `323e6c91-34a4-4cf4-bdec-cab4db64a8be` 与 `de8756a4-2793-4141-81f1-6621ec665a45` 合法选择直接文本并以 `finish_reason=stop` 返回；其中模型可能生成类似命令输出的文本，因此不能把普通文本外观当作本地执行证据。协议允许 `auto` 不调用工具；需要强制执行的业务应使用 `required`。
- 上述工具请求的 SaaS 日志仅包含 request ID、工具开关、工具数、历史调用数、返回调用数、`finish_reason` 和错误码；未出现工具 Schema、arguments、ping 输出、工具结果、Authorization、DEK 或完整密文。

## 5. DMG 交付物

| 项目 | 值 |
|---|---|
| 路径 | `target/SClaw-0.1.3-arm64.dmg` |
| 大小 | 68,010,799 bytes（约 64.86 MiB） |
| 目标架构 | arm64（App 主程序和 bundled Node） |
| SHA256 | `c4ef09a70d39428079cdbffcb7a0f1860204e33c3c9a4870c350cb21e17a0ac5` |
| App / Node 签名 | `codesign --verify --deep --strict` / Node 单独 `codesign --verify --strict` 通过 |
| Apple 公证 | accepted；submission `853d06b6-434a-4e70-b08e-f9728646bf08`；stapler validate 通过 |
| DMG 完整性 | `hdiutil verify` 通过 |
| Gatekeeper 输出 | `accepted`，`source=Notarized Developer ID`；当前测试机同时显示 `override=security disabled` |

该 DMG 由本轮当前源码重新构建、签名和公证，包含 V1 sidecar 工具协议与固定 Node/JSSDK runtime，不沿用旧产物哈希。

## 6. 已知限制与上线前检查

1. 仅支持非流式文本工具调用；不支持附件、图片、语音、RAG、Web Search 或加密 reasoning 的组合。
2. 当前 TEE 基线仅放行本地 `nvidia/Kimi-K2.6-NVFP4` vLLM 路径并使用 `kimi_k2` parser；AICC 和其他模型返回稳定能力错误。
3. 本地端口固定为 `127.0.0.1:3190`，sidecar crash 后不会自动拉起；需要重启 SClaw。
4. 当前发行基线仅为 Apple Silicon 和 macOS 13.5 及以上。
5. SaaS 测试环境与真实两轮闭环已就绪；生产默认保持关闭。生产发布前按“推理服务 → SaaS 关闭开关部署 → 小流量开启 → SClaw 发布”的既定顺序执行，并继续观察非法工具响应、TEE 解密失败和端到端耗时。
6. 在 Gatekeeper 开启的干净 Apple Silicon Mac 上复验安装、首次启动、工具闭环和退出清理，消除当前机器 `override=security disabled` 对本机 Gatekeeper 证据的影响。
7. 外部分发前补齐 Node runtime 来源/哈希、JSSDK 与 vendored 依赖许可证清单和 SBOM，并单独处理仓库既有的全量 Rust 测试与 `cargo fmt --check` 基线问题。
