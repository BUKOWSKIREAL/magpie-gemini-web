# Studio Cross-Host Lock & Auto-Update Protocol Model

Formal specification: [studio-lock-protocol.tla](studio-lock-protocol.tla)  
Executable model checker + property tests: [studio-lock-model.test.mjs](../../test/studio-lock-model.test.mjs)

## 1. Request / Stream Lease Lifecycle (`acquireStudioUse` / `holdStudioResponse`)

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> PollWait: "hasMaintenance(dataDir) is true"
    PollWait --> Idle: "timeoutMs elapsed -> EBUSY / 503"
    PollWait --> CheckingFree: "hasMaintenance(dataDir) is false"
    Idle --> CheckingFree: "hasMaintenance(dataDir) is false"
    CheckingFree --> WroteClaim: "writeFileSync(.studio-use.<pid>.<token>.json, wx)"
    WroteClaim --> RecheckAbort: "hasMaintenance(dataDir) became true (race lost)"
    RecheckAbort --> PollWait: "releaseRecord(file, owner) & yield"
    WroteClaim --> LeaseHeld: "hasMaintenance(dataDir) still false"
    LeaseHeld --> Released: "holdStudioResponse EOF / cancel / abort"
    Released --> Idle: "releaseRecord(file, owner) unlinks matching JSON"
    WroteClaim --> StaleOnDisk: "host crashes or becomes Linux zombie (Z)"
    LeaseHeld --> StaleOnDisk: "host crashes or becomes Linux zombie (Z)"
    StaleOnDisk --> Idle: "peer occupied(file) sees dead/zombie/reused-PID -> content-checked unlink"
```

## 2. Background Auto-Update Gate & Replace Lifecycle (`updateStudioAutomatically` / `beginMaintenance` / `replaceStudioPackage`)

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> WaitingSingleFlight: "single-flight running Map already has dataDir"
    Idle --> GatedChecks: "studioAutoUpdates && !occupied && runningStudioReady"
    GatedChecks --> DisabledOrWaiting: "auto-update disabled / update running / no newer release"
    GatedChecks --> MaintCheckingFree: "newer release present"
    MaintCheckingFree --> Busy: "hasMaintenance(dataDir) is true"
    MaintCheckingFree --> MaintWroteClaim: "writeFileSync(.automatic-update.<token>.lock, wx)"
    MaintWroteClaim --> MaintRecheckAbort: "hasMaintenance(other) || hasUses(dataDir)"
    MaintRecheckAbort --> Busy: "releaseRecord(file, owner)"
    MaintWroteClaim --> MaintHeld: "no peer maintenance and no live use leases"
    MaintHeld --> DownloadingArchive: "download & sha256 verify official release"
    DownloadingArchive --> ExtractingStaging: "extract verified binary"
    ExtractingStaging --> SwappingBinary: "stop running backend & rename/copy target"
    SwappingBinary --> VerifyingRestart: "launchLockedStudio & waitReady"
    VerifyingRestart --> Updated: "health check passed -> mark auto-updated tag"
    VerifyingRestart --> RollbackPrevBinary: "restart/health failed -> restore previous binary"
    RollbackPrevBinary --> FailedRollback: "record rollback outcome"
    Updated --> Idle: "releaseRecord(.automatic-update.<token>.lock)"
    FailedRollback --> Idle: "releaseRecord(.automatic-update.<token>.lock)"
    Busy --> Idle
```

## 3. TLA+ to Runtime Code Mapping

| TLA+ Symbol | Runtime Function / File | Purpose |
| :--- | :--- | :--- |
| `LiveOwner(claim)` | `live(owner)` in `lib/studio-updates.mjs`, `processExists(pid)` + `zombie(pid)` in `lib/proc.mjs` | Rejects missing PIDs, Linux `Z` zombies, and PIDs whose `/proc/<pid>/stat` starttime no longer matches `record.started`. |
| `ReclaimStaleUse` / `ReclaimStaleMaint` | `occupied(file)` & `releaseRecord(file, owner)` in `lib/studio-updates.mjs` | Re-reads the lock file right before unlinking and only unlinks if raw file text matches the scanned snapshot or `{ pid, started, token }`. |
| `UseCheckFree` -> `UseWriteClaim` -> `UseRecheckCommit` / `UseRecheckAbort` | `acquireStudioUse(options)` in `lib/studio-updates.mjs` | Write-then-recheck fencing against concurrent `beginMaintenance`. |
| `MaintCheckFree` -> `MaintWriteClaim` -> `MaintRecheckCommit` / `MaintRecheckAbort` | `beginMaintenance(dataDir)` in `lib/studio-updates.mjs` | Unique `.automatic-update.<token>.lock` + double scan (`hasMaintenance(other) \|\| hasUses`) prevents split-brain upgrades or clobbering active requests. |
| `MaintHeld` -> `Updated` / `RollbackPrevBinary` | `withStudioUpdate` & `replaceStudioPackage` in `lib/studio-native.mjs` | Atomic package swap with backup restore on restart failure. |
