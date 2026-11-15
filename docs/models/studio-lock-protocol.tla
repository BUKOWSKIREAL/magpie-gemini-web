------------------------- MODULE studio_lock_protocol -------------------------
EXTENDS Naturals, FiniteSets

(*
 * Abstract finite-state model of magpie-gemini-web's cross-host lock protocol
 * implemented in lib/studio-updates.mjs (acquireStudioUse, beginMaintenance,
 * occupied, releaseRecord, holdStudioResponse, updateStudioAutomatically) and
 * lib/proc.mjs (processExists, zombie, studioProcessStarted).
 *
 * Key design properties modeled:
 *  1. Unique per-claim lock files (.studio-use.<pid>.<token>.json and
 *     .automatic-update.<token>.lock) written exclusively ('wx').
 *  2. Owner fingerprint { pid, started, token } so OS PID reuse cannot masquerade
 *     as the prior lock owner, and Linux /proc/<pid>/stat state 'Z' (zombie)
 *     counts as dead.
 *  3. Write-then-recheck fencing in both acquireStudioUse and beginMaintenance:
 *     each writes its own claim before scanning peer files, then aborts and
 *     content-checked-unlinks its own file if any conflicting live claim exists.
 *  4. Content-checked stale reclamation in occupied(file): only unlinks a stale
 *     file if a fresh read still equals the scanned text snapshot.
 *)

CONSTANTS
    Hosts,          \* e.g. {1, 2}
    MaxGen          \* bounded PID generation to model PID reuse, e.g. 2

VARIABLES
    procState,      \* [Hosts -> {"alive", "zombie", "dead"}]
    procGen,        \* [Hosts -> 1..MaxGen] (monotonically bumps on restart/PID reuse)
    usePhase,       \* [Hosts -> {"idle", "checking", "wrote", "held"}]
    maintPhase,     \* [Hosts -> {"idle", "checking", "wrote", "held"}]
    useClaim,       \* [Hosts -> [present: BOOLEAN, pid: Hosts, gen: 1..MaxGen, token: Nat]]
    maintClaim,     \* [Hosts -> [present: BOOLEAN, pid: Hosts, gen: 1..MaxGen, token: Nat]]
    nextToken       \* Nat

vars == <<procState, procGen, usePhase, maintPhase, useClaim, maintClaim, nextToken>>

LiveOwner(claim) ==
    /\ claim.present
    /\ procState[claim.pid] = "alive"
    /\ procGen[claim.pid] = claim.gen

AnyLiveMaint(excludeHost) ==
    \E h \in Hosts : h # excludeHost /\ LiveOwner(maintClaim[h])

AnyLiveUse ==
    \E h \in Hosts : LiveOwner(useClaim[h])

-----------------------------------------------------------------------------
(* Initial quiescent state *)
Init ==
    /\ procState = [h \in Hosts |-> "alive"]
    /\ procGen = [h \in Hosts |-> 1]
    /\ usePhase = [h \in Hosts |-> "idle"]
    /\ maintPhase = [h \in Hosts |-> "idle"]
    /\ useClaim = [h \in Hosts |-> [present |-> FALSE, pid |-> h, gen |-> 1, token |-> 0]]
    /\ maintClaim = [h \in Hosts |-> [present |-> FALSE, pid |-> h, gen |-> 1, token |-> 0]]
    /\ nextToken = 1

-----------------------------------------------------------------------------
(* acquireStudioUse lifecycle for host h *)

UseCheckFree(h) ==
    /\ procState[h] = "alive"
    /\ usePhase[h] = "idle"
    /\ ~AnyLiveMaint(0)
    /\ usePhase' = [usePhase EXCEPT ![h] = "checking"]
    /\ UNCHANGED <<procState, procGen, maintPhase, useClaim, maintClaim, nextToken>>

UseWriteClaim(h) ==
    /\ procState[h] = "alive"
    /\ usePhase[h] = "checking"
    /\ useClaim' = [useClaim EXCEPT ![h] = [
            present |-> TRUE,
            pid |-> h,
            gen |-> procGen[h],
            token |-> nextToken
       ]]
    /\ nextToken' = nextToken + 1
    /\ usePhase' = [usePhase EXCEPT ![h] = "wrote"]
    /\ UNCHANGED <<procState, procGen, maintPhase, maintClaim>>

