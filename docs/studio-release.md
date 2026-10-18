# AI Studio 托管后端构建

插件使用 `0.2.13-magpie.1`，基于 AIStudio2API `v0.2.13` 的固定 commit。上游版本、commit、Go 工具链、安装包及二进制 SHA-256 均记录在 `lib/studio-release.json`。MIT 许可见 `LICENSE-AISTUDIO`。

## 在线更新策略

`patches/studio-managed.patch` 包含后端与管理页面修改：

- 后端移除在线更新的下载、文件替换逻辑；`GET /api/update`（包括 `?refresh=1`）仅返回本地版本及 `mode: managed`，不访问 GitHub。
- `POST /api/update` 返回 HTTP 403，提示通过 Magpie 插件升级；不替换文件、不重启。此策略无环境变量或管理页开关，在所有构建平台相同。
- 管理页版本面板显示当前版本及中英文升级提示，不提供检查更新或安装更新按钮。
- 设置明确的 `v0.2.13-magpie.1` 版本标识。插件将同基线或更旧的官方版视为需要升级；更新的官方版或不认识的定制版仍提示冲突。
- 普通插件升级、账户登录、模型调用及管理功能继续保留。用户自行连接的外部 AIStudio2API 服务不受此补丁控制。

## 复现构建

维护者需要 Git、tar、Node.js 26.8.2（构建页面用）、Go 1.27.1。Windows 使用 Git Bash 执行以下命令，安装包运行和解压使用 Windows 自带 PowerShell。最终用户不需要这些构建工具。

```bash
# 按固定源代码和补丁构建所有五个平台，并核对现有 pin。
npm run studio:release:build

# 仅构建当前平台。
node scripts/studio-release.mjs --target=host --verify

# 制作新版本：审查源码/补丁后重新生成所有平台 pin。
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

真实安装验证检查启动、版本、GET 更新状态、POST 更新返回 403、二进制及 PID 不变、管理页面无更新入口、停止与状态。`.github/workflows/studio.yml` 在五种系统/架构上重新构建、对比 SHA-256 并运行该验证；本机交叉编译不代替 Windows 真机验证。

发布时先审查构建记录和各平台 CI 结果，再将安装包及许可证上传到本仓库 `studio-v0.2.13-magpie.1` release。该 release 可公开下载后，才能发布引用它的插件版本，否则新安装会遇到 404。构建脚本及 CI 不自动发布 release，也不发布 npm 包。

本地试用无需发布：先停止当前托管后端，再执行 `node scripts/studio.mjs install --archive /absolute/path/to/archive` 和 `node scripts/studio.mjs start`。可用 `--data-dir` 指定目录。修改前备份账号和配置；该定制版本与上游 v0.2.13 使用相同的数据格式。
