# AI Studio 历史定制构建与升级验证归档

本文件归档历史托管构建（`0.2.17`～`0.3.5`）及本地候选验证记录，供追溯兼容性设计与历史 CI run 使用。当前有效的官方接入架构、环境变量约束与 `0.3.7` 兼容性说明请见 [../studio-release.md](../studio-release.md)。

## 0.3.5 升级兼容（历史记录）

- 基线为上游 `v0.3.5`（`bab7209eef0d5a8f9baed4652d7e4158a3adad7b`）。包含 Ultra 模型目录读取优先、Gemini 4 Carbon 定价、Responses `agent_message` 输入支持、额度 429 的 `Retry-After`、Worker 并发与取消修复、连接错误原账号重试，以及中文欢迎弹窗处理。
- 导入已有账号会更新认证状态并保留文件绑定与续签材料；新增登录任务仍以本次任务返回的规范账号 ID 为准，不把账号列表中已有的记录当作登录完成。专用重登入口继续使用浏览器并限制目标账号。
- 上游会将特定客户端系统提示中的身份归属句改为中性描述，并过滤 Claude Code 计费行及含 RFC 2119 keywords 的行；这是上游协议处理行为。
- 请求正文迁移、托管配置与自动登录补丁原样适用；附加补丁只更新重登提示及对应测试。Camoufox、SpiderMonkey、libwebp 和固定编译器工具链保持不变。

## 0.3.4 升级兼容（历史记录）

- 基线为上游 `v0.3.4`（`a4092efcdf358775339aa27cbb4db027fdf8f100`）。包含 SpiderMonkey Worker 关闭超时崩溃修复、账号启用／禁用即时生效与后台平滑排空、Google AI 欢迎弹窗自动关闭、图片生成 WAA 请求 30 秒超时保护、Responses 流式心跳保活、`-build` 助手配额阶梯式冷却（1/5/15/30/60 分钟），以及管理页界面重构（含接入指南面板新增 Magpie 说明）。Camoufox、SpiderMonkey、libwebp 和固定编译器工具链沿用上一版。
- 请求正文迁移补丁与托管配置补丁均原样适用于 `v0.3.4`。

## 0.3.3 升级兼容（历史记录）

- 基线为上游 `v0.3.3`（`718ea76f1c0d5a981c6368f936ec29c1acc5429e`）。包含 `fill-first` 账号优先顺序（`ACCOUNT_ORDER`）与管理页拖拽排序、按模型绑定专属账号池（`MODEL_ACCOUNTS`）、预热池按账号优先顺序选号、自动续写历史清理（避免重复拼接 `[Continue]` 提示词与残缺尾部）、以及 Google AI Ultra 层级识别。Camoufox、SpiderMonkey、libwebp 和固定编译器工具链沿用上一版。
- 新增 `ACCOUNT_ORDER` 与 `MODEL_ACCOUNTS`：插件保留管理页保存的值，并隔离宿主环境同名变量；同时支持在插件选项中通过 `studio.accountOrder` 与 `studio.modelAccounts` 配置初始默认值（当 `.env` 中尚未设置或为空时写入，管理页保存非空值后优先保留管理页设置）。
- 额度卡片、登录账号选择器与 `studio:status` 同步适配 `ACCOUNT_ORDER` 与 `MODEL_ACCOUNTS`：按 `ACCOUNT_ORDER` 排列账号顺序，按 `MODEL_ACCOUNTS` 计算对应模型冷却窗口的分母，并在卡片中展示已配置的账号顺序与模型绑定。
- 请求正文迁移补丁与托管配置补丁均原样适用于 `v0.3.3`；真实安装冒烟增加 `account_order` 与 `model_accounts` 保存与重启持久化检查。

## 0.3.2 升级兼容（历史记录）

- 基线为上游 `v0.3.2`（`4c44cb9765aa9fd497b91db1f5c1573504b9b85f`）。包含安全／拒答原因透传与重试、Build 模型工具调用续读、每日额度冷却回退、Omni 内联图片与视频、附件预览和视频抽帧设置，以及长文本、Worker 冷启动和 Camoufox 界面运行性能修复。Camoufox、SpiderMonkey、libwebp 和固定编译器工具链沿用上一版。
- 新增 `HIDE_DOCK_ICON`：插件保留管理页保存的值，并隔离宿主环境同名变量；该设置只影响上游桌面版，托管构建仍不带 `desktop` 标签。
- 请求正文迁移补丁与托管配置补丁均原样适用于 `v0.3.2`；真实安装冒烟增加 Dock 图标设置保存与重启持久化检查。

