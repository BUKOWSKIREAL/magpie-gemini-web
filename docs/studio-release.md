# AI Studio 托管后端构建

插件使用 `0.3.3-magpie.1`，基于 AIStudio2API `v0.3.3`（`718ea76f1c0d5a981c6368f936ec29c1acc5429e`）。上游版本、commit、Go 版本、C/C++ 工具链、SpiderMonkey 与 libwebp 静态库（`toolchains`）、补丁列表、安装包及二进制 SHA-256 均记录在 `lib/studio-release.json`。`upstream.camoufox` 是这个 commit 要求的 Camoufox 版本（上游 `internal/camoufoxnative/download.go` 里的 `camoufoxRelease`），更新上游 commit 时要一起核对，构建脚本发现不一致会报错。MIT 许可见 `LICENSE-AISTUDIO`。

## 0.3.3 升级兼容

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

- 上游 v0.2.18 删除了纯 Go（goja）的 WAA 后端 `go`，改为经 CGO 内嵌 Firefox 的 JS 引擎 SpiderMonkey（`WAA_BACKEND=spidermonkey`）。插件固定使用 `spidermonkey`：生成仍在服务进程内完成，不需要浏览器；Camoufox 仍只用于 Google 登录。上游默认的 `camoufox` 后端未采用。
- SpiderMonkey 使用上游自己发布时用的预编译静态库（`Mag1cFall/firefox` 的 `v152.0.4-aistudio2api.1` release），每个目标的归档名与 SHA-256 记录在 `toolchains.spidermonkey`，构建时下载到 `studio-build/toolchains/` 并校验。头文件与库经 `CGO_CXXFLAGS` / `CGO_LDFLAGS` 传入，库名由上游 `internal/waa/mozjs` 的 `#cgo` 指令给出，与上游 `.github/actions/spidermonkey` 一致。
- 新增设置 `SEARCH_MODEL_ALIASES`、`GOOGLE_SEARCH`、`CONTINUATION_REWRITE`、`CONTINUATION_PROMPT` 保留管理页保存的值，并隔离宿主环境同名变量。上游默认开启 `SEARCH_MODEL_ALIASES`，把每个可搜索的对话模型再列一份 `<id>-search`；插件在 `.env` 缺少该项时写入 `false`，避免 Magpie 的模型列表大多重复一遍，用户可在管理页开启。其余三项沿用上游默认。
- Gemini 原生接口（`/v1beta`，Magpie 画图用）在 v0.2.18 按 Gemini 的方式拒绝密钥：错误密钥返回 400 `API_KEY_INVALID`，缺少密钥返回 403。插件把这两种情况当作 401 处理，提示重新登录；Google 自身返回的 403（如 code 7 “The caller does not have permission”）属于账号问题，原样传回。
- 上游 v0.2.17 改用需要 CGO 的原生 SQLite。账号和配置沿用原目录；首次打开旧数据库会整理空闲页。降级前应停止服务并备份完整数据目录，旧版不保证能读取迁移后的数据。
- 上游（v0.2.17 起，v0.2.18 仍然）会删除旧的请求正文 `bodies` 表。`patches/studio-0.2.17-preserve-request-bodies.patch` 改为在事务内压缩并迁移到 `request_bodies`，已有新版同 ID 记录优先，成功后才删除旧表；失败回滚。补丁原样适用于 v0.2.18，供从 0.2.16 及更早版本直接升级的用户使用；它包含旧正文读取、重复打开及迁移失败回滚测试，随上游测试一起运行。
- 新增的 `FIRST_EVENT_HEDGE` 保留管理页保存的值，同时隔离宿主环境同名变量。托管插件在未配置时设为 `off`。备用请求需要空闲账号和 Worker；插件默认单 Worker，不自动提高并发。
- 模型档位优先使用 `/v1/models` 返回的 `thinking_levels`；旧外部服务未返回该字段时沿用四档。Playground 通道、托管更新限制及插件默认并发保持原设置。
- macOS 与 Windows 都可能使用系统代理；显式代理及管理页设置仍优先，宿主的 `HTTP_PROXY` 等变量不传入服务。

## 在线更新策略

上游从 v0.2.14 起原生支持分发方管理更新。构建时通过 `-ldflags` 写入以下值：

- `internal/app.version=v0.3.3-magpie.1`：明确的版本标识。同基线或更旧的官方版、以及更旧的托管版需要升级；更新的官方版、更新的托管版或不认识的定制版仍提示冲突。
- `internal/app.managedBy=magpie-gemini-web`：`GET /api/update`（包括 `?refresh=1`）只返回本地版本、`mode: managed` 和 `managed_by`，不访问 GitHub；`POST /api/update` 返回 HTTP 409，不下载、不替换文件、不重启。管理页显示“更新由 magpie-gemini-web 管理”。

