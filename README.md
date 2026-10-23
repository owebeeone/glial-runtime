# glial — the client-side kernel

Fresh build (GDL-035, ratified 2026-07-07). Design:
`glade-wz/dev-docs/glial/GlialClientRuntime.md`; seam contract in
`glade-decl` (`glade-wz/dev-docs/glade/GladeDeclSurface.md`).

What glial is: **local persistence FIRST** (glade optional, configured-in),
taut-shape-aware assembly inside glial, rich incremental change events
(consumer chooses delta vs whole-refresh against live UI state), taps as thin
declared conduits — **no direct tap→glade coupling**. `glade-decl` is the
shared leaf module both grip-core and glial import.

Taut delivery capabilities are exact and fail-closed. Durable instances use
the `value`/`log` fold path, the exact `glade.swmr.adapter/v1`, or an explicit
CRDT payload profile. SWMR snapshot/delta/reset operations replay through
released `SwmrNode`; the first CRDT mount replays Glade causal refs through
`CrdtNode` and projects `text_crdt.profile/v1`. Its editor-facing state
retains element identities and tombstones so selections survive remote deltas.

`replaceText` MUST retain individual identity-based insert/delete operations,
but MUST validate, persist and publish the completed local replacement as one
batch rather than rebuilding the projection for each character. A no-op MUST
emit no change. Synchronous echoes MUST be deduplicated. If the destination
throws partway through sending, the successfully generated prefix MUST remain
recoverable; batching does not promise an atomic network transaction. Direct
single-operation writes and remote ingest retain their validation rules.

Text mounts retain their engine and decode only new operations. Earlier sequence
bases arriving late trigger an explicit full reconstruction for compatibility.
IndexedDB stores a versioned engine/projection checkpoint and its operation
baseline in one transaction, every 256 applied operations and on orderly unmount.
Restore applies the retained tail; incompatible checkpoints fall back to the log.
This avoids historical replay, but retains history and still traverses current
elements to materialize text. An edit is not durable before its IDB transaction
commits. A blocked database upgrade reports a retryable error instead of waiting
silently for an older tab.

Development currently uses the adjacent Taut checkout for the new checkpoint
APIs; build that package first. No registry release is implied. GARNS Workbench
also links it explicitly through its workspace override.

Seeded delivery tests run with the normal suite. For an extended run use
`CRDT_FUZZ_SEEDS=400 pnpm exec vitest run test/text_crdt_fuzz.test.ts`.
Replay a failure with `CRDT_FUZZ_START=<seed> CRDT_FUZZ_SEEDS=1`.
These random schedules complement the fixed failure cases; they are not exhaustive.

Provider
status uses a separate single-writer `atom.oracle/v1` service, and disposable
provider metrics use a bounded `stream.oracle/v1` surface whose consumer
explicitly observes loss and reconnects as a live-only late join.

Repo is `owebeeone/glial-runtime` (the bare `glial` name is glial-dev's
historical remote); the gwz member path stays `glial`.

Build order (Lane T): glade-decl swap first (compile wall proves the seam),
then binder v0 — persistence-first store-only path (s-stack-local), then
mount→session (s-stack-connect). The ggg-viz s-stack-* traces are the spec.