## 0.3.1 升级兼容（历史记录）

- 基线为上游 `v0.3.1`（`80847a7665c442a238918c957963217773f36291`）。包含 AVX2/NEON 汇编图片与音频编码加速、libwebp 1.6.0 有损 WebP 编码、多 choice／图片生成／Gemini 生成结果复制指向已释放栈的崩溃修复、预热登录续签与模型目录同步互等修复、10 秒流式心跳与 `X-Accel-Buffering: no`、YouTube 链接误识别与代码文本附件修复、账户时区不可见字符清理，以及到期资源与媒体目录上限回收。Camoufox、SpiderMonkey 静态库和固定编译器工具链沿用上一版。
- 新增 `toolchains.libwebp`（`Mag1cFall/libwebp` 的 `v1.6.0-aistudio2api.1` release），与 SpiderMonkey 一样按目标下载到 `studio-build/toolchains/` 并校验 SHA-256；头文件统一经 `CGO_CPPFLAGS` 传入以保留 `-O2`，与上游 `.github/actions/static-libraries` 一致。
- `patches/studio-0.2.17-preserve-request-bodies.patch` 适配上游 `sqlitedb.Open(path, schema)` 的表结构同步：在建表后、清理未定义旧表前执行 `migrateLegacyBodies`，确保从 0.2.16 及更早版本升级时先完成 `bodies` 事务迁移再删除旧表，迁移失败仍原子回滚。
- `patches/studio-0.2.19-managed-config.patch` 适配上游 `v0.3.1` 的 `WAA_BACKEND` 回写与回退分支：托管构建（`internal/config.managedBy=magpie-gemini-web`）在 `Load` 时不根据旧账户目录自动切换为 `camoufox` 或向 `.env` 追加键，在 `Save` 时继续完整写出全部非环境变量控制项。

## 0.3.0 升级兼容（历史记录）

- 基线为上游 `v0.3.0` 加 PR #109（`48f75fa722b25d22a493e75f6d4e5f9d5035d7e3`）。包含账号异步任务流、本机 Chrome / Cookie / CDP 浏览器账号导入、超过 63 字符的工具函数名自动压缩还原、`STRIP_THOUGHT_SIGNATURES`、Responses / Interactions / 音频状态持久化（`runtime/states.db`）、`gemini-live-2.5-flash` 与 `gemini-2.5-pro-tts` 等模型更新，以及上游默认 `WAA_BACKEND=spidermonkey`。Camoufox、SpiderMonkey 静态库和固定工具链沿用上一版。
- 后台账户任务适配：上游 `POST /api/accounts` 与 `POST /api/accounts/{id}/login` 改为启动不随 HTTP 请求取消的后台任务（返回 `202 Accepted` 与 `{ task }`）。插件与 CLI 通过 `studioLogin` 轮询 `GET /api/accounts/tasks` 等待完成，再从 `GET /api/accounts` 读取账号，并在结束或超时退出时调用 `DELETE /api/accounts/tasks/{id}` 清理或取消后台任务（超时会自动关闭弹出的 Camoufox 登录窗口）。
- 配置项变更：上游移除了废弃的 `TEMPORARY_CHAT`，新增 `STRIP_THOUGHT_SIGNATURES`（默认 `false`）。插件移除 `TEMPORARY_CHAT` 默认项，保留管理页保存的 `STRIP_THOUGHT_SIGNATURES`，并隔离宿主环境的同名变量。
- `patches/studio-0.2.19-managed-config.patch` 同步适配上游 `v0.3.0` 新增的 `workerDefaultKeys`（`WARM_WORKER_LIMIT`、`MAX_ACTIVE_WORKERS`）分支：托管构建（`internal/config.managedBy=magpie-gemini-web`）继续完整写出全部非环境变量控制项，避免插件默认并发设置覆盖管理页保存的上游默认值。