`internal/config.managedBy=magpie-gemini-web` 同时启用上面的配置兼容补丁。

构建不带 `desktop` 标签，不包含桌面窗口。普通插件升级、账户登录、模型调用及管理功能继续保留，用户自行连接的外部服务不受影响。

## 复现构建

维护者需要 Git、tar、curl、Node.js 26.8.2、Go 1.27.1，以及 `lib/studio-release.json` 的 `toolchains` 固定的 C/C++ 工具链。SQLite 需要 C、SpiderMonkey 需要 C++，工具链因此也是 pin 的一部分：

| 目标 | 工具链 | 跨机器字节一致 |
|---|---|---|
| Linux x64/arm64 | Zig `toolchains.zig`（`zig cc` / `zig c++`），musl 静态链接，不依赖构建机器的 glibc | 是：Zig 是自带 libc 的交叉编译器，任何主机产物相同 |
| Windows x64 | llvm-mingw `toolchains.llvmMingw`（Clang + LLD + UCRT），静态链接，PE 时间戳为 0 | 是：同上；构建脚本自动下载并按 SHA-256 校验。Windows 的库（含 C++ 运行库）取自 Linux x64 归档，见下 |
| macOS arm64/x64 | Xcode `toolchains.xcode`，最低目标 macOS 13（与 Go 1.27 一致），只能在 macOS 上构建 | 仅在同一 Xcode 下：Apple 链接器和 SDK 随 Xcode 变化 |

- Zig 默认从 PATH 查找，也可用 `STUDIO_ZIG=/absolute/path/to/zig` 指定。
- llvm-mingw 首次使用时下载到 `studio-build/toolchains/`（macOS、Linux x64、Windows x64 主机各有固定的归档及 SHA-256），之后复用。`STUDIO_MINGW_CC` 可指定其他 `x86_64-w64-mingw32-clang`（C++ 编译器取同目录的 `clang++`），但 `--verify` / `--write-pins` 要求其版本与 pin 一致。
- llvm-mingw 的 Linux 与 Windows 归档里 Windows 目标库逐字节相同，macOS 归档里的是另行构建的，其中 C++ 运行库（libc++abi）会把各自的构建路径写进可执行文件。因此在 macOS 上构建 Windows 时，链接 Linux x64 归档（同样固定 SHA-256）里的目标库；各主机都以一个 `-L` 指明目标库目录，因为 cgo 会把每个链接参数写成生成代码的一行，参数个数不同会改变可执行文件里的行号表。
- SpiderMonkey 静态库同样在首次使用时按目标下载到 `studio-build/toolchains/` 并校验 SHA-256，之后复用。
- Linux（musl）的 SpiderMonkey 静态库带有 mozglue 的环境变量拦截函数（`libjs_static.a` 的 `Unified_cpp_mozglue_interposers0.o`）：除 `getenv` 外，`setenv` 等都经 `dlsym(RTLD_NEXT)` 找 C 库原函数，静态链接的程序找不到，便有意崩溃（`MOZ_CRASH`）；Go 的 `os.Setenv` 在 cgo 程序里正走这条路。构建脚本校验下载后用 `zig ar` 删除这个目标文件，改用 musl 自己的函数；找不到该文件时报错，提示核对新版 SpiderMonkey。上游测试只在动态链接的 glibc 库（`linux-amd64-gnu`）上运行，不会遇到这个问题。
- Xcode 用 `DEVELOPER_DIR=/Applications/Xcode_<版本>.app/Contents/Developer` 选择，不需要改系统默认。不要用 beta 版 Xcode 制作发布包。
- 所有目标都以 `-trimpath -buildvcs=false -ldflags=-buildid=` 编译：Go 默认的 build ID 会哈希 C 编译器路径等构建输入，导致不同机器上内容相同的程序哈希不同。
- Windows 使用 Git Bash 执行命令，安装包运行和解压使用 Windows 自带 PowerShell。最终用户不需要构建工具。

`--verify` 和 `--write-pins` 会在开始构建前检查每个目标的工具链是否与 pin 一致，不一致时几秒内报错并说明需要的版本；不带这两个参数的普通构建只给出警告。

```bash
# 构建所有五个平台并核对现有 pin（macOS 目标需要固定的 Xcode）。
npm run studio:release:build

# 只构建当前平台，或用逗号指定多个目标（Linux/Windows 目标不要求固定的 Xcode）。
node scripts/studio-release.mjs --target=host --verify
node scripts/studio-release.mjs --target=linux-x64,linux-arm64,win32-x64 --verify

# 可复用本地仓库；始终导出固定 commit，再应用清单中的补丁，不使用工作区修改。
node scripts/studio-release.mjs --source=/path/to/AIStudio2API --verify
```

