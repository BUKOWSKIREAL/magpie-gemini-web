import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const STUDIO_UPSTREAM = 'Mag1cFall/AIStudio2API';
const API = `https://api.github.com/repos/${STUDIO_UPSTREAM}/releases`;
const TARGETS = {
  'darwin-arm64': 'darwin-arm64.tar.gz', 'darwin-x64': 'darwin-amd64.tar.gz',
  'linux-arm64': 'linux-arm64.tar.gz', 'linux-x64': 'linux-amd64.tar.gz',
  'win32-x64': 'windows-amd64.zip'
};

export function supportsOfficialStudio(platform = process.platform, arch = process.arch) {
  return Object.hasOwn(TARGETS, `${platform}-${arch}`);
}

export function unsupportedStudioMessage(platform = process.platform, arch = process.arch) {
  return `No official AIStudio2API CLI archive for ${platform}/${arch}. 自动安装支持 macOS / Linux 的 x64、arm64，以及 Windows x64。当前平台请选「指定 AIStudio2API 程序路径（高级）」使用兼容程序，或「连接已有 AIStudio2API（地址 + API key）」。Windows arm64 可选择系统能够运行的 x64 程序。`;
}

export function studioReleaseTag(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('AIStudio2API version must be a release tag such as v0.3.7');
  const tag = value.startsWith('v') ? value : `v${value}`;
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(tag)) {
    throw new Error('AIStudio2API version must be a release tag such as v0.3.7');
  }
  return tag;
}

// Validate metadata as well as the downloaded bytes. A release cannot redirect installation
// to another repository, a different archive format or an asset without a GitHub SHA-256 digest.
export function officialStudioAsset(release, { platform = process.platform, arch = process.arch, version } = {}) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(unsupportedStudioMessage(platform, arch));
  const requested = studioReleaseTag(version);
  const tag = studioReleaseTag(release?.tag_name);
  if (!tag || release.draft || (!requested && release.prerelease) || (requested && requested !== tag)) {
    throw new Error('GitHub returned an unexpected AIStudio2API release');
  }
  const name = `aistudio2api-${tag}-${target}`;
  const matches = Array.isArray(release.assets) ? release.assets.filter(a => a?.name === name) : [];
  if (matches.length !== 1) throw new Error(`Official AIStudio2API ${tag} has no unique CLI archive ${name}`);
  const asset = matches[0];
  const url = `https://github.com/${STUDIO_UPSTREAM}/releases/download/${tag}/${name}`;
  if (asset.browser_download_url !== url) throw new Error('Unexpected official AIStudio2API asset URL');
  if (!/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest || '')) {
    throw new Error(`GitHub does not provide a SHA-256 digest for ${name}; download and select an executable manually instead`);
  }
  return { version: tag, asset: name, sha256: asset.digest.slice(7).toLowerCase(), url, repository: STUDIO_UPSTREAM };
}

export async function resolveStudioRelease(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!supportsOfficialStudio(platform, arch)) throw new Error(unsupportedStudioMessage(platform, arch));
  const version = studioReleaseTag(options.version);
  const url = version ? `${API}/tags/${encodeURIComponent(version)}` : `${API}/latest`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'magpie-gemini-web' };
  let release;
  try {
    if (options.fetchFn && options.fetchFn !== globalThis.fetch) {
      const response = await options.fetchFn(url, { headers, redirect: 'error', signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      release = await response.json();
    } else {
      const args = ['--fail', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '15', '--max-time', '45'];
      for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`);
      if (options.proxy) args.push('--proxy', options.proxy);
      args.push(url);
      const { stdout } = await execFileAsync('curl', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 50000, windowsHide: true });
      release = JSON.parse(stdout);
    }
  } catch (err) {
    // execFile errors include argv, which can contain a proxy password.
    const httpStatus = /returned error: (\d{3})/.exec(String(err.stderr || ''))?.[1];
    const reason = httpStatus ? `GitHub HTTP ${httpStatus}` : typeof err.code === 'number' ? `curl exit ${err.code}` : err.code || err.message;
    throw new Error(`Could not read official AIStudio2API releases (${reason}). Check the network or studio.proxy / AI_STUDIO_PROXY, then retry. Existing files were kept.`);
  }
  return officialStudioAsset(release, { platform, arch, version });
}