## 0.2.19 升级兼容

- 基线为上游 `v0.2.19`（`0451f26248b7ce263a4fdbf92b280897cb79d74f`）。包含无正文输出时的函数调用格式错误／断流／流尾 5xx 重试、复杂 Schema 修复、SpiderMonkey 堆收缩和 HTTP/2 连接复用。Camoufox、SpiderMonkey 静态库和固定工具链沿用上一版。
- 新增 `API_KEY_ACCOUNTS` 与 `FIRST_EVENT_HEDGE_MODELS`：插件保留管理页保存的值，并隔离宿主环境的同名变量。账号绑定约束后端选号，不会把 Magpie 卡片切换变成账号切换。
- 上游默认 `FIRST_EVENT_HEDGE=auto`，仅对 `gemini-4-argon` 发备用请求。托管插件在未配置时明确写入 `off`，保留已有单 Worker 策略，避免升级后增加额度消耗；已有设置原样保留，用户可以在管理页开启并选择模型。
- 从 0.2.18 升级时，已开启 `FIRST_EVENT_HEDGE=auto` 的用户需要留意模型范围：0.2.18 对所有模型生效，0.2.19 只对 `FIRST_EVENT_HEDGE_MODELS` 列出的模型生效。旧配置没有该列表时，默认只剩 `gemini-4-argon`；需要其他模型时在管理页选择并保存。
- `patches/studio-0.2.19-managed-config.patch` 为配置包增加链接时标识 `internal/config.managedBy=magpie-gemini-web`。托管构建跳过旧全量 `.env` 的自动改写，并继续完整保存可编辑设置，包括等于上游默认值的值。否则用户保存的搜索开关、轮转策略和并发数会从 `.env` 消失，插件下次启动又补回自己的默认值；显式关闭的备用请求和 5 分钟超时也可能被迁移重置。环境变量控制的设置仍锁定，并保留文件里的原值。未设置该构建标识的上游构建仍使用原来的稀疏保存与迁移逻辑。
- 请求正文迁移补丁原样保留。配置补丁测试覆盖旧设置保留、默认值完整保存和环境锁定；真实二进制冒烟测试覆盖管理 API 保存、插件重启、账号绑定和备用请求模型持久化。
- 完整保存的代价是固定当时的上游默认值：在管理页保存一次后，`CONTINUATION_PROMPT`、`FIRST_EVENT_HEDGE_MODELS`、`LOG_MAX_TOTAL_MB` 等可编辑设置都会明确写入文件。以后上游修改默认提示词、模型列表或其他默认值时，已保存的配置不会自动跟随，需要用户在管理页调整。这延续了托管 0.2.18 的全量保存行为。
- 接管官方 0.2.19 安装时，官方稀疏 `.env` 中缺失的项会按插件的初始化规则补齐。例如官方默认 `FIRST_EVENT_HEDGE=auto` 保存后可能不在文件里，接管后就会补成插件默认的 `off`。文件无法区分“刻意选择上游默认值”和“从未设置”；接管后请在管理页核对需要保留的设置。

## 既有升级兼容

