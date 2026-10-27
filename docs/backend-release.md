# Backend releases

The plugin's default backend is built from the upstream commit and toolchain recorded in `lib/backend-release.json`, with `patches/argon.patch` applied. The builder overrides the backend's displayed version with the release version. Six binaries are pinned by SHA-256 in the same JSON file. The build does not include the developer's uncommitted backend sources, local data or credentials.

For a new backend release:

1. Choose a new backend version and tag in `lib/backend-release.json`. Never replace files under an already published backend tag: older plugins pin those hashes. Update the upstream commit or patch when needed.
2. Run `node scripts/backend-release.mjs --write-pins`. It extracts a clean upstream tree, applies the patch, runs Go tests, cross-compiles all six targets and writes the resulting pins. It uses a local `backend-source` Git object database if available; otherwise it fetches the pinned public commit in a temporary directory.
3. Run `npm test` and `node scripts/backend-smoke.mjs`. The smoke test uses a temporary data directory, checks the actual executable's version and hash, starts it on a spare loopback port, checks authentication and model discovery, and verifies reuse. It uses no Google account and takes the tokenizer's offline fallback.
4. Commit the release metadata, installer changes, tests and documentation. Run the **Verify backend release** GitHub Actions workflow at that commit. It rebuilds on native macOS, Linux and Windows runners for both architectures, compares the pinned hashes, and runs the installation/startup smoke test. Wait for all jobs to pass.
5. Create a private draft under the pinned backend tag. Attach all six binaries, `SHA256SUMS.txt`, `build.json`, the patched source archive and `LICENSE-UPSTREAM` from `backend-build/release`. If local binary uploads are unreliable, run **Upload verified backend release** with the successful verification run ID: it downloads the six CI artifacts, checks every committed hash, and uploads missing executables to the draft. Existing assets must match exactly; published releases cannot be modified by this workflow. Include the upstream commit and patch SHA-256 in the release notes, then publish the complete draft. Keep backend-only releases from replacing the plugin release as GitHub's latest release.
6. Verify public asset downloads against the committed pins. Run `node scripts/backend-smoke.mjs --download` to test the actual default download URL on the host platform.
7. Bump and publish the plugin package only after the backend assets are publicly available. Inspect `npm pack --dry-run`; the npm package contains release metadata and patch/build scripts, but no executables, local databases or credentials. Attach the exact published npm tarball to the plugin's GitHub release as well.

Reproduce a release without changing its pins:

```bash
npm run backend:release:build
```

Build just the host target and compare its hash:

```bash
node scripts/backend-release.mjs --target=host --verify
```

The metadata records `CGO_ENABLED=0`, the exact Go toolchain, upstream commit, patch hash and build flags. The binary hashes are reproducible; the source archive is supplied for inspection and is not promised to have a reproducible gzip timestamp. The source archive includes upstream's license, and `LICENSE-UPSTREAM` is also supplied as a separate asset.

Existing running processes are left alone to avoid interrupting requests. Once an old official backend is stopped, automatic startup installs the optimized build while preserving configuration, secrets and the database. A download or checksum failure keeps the old file and never starts an unverified replacement.

New cookie imports require the running backend to advertise `capabilities.account_proxy_binding: true` at `/`. The plugin checks this before changing the proxy pool and again before submitting a cookie, so a reused older or upstream backend cannot silently ignore `proxy_id`. Unsupported builds receive instructions to stop the old process and run the installed plugin's CLI with `install --data-dir=<path>`. This explicitly selects the optimized channel, including for previous upstream or custom-build installations. The check does not interrupt existing conversations. Release smoke verifies the capability and actual proxy selection; version strings alone do not establish support.

An explicit `npm run backend:install:upstream` installs the pinned upstream v4.26.0 and persists `upstream` in `backend-channel.json`. Automatic startup respects that choice. `npm run backend:install` returns to the optimized channel. Stop a running backend before replacing it, particularly on Windows. Explicit local Argon builds remain trusted through their existing build manifest.