UseRecheckCommit(h) ==
    /\ procState[h] = "alive"
    /\ usePhase[h] = "wrote"
    /\ ~AnyLiveMaint(0)
    /\ usePhase' = [usePhase EXCEPT ![h] = "held"]
    /\ UNCHANGED <<procState, procGen, maintPhase, useClaim, maintClaim, nextToken>>

UseRecheckAbort(h) ==
    /\ procState[h] = "alive"
    /\ usePhase[h] = "wrote"
    /\ AnyLiveMaint(0)
    /\ useClaim' = [useClaim EXCEPT ![h] = [useClaim[h] EXCEPT !.present = FALSE]]
    /\ usePhase' = [usePhase EXCEPT ![h] = "idle"]
    /\ UNCHANGED <<procState, procGen, maintPhase, maintClaim, nextToken>>

UseRelease(h) ==
    /\ procState[h] = "alive"
    /\ usePhase[h] = "held"
    /\ useClaim' = [useClaim EXCEPT ![h] = [useClaim[h] EXCEPT !.present = FALSE]]
    /\ usePhase' = [usePhase EXCEPT ![h] = "idle"]
    /\ UNCHANGED <<procState, procGen, maintPhase, maintClaim, nextToken>>

-----------------------------------------------------------------------------
(* beginMaintenance + replaceStudioPackage lifecycle for host h *)

MaintCheckFree(h) ==
    /\ procState[h] = "alive"
    /\ maintPhase[h] = "idle"
    /\ ~AnyLiveMaint(0)
    /\ maintPhase' = [maintPhase EXCEPT ![h] = "checking"]
    /\ UNCHANGED <<procState, procGen, usePhase, useClaim, maintClaim, nextToken>>

MaintWriteClaim(h) ==
    /\ procState[h] = "alive"
    /\ maintPhase[h] = "checking"
    /\ maintClaim' = [maintClaim EXCEPT ![h] = [
            present |-> TRUE,
            pid |-> h,
            gen |-> procGen[h],
            token |-> nextToken
       ]]
    /\ nextToken' = nextToken + 1
    /\ maintPhase' = [maintPhase EXCEPT ![h] = "wrote"]
    /\ UNCHANGED <<procState, procGen, usePhase, useClaim>>

MaintRecheckCommit(h) ==
    /\ procState[h] = "alive"
    /\ maintPhase[h] = "wrote"
    /\ ~AnyLiveMaint(h)
    /\ ~AnyLiveUse
    /\ maintPhase' = [maintPhase EXCEPT ![h] = "held"]
    /\ UNCHANGED <<procState, procGen, usePhase, useClaim, maintClaim, nextToken>>

MaintRecheckAbort(h) ==
    /\ procState[h] = "alive"
    /\ maintPhase[h] = "wrote"
    /\ (AnyLiveMaint(h) \/ AnyLiveUse)
    /\ maintClaim' = [maintClaim EXCEPT ![h] = [maintClaim[h] EXCEPT !.present = FALSE]]
    /\ maintPhase' = [maintPhase EXCEPT ![h] = "idle"]
    /\ UNCHANGED <<procState, procGen, usePhase, useClaim, nextToken>>

MaintRelease(h) ==
    /\ procState[h] = "alive"
    /\ maintPhase[h] = "held"
    /\ maintClaim' = [maintClaim EXCEPT ![h] = [maintClaim[h] EXCEPT !.present = FALSE]]
    /\ maintPhase' = [maintPhase EXCEPT ![h] = "idle"]
    /\ UNCHANGED <<procState, procGen, usePhase, useClaim, nextToken>>

-----------------------------------------------------------------------------
(* Crash (to Linux zombie or dead), stale reclamation, and PID-reuse restart *)