输出在 `studio-build/release/`，不进入 npm 包。包含安装包、构建记录、SHA256SUMS 和上游许可证。构建记录包含固定工具链、实际编译器版本及补丁 SHA-256；`--verify` 失败时也会写入，便于对比差异。安装包固定文件顺序、权限与时间。前端 `.gz` 资源通过 `scripts/studio-regzip.go` 重新压缩，消除 Node zlib 跨平台差异。

## 生成 pin

正式 pin 由 CI 生成，因为 macOS 产物只能在固定的 Xcode 下复现，而 GitHub runner 上有固定版本的 Xcode。修改上游 commit、补丁或工具链后：

1. 审查源码和补丁，更新 `lib/studio-release.json` 的版本、上游及 `toolchains`，提交并推送。
2. 手动运行 **Verify managed AI Studio release** 并勾选 `write_pins`（候选模式）：

   ```bash
   gh workflow run studio.yml --ref <分支> -f write_pins=true
   ```

   每个 runner 构建、测试、记录自己平台的哈希；`Collect candidate pins` 作业用 `scripts/studio-pins.mjs` 校验所有构建记录来自同一源码、补丁和工具链，再把五个平台合并成 `candidate-pins` 产物，并在作业摘要中给出 diff。
3. 下载产物覆盖清单后提交（`gh run download` 不覆盖已有文件，所以先下载到临时目录）：

   ```bash
   dir="$(mktemp -d)" && gh run download <run-id> --name candidate-pins --dir "$dir" \
     && cp "$dir/studio-release.json" lib/studio-release.json
   ```

4. 推送后，PR 上的验证会在全新 runner 上重新构建并严格比对。这一步证明 pin 可以复现，而不只是记录了一次构建结果。

Linux 和 Windows 的 pin 也可以在本机生成（`--target=linux-x64,linux-arm64,win32-x64 --write-pins`），结果应与 CI 相同。不同来源的 pin 不一致说明工具链没有真正固定，应查明原因，不要直接覆盖。候选模式的产物以 `candidate-` 开头，`publish-studio.yml` 只接受 `studio-` 开头的验证产物，因此候选构建不会被上传到 release。

## 验证与发布

```bash
# 在独立临时数据目录安装当前平台真实安装包，无需 Google 账号。
npm run studio:managed:smoke

# 让插件离线恢复测试使用刚构建的安装包。
AI_STUDIO_TEST_ARCHIVE=/absolute/path/to/archive.tar.gz npm test
```

真实安装验证检查旧版请求正文迁移及重启后可读、管理页保存的备用请求设置、启动、版本、GET 更新状态、POST 更新返回 409、二进制及 PID 不变、管理页面显示托管提示、停止与状态。`.github/workflows/studio.yml` 在五种系统/架构的原生 runner 上重新构建、对比 SHA-256 并运行该验证；本机交叉编译不能代替 Linux/Windows 真机验证。

## 0.3.2 升级验证（2026-11-08，历史记录）

- 五个平台的候选构建（[run 42443570134](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42443570134)）通过上游测试、真实安装冒烟验证（含旧版 `bodies` 表迁移、Dock 图标设置保存与重启持久化、SpiderMonkey 与 libwebp 静态链接、管理页配置持久化）及插件测试；安装包和二进制 pin 来自该次构建。
- 随后的严格验证构建（[run 42444479121](https://github.com/BUKOWSKIREAL/magpie-gemini-web/actions/runs/42444479121)）在五个平台的全新 runner 上重新构建，安装包与可执行文件哈希均和 pin 完全一致，真实安装冒烟验证与插件测试全部通过。

## 0.3.1 升级验证（2026-11-07，历史记录）

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

发布前必须审查各平台 CI 与构建记录，再将安装包及许可证上传到本仓库 `studio-v0.3.3-magpie.1` release。该 release 的安装包可公开下载后，才能发布对应 npm 版本，否则新安装会遇到 404。合并 PR 不代表已经满足发布条件；构建脚本及验证 CI 不自动发布 release 或 npm 包。

本地试用建议使用独立数据目录：

```bash
node scripts/studio.mjs install --data-dir /path/to/studio-031-trial --archive /absolute/path/to/archive
node scripts/studio.mjs start --data-dir /path/to/studio-031-trial
node scripts/studio.mjs stop --data-dir /path/to/studio-031-trial
```

使用现有账号数据测试前，先停止旧服务并备份；不要让两个进程同时写同一个数据目录。
