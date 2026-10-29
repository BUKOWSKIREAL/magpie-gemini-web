# AI Studio 托管后端构建

插件使用 `0.2.17-magpie.1`，基于 AIStudio2API `v0.2.17` 的固定 commit。上游版本、commit、Go/Zig 工具链、补丁列表、安装包及二进制 SHA-256 均记录在 `lib/studio-release.json`。`upstream.camoufox` 是这个 commit 要求的 Camoufox 版本（上游 `internal/camoufoxnative/download.go` 里的 `camoufoxRelease`），更新上游 commit 时要一起核对，构建脚本发现不一致会报错。MIT 许可见 `LICENSE-AISTUDIO`。

## 升级兼容

- 上游 v0.2.17 改用需要 CGO 的原生 SQLite。账号和配置沿用原目录；首次打开旧数据库会整理空闲页。降级前应停止服务并备份完整数据目录，旧版不保证能读取迁移后的数据。
- 上游会删除旧的请求正文 `bodies` 表。`patches/studio-0.2.17-preserve-request-bodies.patch` 改为在事务内压缩并迁移到 `request_bodies`，已有新版同 ID 记录优先，成功后才删除旧表；失败回滚。补丁包含旧正文读取、重复打开及迁移失败回滚测试，随上游测试一起运行。
- 新增的 `FIRST_EVENT_HEDGE` 保留管理页保存的值，同时隔离宿主环境同名变量。默认仍由上游设为 `off`。备用请求需要空闲账号和 Worker；插件默认单 Worker，不自动提高并发。
- 模型档位优先使用 `/v1/models` 返回的 `thinking_levels`；旧外部服务未返回该字段时沿用四档。Playground 通道、纯 Go WAA、托管更新限制及插件默认并发保持原设置。
- macOS 与 Windows 都可能使用系统代理；显式代理及管理页设置仍优先，宿主的 `HTTP_PROXY` 等变量不传入服务。

## 在线更新策略

上游从 v0.2.14 起原生支持分发方管理更新。构建时通过 `-ldflags` 写入两个值：

- `internal/app.version=v0.2.17-magpie.1`：明确的版本标识。同基线或更旧的官方版、以及更旧的托管版需要升级；更新的官方版、更新的托管版或不认识的定制版仍提示冲突。
- `internal/app.managedBy=magpie-gemini-web`：`GET /api/update`（包括 `?refresh=1`）只返回本地版本、`mode: managed` 和 `managed_by`，不访问 GitHub；`POST /api/update` 返回 HTTP 409，不下载、不替换文件、不重启。管理页显示“更新由 magpie-gemini-web 管理”。

构建不带 `desktop` 标签，不包含桌面窗口。普通插件升级、账户登录、模型调用及管理功能继续保留，用户自行连接的外部服务不受影响。

## 复现构建

维护者需要 Git、tar、Node.js 26.8.2、Go 1.27.1，以及目标平台的 C 工具链：

- macOS：Apple Clang / Xcode SDK，最低目标版本为 macOS 13（与 Go 1.27 一致），只能在 macOS 上构建；可以同时构建 arm64 和 x64。
- Linux：Zig 0.16.0，目标为 musl，静态链接，不依赖构建机器的 glibc。
- Windows x64：MinGW-w64 GCC（macOS 可通过 `brew install mingw-w64` 安装），静态链接运行库，关闭 PE 时间戳。

Zig 默认从 PATH 查找，也可用 `STUDIO_ZIG=/absolute/path/to/zig` 指定。Windows 编译器默认是本机的 `gcc` 或交叉编译的 `x86_64-w64-mingw32-gcc`，可用 `STUDIO_MINGW_CC` 指定完整路径。Windows 使用 Git Bash 执行命令，安装包运行和解压使用 Windows 自带 PowerShell。最终用户不需要构建工具。

```bash
# 在 macOS 上构建所有五个平台，并核对现有 pin。
npm run studio:release:build

# 仅构建当前平台。
node scripts/studio-release.mjs --target=host --verify

# 制作新版本：审查源码和补丁后重新生成全部平台 pin。
node scripts/studio-release.mjs --write-pins

# 单个平台生成 pin；保留其他平台条目，不要并发写同一个清单。
node scripts/studio-release.mjs --target=host --write-pins

# 可复用本地仓库；始终导出固定 commit，再应用清单中的补丁，不使用工作区修改。
node scripts/studio-release.mjs --source=/path/to/AIStudio2API --verify
```

输出在 `studio-build/release/`，不进入 npm 包。包含安装包、构建记录、SHA256SUMS 和上游许可证。构建记录包含编译器及补丁 SHA-256。安装包固定文件顺序、权限与时间，Go 编译使用 `-trimpath -buildvcs=false`。前端 `.gz` 资源通过 `scripts/studio-regzip.go` 重新压缩，消除 Node zlib 跨平台差异。

CGO 引入了 C 编译器、链接器和 SDK 的影响，不能仅凭相同 Go 版本保证跨机器字节一致，尤其是 macOS。`--verify` 仍严格比较安装包和二进制哈希；差异应通过构建记录定位，不应绕过校验或在验证作业里自动重写 pin。

## 验证与发布

```bash
# 在独立临时数据目录安装当前平台真实安装包，无需 Google 账号。
npm run studio:managed:smoke

# 让插件离线恢复测试使用刚构建的安装包。
AI_STUDIO_TEST_ARCHIVE=/absolute/path/to/archive.tar.gz npm test
```

真实安装验证检查旧版请求正文迁移及重启后可读、管理页保存的备用请求设置、启动、版本、GET 更新状态、POST 更新返回 409、二进制及 PID 不变、管理页面显示托管提示、停止与状态。`.github/workflows/studio.yml` 在五种系统/架构上重新构建、对比 SHA-256 并运行该验证；本机交叉编译不代替 Linux/Windows 真机验证。

## 本次升级验证（2026-10-29）

- macOS arm64 本机完成五个平台构建，并再次构建通过全部安装包及二进制 SHA-256 校验。
- 上游前端 lint/build、Go 测试（含迁移补丁测试）通过；插件完整测试 203 项通过，无跳过。
- macOS arm64 真实安装冒烟验证通过；Linux 二进制为静态链接，Windows 二进制只导入系统 DLL；npm 打包检查包含迁移补丁，排除构建产物。
- Linux/Windows 真机运行、不同构建机器的 CGO 哈希一致性，以及新版 Google 登录/生成端到端验证尚未完成。现有 CI 保持严格哈希校验；Apple SDK 或 MinGW 工具链不同可能导致差异，需要发布前核对。
- 此分支未发布后端 release 或 npm 包。本机日常后端仍使用 `0.2.16-magpie.1`，新版仅在临时数据目录运行。

发布前必须审查各平台 CI 与构建记录，再将安装包及许可证上传到本仓库 `studio-v0.2.17-magpie.1` release。该 release 可公开下载后，才能发布引用它的插件版本，否则新安装会遇到 404。构建脚本及验证 CI 不自动发布 release 或 npm 包。

本地试用建议使用独立数据目录：

```bash
node scripts/studio.mjs install --data-dir /path/to/studio-017-trial --archive /absolute/path/to/archive
node scripts/studio.mjs start --data-dir /path/to/studio-017-trial
node scripts/studio.mjs stop --data-dir /path/to/studio-017-trial
```

使用现有账号数据测试前，先停止旧服务并备份；不要让两个进程同时写同一个数据目录。