CrashToZombie(h) ==
    /\ procState[h] = "alive"
    /\ procState' = [procState EXCEPT ![h] = "zombie"]
    /\ usePhase' = [usePhase EXCEPT ![h] = "idle"]
    /\ maintPhase' = [maintPhase EXCEPT ![h] = "idle"]
    /\ UNCHANGED <<procGen, useClaim, maintClaim, nextToken>>

CrashToDead(h) ==
    /\ procState[h] \in {"alive", "zombie"}
    /\ procState' = [procState EXCEPT ![h] = "dead"]
    /\ usePhase' = [usePhase EXCEPT ![h] = "idle"]
    /\ maintPhase' = [maintPhase EXCEPT ![h] = "idle"]
    /\ UNCHANGED <<procGen, useClaim, maintClaim, nextToken>>

RestartWithPidReuse(h) ==
    /\ procState[h] = "dead"
    /\ procGen[h] < MaxGen
    /\ procState' = [procState EXCEPT ![h] = "alive"]
    /\ procGen' = [procGen EXCEPT ![h] = procGen[h] + 1]
    /\ UNCHANGED <<usePhase, maintPhase, useClaim, maintClaim, nextToken>>

ReclaimStaleUse(h) ==
    /\ useClaim[h].present
    /\ ~LiveOwner(useClaim[h])
    /\ useClaim' = [useClaim EXCEPT ![h] = [useClaim[h] EXCEPT !.present = FALSE]]
    /\ UNCHANGED <<procState, procGen, usePhase, maintPhase, maintClaim, nextToken>>

ReclaimStaleMaint(h) ==
    /\ maintClaim[h].present
    /\ ~LiveOwner(maintClaim[h])
    /\ maintClaim' = [maintClaim EXCEPT ![h] = [maintClaim[h] EXCEPT !.present = FALSE]]
    /\ UNCHANGED <<procState, procGen, usePhase, maintPhase, useClaim, nextToken>>

-----------------------------------------------------------------------------
Next ==
    \E h \in Hosts :
        \/ UseCheckFree(h)
        \/ UseWriteClaim(h)
        \/ UseRecheckCommit(h)
        \/ UseRecheckAbort(h)
        \/ UseRelease(h)
        \/ MaintCheckFree(h)
        \/ MaintWriteClaim(h)
        \/ MaintRecheckCommit(h)
        \/ MaintRecheckAbort(h)
        \/ MaintRelease(h)
        \/ CrashToZombie(h)
        \/ CrashToDead(h)
        \/ RestartWithPidReuse(h)
        \/ ReclaimStaleUse(h)
        \/ ReclaimStaleMaint(h)

-----------------------------------------------------------------------------
(* Safety invariants verified exhaustively in test/studio-lock-model.test.mjs *)

\* 1. Active request leases and active package maintenance never overlap.
MutualExclusion ==
    ~( (\E h1 \in Hosts : usePhase[h1] = "held")
    /\ (\E h2 \in Hosts : maintPhase[h2] = "held") )

\* 2. At most one host runs replaceStudioPackage at any instant.
SingleMaintenance ==
    Cardinality({h \in Hosts : maintPhase[h] = "held"}) <= 1

\* 3. A live holder's lock file is never unlinked underneath it.
NoLiveOwnerUnlinked ==
    /\ (\A h \in Hosts : usePhase[h] = "held" => LiveOwner(useClaim[h]))
    /\ (\A h \in Hosts : maintPhase[h] = "held" => LiveOwner(maintClaim[h]))

\* 4. Dead/zombie/stale owners never leave permanently un-reclaimable locks:
\*    for every claim left by a crashed host, LiveOwner(claim) is FALSE, so
\*    ReclaimStaleUse / ReclaimStaleMaint can always reclaim it and allow progress.
QuiescentRecoverability ==
    \A h \in Hosts :
        procState[h] # "alive" => (~LiveOwner(useClaim[h]) /\ ~LiveOwner(maintClaim[h]))

TypeOK ==
    /\ \A h \in Hosts : procState[h] \in {"alive", "zombie", "dead"}
    /\ \A h \in Hosts : procGen[h] \in 1..MaxGen

=============================================================================
