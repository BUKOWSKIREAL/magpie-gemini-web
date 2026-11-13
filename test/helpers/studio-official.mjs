import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function officialArchive(root, { version = 'v0.3.7', binary = 'official executable fixture', prepare } = {}) {
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const folder = `aistudio2api-${version}-${os}-${arch}`;
  const name = `${folder}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const source = path.join(root, 'source', folder);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'), binary, { mode: 0o755 });
  prepare?.(source);
  const archive = path.join(root, name);
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:FIXTURE_SOURCE -DestinationPath $env:FIXTURE_ARCHIVE"], {
      env: { ...process.env, FIXTURE_SOURCE: source, FIXTURE_ARCHIVE: archive }, windowsHide: true
    });
  } else {
    execFileSync('tar', ['-czf', archive, '-C', path.dirname(source), folder]);
  }
  const bytes = fs.readFileSync(archive);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const url = `https://github.com/Mag1cFall/AIStudio2API/releases/download/${version}/${name}`;
  const release = { tag_name: version, prerelease: false, draft: false, assets: [{ name, digest: `sha256:${sha256}`, browser_download_url: url }] };
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith('https://api.github.com/repos/Mag1cFall/AIStudio2API/releases/')) return Response.json(release);
    if (String(url) === release.assets[0].browser_download_url) return new Response(bytes);
    throw Object.assign(new Error('offline fixture'), { code: 'ECONNREFUSED' });
  };
  return { archive, name, sha256, binary, release, bytes, requests, fetchFn };
}