- 上游 v0.2.18 删除了纯 Go（goja）的 WAA 后端 `go`，改为经 CGO 内嵌 Firefox 的 JS 引擎 SpiderMonkey（`WAA_BACKEND=spidermonkey`）。当时插件固定使用 `spidermonkey`：生成仍在服务进程内完成，不需要浏览器；Camoufox 仍只用于 Google 登录。上游默认的 `camoufox` 后端未采用。
- SpiderMonkey 使用上游发布的预编译静态库（当前发行版为 `Mag1cFall/firefox` 的 `v152.0.4-aistudio2api.1`，0.3.7 候选为 `v158.0.1-aistudio2api.1`），每个目标的归档名与 SHA-256 记录在对应清单的 `toolchains.spidermonkey`。构建时下载到 `studio-build/toolchains/` 并校验，头文件与库经 CGO 编译参数传入，与对应上游的静态库构建配置一致。
- 新增设置 `SEARCH_MODEL_ALIASES`、`GOOGLE_SEARCH`、`CONTINUATION_REWRITE`、`CONTINUATION_PROMPT` 保留管理页保存的值，并隔离宿主环境同名变量。上游默认开启 `SEARCH_MODEL_ALIASES`，把每个可搜索的对话模型再列一份 `<id>-search`；当时插件会在 `.env` 缺少该项时写入 `false`，避免模型列表大多重复。0.14.0 仅在已有配置首次迁移时补齐此旧值；新安装沿用官方默认，后续管理页选择不会被再次补写。其余三项沿用上游默认。
- Gemini 原生接口（`/v1beta`，Magpie 画图用）在 v0.2.18 按 Gemini 的方式拒绝密钥：错误密钥返回 400 `API_KEY_INVALID`，缺少密钥返回 403。插件把这两种情况当作 401 处理，提示重新登录；Google 自身返回的 403（如 code 7 “The caller does not have permission”）属于账号问题，原样传回。
- 上游 v0.2.17 改用需要 CGO 的原生 SQLite。账号和配置沿用原目录；首次打开旧数据库会整理空闲页。降级前应停止服务并备份完整数据目录，旧版不保证能读取迁移后的数据。
- 上游（v0.2.17 起，v0.2.18 仍然）会删除旧的请求正文 `bodies` 表。`patches/studio-0.2.17-preserve-request-bodies.patch` 改为在事务内压缩并迁移到 `request_bodies`，已有新版同 ID 记录优先，成功后才删除旧表；失败回滚。补丁原样适用于 v0.2.18，供从 0.2.16 及更早版本直接升级的用户使用；它包含旧正文读取、重复打开及迁移失败回滚测试，随上游测试一起运行。
- 新增的 `FIRST_EVENT_HEDGE` 保留管理页保存的值，同时隔离宿主环境同名变量。托管插件在未配置时设为 `off`。备用请求需要空闲账号和 Worker；插件默认单 Worker，不自动提高并发。
- 模型档位优先使用 `/v1/models` 返回的 `thinking_levels`；旧外部服务未返回该字段时沿用四档。Playground 通道、托管更新限制及插件默认并发保持原设置。
- macOS 与 Windows 都可能使用系统代理；显式代理及管理页设置仍优先，宿主的 `HTTP_PROXY` 等变量不传入服务。

## 0.3.7 本地候选验证（2026-11-13）

- macOS arm64 候选构建从干净的上游 `a68acad8b56619a8bef7802131db595ee5d11b6c` 导出源码并重放四个补丁，通过上游前端 lint、类型检查、生产构建、6 个 Magpie 前端测试及全部上游 Go 测试，成功生成真实安装包。构建机使用 Xcode 27.0 beta，仅作兼容验证，不生成正式 macOS pin。
- 真实安装冒烟通过：旧 `bodies` 表迁移与重启后读取、自动登录会话和任务关联、新增配置及既有管理页设置保存与重启持久化、SpiderMonkey、托管更新 HTTP 409、二进制/PID 不变和干净停止。加入自备模式后，默认发行配置和隔离的候选配置分别运行完整插件测试，均为 236 项通过、无跳过；两种配置的真实托管冒烟也均通过。
- 自备模式补充验收：官方 macOS arm64 `v0.3.7` 在临时数据目录真实启动，验证原版管理接口、稀疏默认值与新增配置保存／重启、未知配置键保留、手动登录能力回退、在线更新 `mode: binary`、清理跳过和干净停止。未执行在线更新或真实 Google 登录。
- 分离候选清单与补丁后，再次从干净 v0.3.7 重放并构建，前端检查、6 个 Magpie 前端测试和上游 Go 测试通过。当前发行清单及原有补丁保持已发布 0.3.5 的内容，避免未发布版本名称与旧哈希混用。
- 五平台正式候选 pin、严格复现验证及真实 Google 登录仍待 CI／带账号验证；本地候选哈希不得作为正式发布 pin。

## 0.3.5 升级验证（2026-11-11）

- 五平台候选构建（[run 42948360160](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42948360160)）通过上游测试、真实安装冒烟测试和插件测试。发行清单的安装包及可执行文件 SHA-256 来自该次固定工具链构建。
- PR 和发布提交须分别完成严格复现验证；包含从已发布 `0.3.4-magpie.1` 及同基线官方版本接管升级的回归覆盖。真实 Google 认证和 #53 的登录态生成挂起不属于这组离线验证。

