# Repository Agent Guide (`magpie-gemini-web`)

Keep this file compact and link-checked: every path reference is validated by `scripts/check-guardrails.mjs` (`npm run check`).

## 1. Core Architecture & Invariants

- **Zero runtime or dev npm dependencies**: `package.json` keeps empty dependencies so `npm test`, `npm run check`, and published plugin installs run directly on bare `Node >= 22` and `Bun`. Use `node:*` built-ins only (`bun:sqlite` is gated on `globalThis.Bun` in `lib/usage.mjs`).
- **Strict module layering**: `lib/` never imports `index.mjs`, `scripts/`, or `test/`; `index.mjs` never imports `scripts/` or `test/`. Keep `package.json` `files` closure self-contained (`closed-package-files-graph`).
- **Process liveness & containers**: Never probe raw `process.kill(pid, 0)` directly outside `lib/proc.mjs`; use `processAlive`, `processExists`, and `zombie` in `lib/proc.mjs` so Linux `Z`/`X` zombie processes and OS PID reuse are rejected safely. Container loopback proxy warnings live in `lib/proc.mjs` (`isContainerEnv`, `dockerProxyHint`).
- **Cross-host lock & auto-update safety**: `lib/studio-updates.mjs` (`acquireStudioUse`, `beginMaintenance`, `holdStudioResponse`, `updateStudioAutomatically`) coordinates concurrent plugin hosts via unique per-claim files, `{ pid, started, token }` ownership fingerprints, write-then-recheck fencing, and content-checked stale unlink. Formal model: `docs/models/studio-lock-protocol.tla` and `docs/models/studio-lock-statechart.md`.
- **Unix LF everywhere**: Keep `.mjs`, `.cjs`, `.js`, `.yml`, `.tla`, and `.md` files with `\n` endings (`jsconfig.json` enables IDE navigation without TypeScript compile steps).

## 2. Subsystem -> Verification Map

| Subsystem | Primary Code | Verification Target |
| :--- | :--- | :--- |
| Static guardrails & IDE links | `scripts/check-guardrails.mjs`, `jsconfig.json` | `test/guardrails.test.mjs` (`npm run check`) |
| Process liveness & Docker proxy hints | `lib/proc.mjs` | `test/zombie.test.mjs`, `test/studio-docker.test.mjs`, `test/backend.test.mjs` |
| Studio cross-host lock & updater | `lib/studio-updates.mjs`, `docs/models/studio-lock-protocol.tla` | `test/studio-updates.test.mjs`, `test/studio-update-outcomes.test.mjs`, `test/studio-lock-model.test.mjs` |
| Studio lifecycle & native install | `lib/studio-native.mjs`, `index.mjs`, `lib/studio-upstream.mjs` | `test/studio-native.test.mjs`, `test/studio-official.test.mjs`, `test/studio-pins.test.mjs` |
| Magpie plugin HTTP / Bun runtime | `index.mjs`, `lib/usage.mjs` | `test/studio-connect.test.mjs`, `test/studio-connect-legacy.test.mjs` (Node & `bun test`) |
| Standalone backend & cleanup | `lib/cleanup.mjs`, `lib/cleanup-detached.cjs` | `test/cleanup.test.mjs`, `test/backend.test.mjs`, `test/backend-release.test.mjs` |
| Release & npm propagation | `scripts/verify-published-package.mjs`, `scripts/release-plugin.mjs` | `test/release-plugin.test.mjs`, `.github/workflows/verify-package.yml` |
| Diff interrogation & CI | `scripts/interrogate-diff.mjs` | `test/interrogate-diff.test.mjs`, `.github/workflows/test.yml`, `.github/workflows/studio-upstream-watch.yml` |

## 3. Rule <-> Enforcer Matrix

| Invariant / Hazard | Local & CI Enforcer |
| :--- | :--- |
| No raw kill-zero probes, layer crossings, bare npm imports, CRLF shebangs, or dangling `AGENTS.md` paths | `scripts/check-guardrails.mjs` (via `npm run check` and `.github/workflows/test.yml`) |
| Lock protocol mutual exclusion, single maintenance, live-owner safety, crash/zombie/PID-reuse recovery | `test/studio-lock-model.test.mjs` (BFS model checker + mutation proofs + property tests) |
| Published npm `latest` CDN dist-tag propagation & clean pack verification | `scripts/verify-published-package.mjs`, `.github/workflows/verify-package.yml` |
| Pre-publish cleanliness, backend asset reachability, and converged tag/workflow release | `scripts/release-plugin.mjs` (`npm run release:plugin -- --dry-run`) |
| Daily upstream `Mag1cFall/AIStudio2API` breakage detection & auto-closed tracking issue | `.github/workflows/studio-upstream-watch.yml` -> `.github/workflows/studio-official.yml` |

## 4. `Author != Verifier` Interrogation Playbook

1. Inspect the touched subsystems and hazard sites before claiming completion:
   ```bash
   npm run interrogate -- --brief
   ```
2. Hand the generated brief plus raw diff to an independent read-only verifier (separate context from the author) to challenge child-process quoting, liveness edge cases, lock races, Windows/Linux differences, and workflow permissions.
3. Run all mapped checks automatically plus pack dry-run:
   ```bash
   npm run interrogate -- --run
   ```

## 5. `/correct` Workflow (Prevent Repeat Mistakes)

- **Encode fixes mechanically**: Every agent error or bug fix should add a rule in `scripts/check-guardrails.mjs` (if syntactically checkable) or a deterministic regression / model check in `test/*.test.mjs`.
- **Keep docs lean**: Add only short high-signal pointers here; put active release instructions in `docs/studio-release.md` and `docs/backend-release.md`, and move superseded managed-build release logs into `docs/history/studio-managed-history.md`.
