# AI Studio 托管后端构建

插件使用 `0.2.17-magpie.1`，基于 AIStudio2API `v0.2.17` 的固定 commit。上游版本、commit、Go 版本、C 工具链（`toolchains`）、补丁列表、安装包及二进制 SHA-256 均记录在 `lib/studio-release.json`。`upstream.camoufox` 是这个 commit 要求的 Camoufox 版本（上游 `internal/camoufoxnative/download.go` 里的 `camoufoxRelease`），更新上游 commit 时要一起核对，构建脚本发现不一致会报错。MIT 许可见 `LICENSE-AISTUDIO`。

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

维护者需要 Git、tar、curl、Node.js 26.8.2、Go 1.27.1，以及 `lib/studio-release.json` 的 `toolchains` 固定的 C 工具链。SQLite 需要 CGO，C 工具链因此也是 pin 的一部分：

| 目标 | 工具链 | 跨机器字节一致 |
|---|---|---|
| Linux x64/arm64 | Zig `toolchains.zig`，musl 静态链接，不依赖构建机器的 glibc | 是：Zig 是自带 libc 的交叉编译器，任何主机产物相同 |
| Windows x64 | llvm-mingw `toolchains.llvmMingw`（Clang + LLD + UCRT），静态链接，PE 时间戳为 0 | 是：同上；构建脚本自动下载并按 SHA-256 校验 |
| macOS arm64/x64 | Xcode `toolchains.xcode`，最低目标 macOS 13（与 Go 1.27 一致），只能在 macOS 上构建 | 仅在同一 Xcode 下：Apple 链接器和 SDK 随 Xcode 变化 |

- Zig 默认从 PATH 查找，也可用 `STUDIO_ZIG=/absolute/path/to/zig` 指定。
- llvm-mingw 首次使用时下载到 `studio-build/toolchains/`（macOS、Linux x64、Windows x64 主机各有固定的归档及 SHA-256），之后复用。`STUDIO_MINGW_CC` 可指定其他 `x86_64-w64-mingw32-clang`，但 `--verify` / `--write-pins` 要求其版本与 pin 一致。
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

## 本次升级验证（2026-10-29）

- 上游前端 lint/build、Go 测试（含迁移补丁测试）通过；插件完整测试 207 项通过，无跳过。
- Linux 二进制为静态链接，Windows 二进制只导入 UCRT 与 KERNEL32、PE 时间戳为 0；npm 打包检查包含迁移补丁，排除构建产物。
- 跨机器一致性：Linux 与 Windows 的 pin 在 macOS arm64 本机交叉编译生成，CI 的 Linux x64/arm64 和 Windows x64 runner 原生重建后哈希完全一致；CI 候选构建得到的这三个平台哈希也与本机相同。macOS 的 pin 由 CI 在 Xcode 26.3 下生成，另一次独立的 CI 构建得到相同的 darwin-arm64 哈希。
- 五个平台都在 CI 原生 runner 上通过真实安装冒烟验证（含旧请求正文迁移及重启）和插件测试。
- 新版 Google 登录/生成端到端验证尚未完成。
- 此分支未发布后端 release 或 npm 包。本机日常后端仍使用 `0.2.16-magpie.1`，新版仅在临时数据目录运行。

发布前必须审查各平台 CI 与构建记录，再将安装包及许可证上传到本仓库 `studio-v0.2.17-magpie.1` release。该 release 可公开下载后，才能发布引用它的插件版本，否则新安装会遇到 404。构建脚本及验证 CI 不自动发布 release 或 npm 包。

本地试用建议使用独立数据目录：

```bash
node scripts/studio.mjs install --data-dir /path/to/studio-017-trial --archive /absolute/path/to/archive
node scripts/studio.mjs start --data-dir /path/to/studio-017-trial
node scripts/studio.mjs stop --data-dir /path/to/studio-017-trial
```

使用现有账号数据测试前，先停止旧服务并备份；不要让两个进程同时写同一个数据目录。
