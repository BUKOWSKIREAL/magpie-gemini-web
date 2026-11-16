# AI Studio 本地后端与历史构建

当前插件（0.14.0 起）已默认接入官方上游发行版，历史托管构建清单仅保留作兼容与复现参考。

默认接入流程为：安装插件 → 登录 Google AI Studio → 自动下载并启动官方后端 → 添加 Google 账号 → 回到连接页确认。安装和后续自动更新均跟随 [Mag1cFall/AIStudio2API](https://github.com/Mag1cFall/AIStudio2API/releases) 最新稳定版。运行时不依赖 `lib/studio-release.json`，插件发布无需先发布定制 AI Studio 安装包。

## 官方安装与版本管理

`lib/studio-upstream.mjs` 从 GitHub Releases API 解析 latest，或 `studio:install -- --version <tag>` 指定的标签；只选择 macOS / Linux x64、arm64 和 Windows x64 对应的官方归档。安装器要求官方仓库的下载 URL 和有效的 `sha256:` digest，校验归档后解压；元数据缺失、哈希不符或不安全归档会中止，保留原程序。发布信息查询和下载均使用已有代理设置。`--archive` 可复用本地官方包，但仍需查询所选版本的官方校验值。CI 通过 `AI_STUDIO_GITHUB_TOKEN` 提供 GitHub 的短期只读凭据，减少共享 runner 的匿名 API 限额影响；它仅用于发布元数据查询，经 curl 标准输入传递，不写入配置、不用于安装包下载认证，也不传给后端。普通用户无需设置该变量。

默认程序保存在数据目录的 `package/aistudio2api`；Windows 官方包属于桌面版，会自行切换工作目录，因此默认把 `aistudio2api.exe` 放在数据目录根部，与 `.env` 和 `runtime/` 相邻。启动先复用已有程序，缺失时下载。`install-manifest.json` 记录来源与完整性校验，不强制恢复历史文件或版本。

`lib/studio-updates.mjs` 在 Magpie 运行期间后台检查官方稳定版：启动一秒后首次尝试，每分钟寻找空闲窗口；成功检查缓存一小时，联网／下载失败后等待 15 分钟重试。只有可解析、较新的稳定版本可以自动安装，未知开发版本和已安装的较新版本不被降级。默认目录自动启用；`studio:updates auto|manual` 修改策略，`studio:install -- --version <tag>` 切到手动更新。高级自备路径和独立服务不参加自动更新。

生成请求的占用持续到响应体读完、取消或中止，流式响应不会在收到响应头后提前释放；登录占用覆盖整个连接回调。进程启动时间和随机标识支持跨宿主协调，失效记录只删除对应的独立文件，避免清理旧锁时误删新锁。更新还检查后台生成计数、忙碌账号、未结束登录任务、浏览器下载／准备和官方更新器状态；能力缺失或状态未知时暂缓。

下载、官方 SHA-256 校验和解压先在暂存目录完成，原服务继续可用。替换前取得维护锁，再检查任务、策略和现有程序哈希；仅在进程身份确认并退出后交换程序，启动新版本并核对报告的版本。失败时尝试恢复并启动旧程序，该发行包随后不再反复触发重启；重新启用自动更新可明确重试。账号、`.env`、配置、端口和凭据原样保留。回滚覆盖程序文件和安装记录，不撤销上游自身的数据迁移。

已有无 `backend` 字段的配置沿用默认目录。具备所需管理接口的旧 `-magpie` 构建也可由插件自动替换为较新的官方包，无需调用其受限的在线更新接口。显式安装、程序切换、启动与自动更新共享生命周期锁；HTTP 暂时关闭但旧进程仍存活时，阻止重复启动或覆盖。需要手动切换时仍可停止服务后执行 `studio:install`。

本地连接所需的监听地址、绝对账号目录 `AISTUDIO_AUTH_STATES`、API key、管理员认证和自动启动由插件维护。新建 `config.json` 标记 `defaultsPolicy: upstream`，其余设置采用官方默认值。已有配置没有该标记时，只为缺失项写入旧默认值，成功后标记 `legacy-migrated`：搜索模型别名关闭，`PER_ACCOUNT_CONCURRENCY`、`WARM_WORKER_LIMIT`、`MAX_ACTIVE_WORKERS`、`WARM_STARTUP_CONCURRENCY` 均为 1，路由为 `fill-first`，请求期限为 30 分钟；同时保留旧版关闭备用请求、非流式保活及生成后端的默认行为。所有显式值及合法未知键保留。迁移只执行一次，避免官方 Save 省略其默认值后又被插件反复补写。

新安装目前采用官方 SpiderMonkey 生成默认值；如果以后选用的版本改变 `WAA_BACKEND` 默认值，生成也可能需要 Camoufox 等浏览器依赖。并发和路由同样跟随所选版本，v0.3.7 为每账号并发 2、预热 10／最大 20 个 Worker 和 round-robin。宿主同名配置变量仍被隔离；`.env` 首行注释避免官方后端误触旧版完整文件迁移。

## 插件账号管理接入

默认官方包没有 `magpie_signin` 能力，`lib/studio-connect.mjs` 会进入 `lib/studio-connect-legacy.mjs`：用户打开已认证的官方管理页添加账号，再回到连接页选择并确认。过期账号会明确提示找到原账号并点击「重新登录」，确认仍限定为原账号。页面在断线时停用确认按钮，恢复后清除临时错误；弹窗拦截重试成功后清除旧提示，迟到响应不会覆盖取消结果。推荐入口改名为「添加账号并连接（推荐）」，直接说明添加后回程确认。凭据由插件生成并接入管理会话，无需填写 URL、API key 或管理员密码；额度卡片不展示管理员信息、凭据位置或程序路径。Magpie 宿主仍有 10 分钟等待上限，官方管理页的后台准备和登录不受该连接超时影响；新增 `studio:prepare-browser` 可在登录前独立准备 Camoufox，不再占用登录计时。原有 `metadata.managed: true` 表示本地生命周期与账号接入，独立于后端版本；已有单账号、账号组卡片和模型功能继续可用。

下面保留任务关联补丁的技术说明。对提供 `magpie_signin: 1` 的旧版或自定义后端，插件继续使用自动完成流程；这不是默认官方安装的前置条件。

提供任务关联能力时，`lib/studio-connect.mjs` 在准备本地服务后，同一标签页自动进入该后端的账号导入／登录界面。上游登录模式展示 Chrome 导入、Cookie 导入、调试浏览器会话导入和浏览器登录，隐藏远程配对。专用重登入口显示加载、错误或账号缺失状态，使用隔离浏览器重新登录。v0.3.5 也支持通过添加账号入口导入同一账号来更新认证状态；`studio-0.3.5-signin-reauth.patch` 修正此前不支持覆盖导入的提示。单个账号成功后直接保存原有 `managed: true` 的 `ai-studio` 登录；批量导入成功后保存 `metadata.accounts` 和带账号集合摘要的 `metadata.email`，使不同分组不会互相覆盖；同组以不同顺序重试保持相同标识。额度卡片的账号和冷却记录都按本次账号组过滤。此元数据不改变后端的全局选号、API key 绑定或模型绑定规则。模型、图片和用量继续走原插件，不调用 `magpie://import` 创建其他供应商。

`patches/studio-0.3.4-magpie-signin.patch` 给管理页增加由 URL fragment 开启的登录模式，并给账号任务增加 `client_id`、成功条目的规范 `account_id` 和 `GET /api/accounts/tasks` 的 `magpie_signin: 1` 能力标识。每次登录使用独立随机标识；只有当前页面提交的完整成功任务能完成认证。插件从后台任务取得账号 ID，再重新读取账号列表校验。已有账号、其他窗口任务、失败或部分失败任务均不会自动完成当前登录。部分失败可只重试失败账号：插件按本次标识累积每个已成功条目的账号 ID，最终成功时合并、去重并重新校验。登录模式暂不提供关闭失败任务的按钮，避免插件观察前删除成功条目；已观察到的成功条目即使之后从任务列表移除也会保留。刷新页面保留登录标识；关闭浏览器后，插件仍能跟踪已启动任务。

管理会话通过本机 HTTP 响应的 `HttpOnly; SameSite=Strict; Path=/api` Cookie 交给浏览器。两个服务均限定为 `http://127.0.0.1`；Cookie 按主机共享，不按端口隔离。临时页使用随机路径、严格 Host / 写操作 Origin 检查和 CSP，状态接口不返回 API key、管理密码或 Google Cookie。上游 fragment 仅含关联标识、本机回程地址、截止时间及可选目标账号；不放凭据。自动流程取消或超时只取消本次标识下仍运行的任务，保留已导入账号。结束后不再发放管理会话，两分钟后关闭临时服务，并清理本次标识下的成功、失败及未结束任务记录。回程页的状态请求会等待正在进行的检查或立即检查任务，无需额外等待轮询周期。

**历史构建：** `0.3.5-magpie.1` 和候选 `0.3.7-magpie.1` 均含自动登录补丁。插件按能力标识选择流程，官方或其他构建缺少该能力时手动确认账号。

候选构建配置位于 `scripts/studio-signin-candidate.json`，空的 `binaries` 条目表示尚无发行哈希，不是可安装的发行清单。普通本机构建可验证补丁和 UI（不会改动当前 pin）：

```sh
node scripts/studio-release.mjs --manifest=scripts/studio-signin-candidate.json --target=host
```

正式五平台构建使用 `studio.yml` 的 `write_pins=true` 和 `signin_candidate=true`，从固定工具链生成 candidate artifacts。收集阶段会验证所有构建记录的上游、补丁哈希和工具链，再产生完整 `candidate-pins`。如需单独发布定制构建，可更新其历史清单并执行五平台验证；普通插件发布无需此步骤。也可用 `scripts/studio-pins.mjs --manifest=<candidate.json> <build-record.json>...` 合并本地候选记录；缺平台或输入不一致会拒绝。不要把本机 beta Xcode 的验证构建哈希写入正式 pin。

测试覆盖当前任务隔离、批量导入、部分失败重试、完成时重新校验、重新登录身份限制、来源检查、旧后端回退、取消和超时；上游补丁另含任务关联、前端回程地址、窄视口导航、路由锁定及重登状态渲染测试。Windows CI 运行全部 `studio*.test.mjs`，候选配置随 npm 包提供。构建脚本同时运行这些测试、上游 Go 测试、前端 lint 和类型检查。真实 Google 登录和 Windows Chrome 导入仍需带账号验证。

## 高级程序路径与验收

「指定 AIStudio2API 程序路径（高级）」和 `studio:use -- <executable>` 共用 `useStudioBinary()`，保存 `backend: { "mode": "user", "binaryPath": "/absolute/path/to/aistudio2api" }`。程序须位于插件和 AI Studio 数据目录之外。插件不复制或下载替换该文件，缺失时直接报错。`studio:use-default` 在停止服务后回到默认目录，保留原自备程序；默认目录的已有程序继续复用。

两种启动模式均传入绝对账号目录环境变量和 `-auth=...` 标记；自备程序的进程归属同时核对该标记和可执行文件，防止误停共用程序的其他实例。检测保留 true／false／unknown 三种结果，无法确认存活进程身份时保留 PID、阻止启动与替换且不发送信号。启动记录另存进程启动时间、程序路径和账号目录，只在 PID 与这些记录仍相符时恢复暂时不可读的命令行归属。macOS 扫描同时读取 comm 和完整启动命令，识别 CLI 更新器的隐藏旧文件及 deleted 标记。两种本地路径均保留认证、状态结构和 API key 检查，不按版本字符串判断服务归属。

`cleanStudio()` 和卸载清理会停止默认目录的实例、删除下载资产并保留账号与配置；自备路径则跳过整个 AI Studio 数据目录及运行进程，显式 `studio:stop` 仍可用。独立运行的服务继续使用 URL + API key 接入。

以下常规验收使用临时数据目录与无 Cookie 的虚构停用／服务受限账号记录，不使用真实 Google 账号、不向 Google 发起生成请求，也不执行在线更新。它们验证真实插件回调、管理会话交接、卡片、停止后重连和取消保留账号，并在副本运行时执行官方更新器相同的 rename／replace／unlink 文件操作，注入 HTTP 拒绝以确定性覆盖重启窗口；结束后停止实例并清理临时数据。服务受限记录无法启动生成服务，对应的启动失败日志是预期结果：

```sh
# 验证普通首次接入：查询官方最新稳定版、下载校验、启动、账号连接页和重启。
npm run studio:official:smoke
# 复用本地官方归档，校验值仍取自 GitHub。
npm run studio:official:smoke -- --version v0.3.7 --archive /path/to/official-archive.tar.gz
# 验证高级程序路径与清理隔离。
npm run studio:user:smoke -- --binary /path/to/official/aistudio2api
```

本机 macOS arm64 已通过官方 v0.3.7 的设置迁移、管理页稀疏保存后重启、有效账号目录及运行中替换程序验收。账号目录测试刻意使用不同工作目录、冲突 `.env` 和虚构停用账号；默认模式还移除 `-auth`，验证环境变量独立生效。此机替换后 comm 仍为原路径，未复现仅因 inode 改变而丢失进程的描述；新增测试覆盖改名／deleted 输出、有无 PID 文件、身份读取失败及恢复，不据此声称跨平台实际更新均已验证。

`studio-official.yml` 现为可复用的五平台验证工作流：先断言各 runner 的实际平台与架构，再运行回归测试、生成真正的 npm tarball，并分别在 Node.js 26.8.2 和 Magpie 当前使用的 Bun 1.4.2 中执行包内的官方安装、生命周期和插件自动更新／回滚冒烟；这些都是必过项。随后补充运行官方内置更新器的验收：它只支持匿名 GitHub API，仅当明确返回匿名限流时，CI 用退出码 75 标记延后并写入工作流摘要，不计为通过；其他错误和无法确认进程退出仍阻断门禁。命令行默认保持严格失败，CI 才显式传入 `--defer-rate-limit`。Bun 另运行连接页的脚本／HTTP 桥接回归。发布工作流必须先对发行 commit 跑完全部五平台，再允许上传或 npm 发布；上传前再次核对 commit 未变；复用已上传 tarball 时也核对其哈希与该 commit 重新打包的结果一致。远端已运行安装与在线更新门禁；自动更新变更仍须在提交后通过同一五平台门禁。

本机 macOS arm64 另完成 Camoufox `158.0.1-beta.41` 的完整下载、解压和隔离登录任务启动，确认官方后端创建了对应的浏览器子进程。真实测试中，连接页取消／超时不取消独立的官方登录任务；另一次实际下载在准备命令和连接页均超时后继续增长。下载进度兼容官方中英文日志。未使用真实 Google 账号，未验证完成 Google 认证后的文本／图片生成；图形界面的实际点击验收也尚未完成。

另增 `npm run studio:update:smoke -- v0.3.6`，只在新建临时目录安装指定旧官方版并显式调用其在线更新 API。`npm run studio:auto-update:smoke` 通过公共插件入口验证后台自动升级，使用虚构停用账号检查设置、凭据和账号文件的保留，并注入校验值一致但无法启动的测试程序来验证回滚与失败重试阻断。两种真实升级均已在本机 macOS arm64 的 Node/Bun 中完成 v0.3.6 → v0.3.7。固定的 0.3.6 仅为升级测试起点，目标版本实时取自官方发布信息。完整本地回归 290 项通过、无失败或跳过；Bun 的连接页、官方安装、自动更新及验收结果处理回归共 54 项通过。历史 `0.3.5-magpie.1` 的真实程序冒烟也通过。

## 历史定制构建

以下记录保留此前的补丁、兼容性验证与复现方法。已发布 `0.3.5-magpie.1` 的工具链和完整哈希留在 `lib/studio-release.json`；`0.3.7-magpie.1` 的 Camoufox 158、SpiderMonkey 哈希及重放补丁独立保存在 `scripts/studio-signin-candidate.json` 和 `patches/studio-0.3.7-*.patch`。候选尚无正式五平台 pin。它们均不参与当前默认安装；`studio.yml` 仅供手动复现历史构建。MIT 许可见 `LICENSE-AISTUDIO`。

## 0.3.7 升级兼容（官方与候选后端）

- 基线为上游 `v0.3.7`（`a68acad8b56619a8bef7802131db595ee5d11b6c`）。包含服务受限账户状态与原因、非额度错误换号上限、Gemini Decision、隐藏模型探测、Gemini 4 Hydrogen Extra High、函数调用与内容拦截收尾修复，以及外部媒体实际连接地址检查。上游删除了全部 `-build` 目录模型；插件原有 `-build` / `assistant_route` 过滤继续保留，用于旧外部服务。额度卡片与账号选择器把新增 `restricted` 状态显示为“服务受限”，单账号卡片保留上游返回的具体原因。
- 浏览器栈升级为 Camoufox `158.0.1-beta.41` 与 SpiderMonkey `v158.0.1-aistudio2api.1`，TLS、QUIC 和 WAA 形状表随上游更新。Camoufox 158 下载量约 1.3 GB；libwebp、Go 和固定编译器工具链沿用上一版。SpiderMonkey 五个目标的归档 SHA-256 保存在 `scripts/studio-signin-candidate.json`，当前发行版仍保留其 152 系列工具链。
- 新增 `MAX_ACCOUNT_SWITCHES` 与 `DISCOVER_HIDDEN_MODELS`：插件保留管理页保存的值、隔离宿主环境同名变量，并在真实安装冒烟中检查保存及重启后的值。上游现在默认 `FIRST_EVENT_HEDGE=off`，与插件原有策略一致；托管配置补丁测试同步这一默认值，并覆盖两个新增配置项。
- OpenAI 模型目录的 `extra_high` 映射为 Magpie 的 `xhigh` variant；没有该档位的模型不增加它。旧外部服务没有 `thinking_levels` 时仍沿用原来的四档。
- 请求正文迁移与托管配置补丁继续适用。自动登录补丁在 v0.3.7 前端上重放，保留新增的 Camoufox 下载状态条；重登说明补丁继续适用。上游 Go 测试、前端检查及 Magpie 登录 UI 测试均随候选构建运行。

更早版本（0.2.17～0.3.5）的升级兼容说明与历次 CI 验证记录已归档至 [docs/history/studio-managed-history.md](history/studio-managed-history.md)。

## 在线更新策略

以下限制仅属于历史定制构建。当前默认下载的官方 CLI 保留上游在线更新能力。历史构建从 v0.2.14 起通过 `-ldflags` 写入：

- `internal/app.version=v0.3.5-magpie.1`（候选为 `v0.3.7-magpie.1`）：历史构建版本标识。当前插件不再据此强制升级、提示版本冲突或恢复文件。
- `internal/app.managedBy=magpie-gemini-web`：`GET /api/update`（包括 `?refresh=1`）只返回本地版本、`mode: managed` 和 `managed_by`，不访问 GitHub；`POST /api/update` 返回 HTTP 409，不下载、不替换文件、不重启。管理页显示“更新由 magpie-gemini-web 管理”。

`internal/config.managedBy=magpie-gemini-web` 同时启用上面的配置兼容补丁。

构建不带 `desktop` 标签，不包含桌面窗口。上述在线更新限制仅存在于托管构建；用户选择的官方 CLI 及独立连接的外部服务保留其更新行为。

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

各版本的候选构建、五平台严格复现与历史验证记录已归档至 [docs/history/studio-managed-history.md](history/studio-managed-history.md)。

发布前必须审查各平台 CI 与构建记录，再将安装包及许可证上传到对应 release（0.3.7 候选为 `studio-v0.3.7-magpie.1`）。该 release 的安装包可公开下载后，才能将完整候选清单替换 `lib/studio-release.json` 并发布对应 npm 版本，否则新安装会遇到 404。合并 PR 不代表已经满足发布条件；构建脚本及验证 CI 不自动发布 release 或 npm 包。

本地试用建议使用独立数据目录：

```bash
node scripts/studio.mjs install --data-dir /path/to/studio-031-trial --archive /absolute/path/to/archive
node scripts/studio.mjs start --data-dir /path/to/studio-031-trial
node scripts/studio.mjs stop --data-dir /path/to/studio-031-trial
```

使用现有账号数据测试前，先停止旧服务并备份；不要让两个进程同时写同一个数据目录。