## 0.3.4 升级验证（2026-11-10）

- 五个平台的候选构建（[run 42744366347](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42744366347)）一次性通过上游测试、真实安装冒烟验证（含旧版 `bodies` 表迁移、`account_order` 与 `model_accounts` 设置保存与重启持久化、SpiderMonkey 与 libwebp 静态链接、管理页配置持久化）及插件测试；安装包和二进制 pin 来自该次构建。
- 随后的严格验证构建（[run 42745979214](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42745979214)）在五个平台的全新 runner 上重新构建，安装包与可执行文件哈希均和 pin 完全一致，真实安装冒烟验证与插件测试全部通过。

## 0.3.3 升级验证（2026-11-09，历史记录）

- 五个平台的候选构建（[run 42551469407](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42551469407)）通过上游测试、真实安装冒烟验证（含旧版 `bodies` 表迁移、`account_order` 与 `model_accounts` 设置保存与重启持久化、SpiderMonkey 与 libwebp 静态链接、管理页配置持久化）及插件测试；安装包和二进制 pin 来自该次构建。
- 随后的严格验证构建（[run 42552585708](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42552585708)）在五个平台的全新 runner 上重新构建，安装包与可执行文件哈希均和 pin 完全一致，真实安装冒烟验证与插件测试全部通过。

## 0.3.2 升级验证（2026-11-08，历史记录）

- 五个平台的候选构建（[run 42443570134](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42443570134)）通过上游测试、真实安装冒烟验证（含旧版 `bodies` 表迁移、Dock 图标设置保存与重启持久化、SpiderMonkey 与 libwebp 静态链接、管理页配置持久化）及插件测试；安装包和二进制 pin 来自该次构建。
- 随后的严格验证构建（[run 42444479121](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42444479121)）在五个平台的全新 runner 上重新构建，安装包与可执行文件哈希均和 pin 完全一致，真实安装冒烟验证与插件测试全部通过。

## 0.3.1 升级验证（历史记录，2026-11-07）

- 五个平台的候选构建（[run 42255835006](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42255835006)）通过上游测试、真实安装冒烟验证（含旧版 `bodies` 表迁移、SpiderMonkey 与 libwebp 静态链接、管理页配置持久化）及插件测试；安装包和二进制 pin（含在固定 Xcode 26.3 `17C529` 下生成的 macOS 产物）来自该次构建。
- 随后的严格验证构建（[run 42258671953](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42258671953)）在五个平台的全新 runner 上重新构建，哈希与 pin 完全一致，真实安装冒烟验证与插件测试全部通过。

## 0.3.0 升级验证（2026-11-05，历史记录）

- 五个平台的候选构建（[run 41976798432](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/41976798432)）一次性通过上游测试、真实安装冒烟验证（含 `strip_thought_signatures=false`、`/api/accounts/tasks` 接口与管理页配置持久化）及插件测试；安装包和二进制 pin 来自该次构建。
- 随后的严格验证构建（[run 41977975873](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/41977975873)）在五个平台的全新 runner 上重新构建，哈希与 pin 完全一致，真实安装冒烟验证与插件测试全部通过。

## 0.2.19 升级验证（2026-11-02，历史记录）

- 五个平台的候选构建（[run 41378024737](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/41378024737)）通过上游测试、真实安装冒烟验证及插件测试；安装包和二进制 pin 来自该次构建。Windows 首次在安装前的 PowerShell 进程查询超时，失败作业重跑通过，未修改测试或放宽超时。提交 pin 后仍需由严格验证工作流在新 runner 上重建并逐一比对哈希，结果见升级 PR。
- 本地使用 CI 的 darwin-arm64 安装包运行完整插件测试：212 项通过、无跳过；Python bridge 测试 41 项通过。打包检查包含配置补丁，不包含本地构建和账号数据。
- 从用户界面操作 Magpie 和本地管理页：刷新模型、测试 Argon（界面报告 4.7 秒响应），并确认生图选择器列出五个 AI Studio 图片模型。管理页实际修改账号绑定、每账号并发、轮转策略、搜索模型别名、备用请求开关及模型，保存后完整重启服务；六项均在界面和 API 中保留。测试后恢复原值并再次重启核对。
- 通过真实 Magpie 网关调用 `gemini-4-argon`，九项检查全部通过：无登录浏览器启动、两轮原生工具调用、缺少回传签名时续接、字面引用文本保留、下一轮对话读取两次工具结果、取消活跃请求、取消后再次调用、后端进程重启后用原登录继续工具历史，以及结束时无登录浏览器。重启恢复约 30 秒。
- 通过 Magpie 的 `generate_image` 工具调用 `ai-studio/gemini-3.1-flash-image`，请求 16:9 水彩喜鹊，实际返回 1376×768 JPEG，已打开检查画面。
- 验证使用现有已登录账号；Google 新登录和重新登录流程本次未验证。升级前已备份完整本地数据目录；本机后端已升级，临时调整的设置和 Magpie 供应商开关均已恢复。此分支未 merge，未发布后端 release 或 npm 包。

