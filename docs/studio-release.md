# AI Studio 托管后端构建

插件使用 `0.2.14-magpie.1`，基于 AIStudio2API `v0.2.14` 的固定 commit。上游版本、commit、Go 工具链、安装包及二进制 SHA-256 均记录在 `lib/studio-release.json`。MIT 许可见 `LICENSE-AISTUDIO`。

## 在线更新策略

上游从 v0.2.14 起支持由分发方管理更新，不再需要补丁。构建时通过 `-ldflags` 写入两个值：

- `internal/app.version=v0.2.14-magpie.1`：明确的版本标识。插件把同基线或更旧的官方版、以及更旧的托管版（`-magpie.N` 的基线更低，或同基线但 N 更小）视为需要升级；更新的官方版、更新的托管版或不认识的定制版仍提示冲突。
- `internal/app.managedBy=magpie-gemini-web`：更新模式为 `managed`。`GET /api/update`（包括 `?refresh=1`）只返回本地版本、`mode: managed` 和 `managed_by`，不访问 GitHub；`POST /api/update` 返回 HTTP 409，说明更新由 magpie-gemini-web 管理，不下载、不替换文件、不重启。这两个值在链接时写死，没有环境变量或管理页开关，在所有构建平台相同。
- 管理页版本面板显示当前版本和"更新由 magpie-gemini-web 管理"，不显示检查更新或安装按钮。上游的在线更新代码仍然编译在内，但托管模式下走不到；`studio:managed:smoke` 用真实二进制验证这一点。
- 构建不带 `desktop` 标签，即上游的命令行版，不包含桌面窗口。
- 普通插件升级、账户登录、模型调用及管理功能继续保留。用户自行连接的外部 AIStudio2API 服务不受影响。

## 复现构建

维护者需要 Git、tar、Node.js 26.8.2（构建页面用）、Go 1.27.1。Windows 使用 Git Bash 执行以下命令，安装包运行和解压使用 Windows 自带 PowerShell。最终用户不需要这些构建工具。

```bash
# 按固定源代码构建所有五个平台，并核对现有 pin。
npm run studio:release:build

# 仅构建当前平台。
node scripts/studio-release.mjs --target=host --verify

# 制作新版本：审查上游源码后重新生成所有平台 pin。
node scripts/studio-release.mjs --write-pins

# 可复用本地上游 git 仓库，但始终导出固定 commit，不使用工作区修改。
node scripts/studio-release.mjs --source=/path/to/AIStudio2API --verify
```

输出在 `studio-build/release/`，不进入 npm 包。包含 macOS x64/arm64、Linux x64/arm64、Windows x64 安装包，以及构建记录、SHA256SUMS 和上游许可证。每个安装包携带许可证和托管升级说明。Go 的标准 tar/zip/gzip 写入器固定文件顺序、权限与时间；编译使用 `-trimpath -buildvcs=false`。

## 验证与发布

```bash
# 在独立临时数据目录中安装当前平台真实安装包，无需 Google 账号。
npm run studio:managed:smoke

# 可选：让插件离线恢复测试使用刚构建的安装包。
AI_STUDIO_TEST_ARCHIVE=/absolute/path/to/archive.tar.gz npm test
```

真实安装验证检查启动、版本、GET 更新状态、POST 更新返回 409、二进制及 PID 不变、管理页面显示托管提示、停止与状态。`.github/workflows/studio.yml` 在五种系统/架构上重新构建、对比 SHA-256 并运行该验证；本机交叉编译不代替 Windows 真机验证。

发布时先审查构建记录和各平台 CI 结果，再将安装包及许可证上传到本仓库 `studio-v0.2.14-magpie.1` release。该 release 可公开下载后，才能发布引用它的插件版本，否则新安装会遇到 404。构建脚本及 CI 不自动发布 release，也不发布 npm 包。

本地试用无需发布：先停止当前托管后端，再执行 `node scripts/studio.mjs install --archive /absolute/path/to/archive` 和 `node scripts/studio.mjs start`。可用 `--data-dir` 指定目录。修改前备份账号和配置；该版本与上游 v0.2.14 使用相同的数据格式。v0.2.14 对数据的改动都是新增的（账号记录的可选字段、新的 `runtime/prompts.db`、`.env` 的新设置），用真实账号验证过：`v0.2.13-magpie.1` 的数据可以直接被它读取，用它运行过之后退回 `v0.2.13-magpie.1` 也能正常使用。