## 0.2.18 升级验证（2026-10-30，历史记录）

以下为上一版 `0.2.18-magpie.1` 的验证结果，不代表 0.2.19。

- 首次候选构建（run 41025535280）中，Linux x64/arm64 在上游测试 `TestUserCacheRootWithoutEnvironment` 的 `t.Setenv` 处崩溃（见上文环境变量拦截函数），Windows 的 macOS 本机交叉编译结果与 CI 不同（见上文 C++ 运行库）。两处修复后的候选构建（run 41033635405）五个平台都通过上游测试、真实安装冒烟验证（含 `waa_backend=spidermonkey`、`search_model_aliases=false`）与插件测试。
- 跨机器一致性：Linux x64/arm64 与 Windows x64 的 CI 候选哈希与 macOS arm64 本机交叉编译完全一致；darwin-arm64 两次 CI 构建得到相同哈希。pin 来自第二次候选构建，随后的严格验证构建（run 41036094948）在五个平台的全新 runner 上重新构建，哈希与 pin 完全一致，冒烟验证与插件测试通过。
- Linux 二进制为静态链接，不含环境变量拦截函数；Windows 二进制只导入系统 DLL（UCRT、KERNEL32 等），C++ 运行库静态链接，PE 时间戳为 0。
- 真实账号端到端验证（CI 构建的 darwin-arm64 安装包，一个已登录账号复制到临时数据目录，原服务在验证期间停止、结束后恢复）：服务 8 秒就绪，WAA 后端为 spidermonkey，全程未启动 Camoufox；45 个模型中无 `-search` 副本；`gemini-3.8-flash` 文本（4 秒）、流式（3 秒）和图片输入（17 秒，答对左右两半颜色）正常；经插件用 `gemini-3.1-flash-image` 按 16:9 画图得到 1376×768 图片（9 秒）；错误密钥在 Gemini 接口上返回 400 `API_KEY_INVALID`，与插件的判断一致。
- Google 登录（Camoufox 登录窗口）本次未验证：使用的是已登录账号。
- 此分支未发布后端 release 或 npm 包。

## 0.2.17 升级验证（2026-10-29，历史记录）

以下为上一版 `0.2.17-magpie.1` 的验证结果，不代表 0.2.18。

- 上游前端 lint/build、Go 测试（含迁移补丁测试）通过；插件完整测试 207 项通过，无跳过。
- Linux 二进制为静态链接，Windows 二进制只导入 UCRT 与 KERNEL32、PE 时间戳为 0；npm 打包检查包含迁移补丁，排除构建产物。
- 跨机器一致性：Linux 与 Windows 的 pin 在 macOS arm64 本机交叉编译生成，CI 的 Linux x64/arm64 和 Windows x64 runner 原生重建后哈希完全一致；CI 候选构建得到的这三个平台哈希也与本机相同。macOS 的 pin 由 CI 在 Xcode 26.3 下生成，另一次独立的 CI 构建得到相同的 darwin-arm64 哈希。
- 五个平台都在 CI 原生 runner 上通过真实安装冒烟验证（含旧请求正文迁移及重启）和插件测试。
- 新版 Google 登录/生成端到端验证尚未完成。
- 此分支未发布后端 release 或 npm 包。本机日常后端仍使用 `0.2.16-magpie.1`，新版仅在临时数据目录运行。
