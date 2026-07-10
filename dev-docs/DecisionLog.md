# glial — decision log

Spec-gap calls made while building the binder v0 (Lane T step 2). Each is the
smallest reasonable resolution of an under-specified point in
`glade-wz/dev-docs/glial/GlialClientRuntime.md` + `GladeDeclSurface.md`, recorded
here so a later session can revisit. Requirement discipline per `AGENTS.md`.

## GAP-1 — log oracle gate is scoped to the append + catch-up-read subset

`taut-shape/corpus/log.v0.json` (log.oracle/v0) has **25** vectors, but glial's
`log` assembly is an **append fold**, not the full server delivery engine. Only
the **6 IMMEDIATE** vectors — `push`/`read` with `timeout_ms=0`, response state
in `{data, would_block}` — model the behavior glial's fold implements:

- `push_then_read_data`, `read_empty_probe`, `resume_no_dup_no_skip`,
  `batch_bounds` (max_records **and** max_bytes / D10), `forward_progress`,
  `two_streams_two_positions`.

The other 19 exercise held reads + timers (`set_timer`/`cancel_timer`/
`timer_expired`), `seal`/`close`/`end_stream`/`evict`, EOF/closed/failed/expired
delivery, and the `producer_stop` policy — the **log + window delivery engine**,
which is a server/session concern, not client-side assembly. **Decision:** gate
the 6; the gate test hard-fails if any out-of-scope input type reaches the log
replayer, so the scope boundary is enforced, not merely documented. The `value`
shape is gated in **full** (all 11 vectors of `value.v0.json`).

## GAP-2 — the fill model (`decl.domain` is an anchor, not a value)

`BindingDecl.domain` is a `DomainAnchor` **enum** (`account|document|deployment`)
and `zone` is a `ZoneKind`; neither carries the *concrete* document/account id.
A binding **instance** needs that concrete fill. **Decision:** glial's `Fill =
{ domain: string; zone?: string; key?: string }` supplies the concrete id(s) for
the decl's anchor at mount; instance identity is
`gladeId \x00 domain \x00 zone \x00 key`. glial never learns how grip chose the
fill — the mount/unmount seam is fill-only (idiom-agnostic, per §Boundaries).

## GAP-3 — GC-2 (backpressure / conflation) is stubbed

Per the brief, GC-2 is not designed here. `value` conflates naturally (each emit
is a whole-value refresh); `log` emits one delta per append with **no batching /
coalescing**. TODO(GC-2): conflate rapid value writes and batch rapid log deltas
before fan-out. Not attempted in v0.

## GAP-4 — the session transport is injectable; live-node integration deferred

`GladeDestination` (send local payloads, subscribe to remote ops) is the seam
between an instance and glade connectivity. The session half (B2) is tested with
(a) a **fake** destination and (b) a **real in-process `@glade/client-ts`
Session** pair exchanging ops directly — no `glade-node` binary spawned. A live
`cargo build --bin glade-node` end-to-end test is deferred: the injectable seam
makes it additive, and the in-process Session test already exercises the real
fold/store/chain code. (Matches the brief's stated fallback.)

## GAP-5 — interim opaque payload encoding for the `ChangeEvent` shell

GC-1 puts the envelope **shell** in glade-decl and leaves each shape's DELTA
payload schema in its taut-shape contract, carried **opaquely**. Those per-shape
delta schemas are not yet rendered in TS. **Decision:** for v0 the shell's
`payload: bytes` uses an interim glial encoding (value → raw value bytes; log →
a JSON `{seq, text}` list), and glial ALSO exposes decoded convenience fields
(`value` / `records` / `delta`) on its `InstanceEvent` so consumers need not
decode the interim bytes. Swap the encoding for the real taut-shape delta codecs
when they land; the envelope shape (`glade_decl.ChangeEvent`) does not change.

---

Spec-gap calls made building the **grip-side adapter** (Lane T step 3a) —
`src/grip/index.ts` (`GlialTap` / `GlialTapFactory`). These resolve
under-specified points in `GlialClientRuntime.md` §Boundaries (the mount/unmount
seam) + `tap.ts`'s share hooks.

## GAP-6 — the adapter package seam: grip-core is a peer of the `/grip` subpath only

The kernel must stay importable with no grip-core installed conceptually
(§Boundaries: glial's vocabulary is decl/fill/instance/mount, no matcher/tap
terms). **Decision:** the adapter lives at a distinct subpath —
`@owebeeone/glial-runtime/grip` (`./src/grip/index.ts`) — and is the **only**
file in the repo that imports `@owebeeone/grip-core`; the kernel exports (`.`)
import `@owebeeone/glade-decl` and nothing grip. grip-core is a **peer**
dependency of the adapter surface (a semver range, since pnpm rejects a `file:`
peer spec) with a `file:../grip-core` **dev** link so tests/typecheck resolve the
already-built `dist/`. Separation is a grep gate like v0's: no kernel `src/*`
file has an `import … grip` statement.

## GAP-7 — fill derivation is home-param data; the mount rides tap attach/detach

The seam is fill-only, but *how* a tap param becomes a fill was open.
**Decision:** a declarative `FillSpec` maps each fill part (`domain` req.,
`zone`/`key` opt.) to a literal string OR `{ param: grip }` — no callbacks (the
one function, `gladeFor`, is *connectivity* config, not fill logic). Referenced
param grips become the tap's `homeParamGrips` (a fill is instance-wide, so a
change re-derives via `produceOnParams`, mirroring FunctionTap). `{ param }`
reads the current value in the params context and `String()`s it; a not-yet-ready
param **defers** the mount until it resolves (avoids churning a wrong instance).
Per the brief, `onAttach → binder.mount` and `onDetach → unmount`, so the tap's
attach/detach lifecycle *is* the instance refcount (not per-destination connect).
A fill change unmounts the old instance and mounts the new.

## GAP-8 — the grip value projection + write seam (codec + controller)

`InstanceEvent` carries bytes; a grip carries an app value. **Decision:** a
`PayloadCodec` (bytes ↔ value/entry; **JSON** default, cf. grip-share) bridges
them, and the adapter projects glial's decoded convenience fields (GAP-5): value
shape → the decoded whole (grip default when empty); log shape → the decoded
`records` list (the whole list on both refresh and delta, so a consumer always
projects the full log — delta-vs-refresh selection against live UI state is
deferred with the text-crdt shape). Writes use an optional `handleGrip` exposing
a `GlialTapController` (`set` = value op, `append` = log op; wrong-shape use
throws), each routing `instance.write(encode(v))` through the binder — which
ships it when connectivity is configured, else persists locally.

---

Gap found LIVE in glade's GC-3 per-binding cutover (glade/dev-docs/
GladeCutoverNotes.md §RELOAD-RESUME GAP, 2026-07-10), worked around app-side
there; resolved natively in glial here, together with the real GC-4 engine.

## GAP-9 — reload-resume: own-origin ops must reach the session they were minted from

A tab reload keeps its stable origin but rebuilds the client-ts session, and
`SessionDestination`'s echo guard filtered own-origin ops out of the node
replay ENTIRELY — so (a) the fresh session restarted its chain at seq 0, a fork
the node correctly drops (observed data loss: a `selected README.md` op
vanished), and (b) with the memory engine, own prior state never reached the
assembly. The demo worked around both carrier-side. **Decision — glial owns
both halves natively; the echo guard survives for assembly only:**

1. `SessionDestination.subscribe` applies EVERY route-matched op to the session
   (`applyRemote`, own-origin included — seq/prev/lamport resume off the node
   replay; live echoes of our own publishes dedup in the session store) and
   hands only remote-origin ops to the instance fold. Own writes fold at
   `write()` time; reload-restore of own state is the persistent engine's job
   (GAP-10) — replay is not a store.
2. `attachGlade` hydrates the session from the instance's persisted ops through
   the new optional `GladeDestination.hydrate(ops)`: `SessionDestination`
   replays the wire-shaped ones (those carrying their glade address — locally
   minted offline ops never rode the wire and are skipped), per origin in seq
   order. With a persistent engine in the GC-4 slot this closes the
   OFFLINE-from-boot fork (no replay to resume from): the wholesale stored
   records ARE the chain heads, so no separate head persistence is needed.

3. A route mounted only AFTER the node replay has passed used to miss it
   (mount-before-subscribe as a wiring rule). Fixed natively: `feedSession
   (session, bus)` absorbs EVERY inbound op into the session route-agnostically
   (the carrier line the demo hand-rolled, now glial vocabulary), and `hydrate`
   is TWO-WAY — it also returns the session's route ops the instance store
   lacks (`SessionLike.dump?`), which `attachGlade` folds as backfill. A late
   mount catches up from the session store — own-origin history included
   (catch-up is not a live echo) — so mount order stops mattering.

Residual, noted not fixed: two tabs sharing one profile's stable origin can
still fork concurrently (origin allocation is the app's identity policy, not
glial's; pre-existing, recorded with the cutover), and with the MEMORY engine
an own-origin replay arriving after the mount still does not re-fold (the
live-path echo guard) — own state then appears only at the next mount; the
persistent engine (GAP-10) is the real answer there.

## GAP-10 — GC-4 persistent engine: IndexedDB behind the unchanged sync seam; drop ≠ evict

`StoreEngine.open` / `InstanceStore.append/all` are sync (a mount folds
synchronously), but IndexedDB is async. **Decision:** `IndexedDbStoreEngine.open()`
is an async FACTORY that preloads every persisted row into a per-instance
write-through memory cache; after boot the seam stays sync (`append` writes
through fire-and-forget — persistence may degrade on quota/private-mode, the
app never blocks; `flush()` awaits in-flight writes for tests/teardown). Op
records persist WHOLESALE (structured clone, key `[instanceKey, origin, seq]`,
`put` = idempotent dedup), so a session op's wire fields (share/glade_id/key/
refs/shape) survive reload and GAP-9's hydration re-validates the prev-hash
chain exactly. The `IDBFactory` is injectable (fake-indexeddb in tests, browser
`indexedDB` by default; tsconfig gains lib `DOM`).

The eviction/retention question: the binder calls `drop` at refcount 0, and a
persistent engine that deleted there would erase the user's history on every
last unmount. So `drop` is a lifecycle SIGNAL whose meaning is the engine's
retention call — memory frees; IndexedDB retains both rows and cache (a later
remount must re-open synchronously, and the complete cache is what lets
`purge` enumerate keys without DOM-only `IDBKeyRange`). Explicit deletion is
`purge(instanceKey)`. Enforcing `decl.retention` (TTL/quota) is deferred: the
engine is keyed by instanceKey and never sees the decl — wiring retention
policy across the seam is a later GC-4 slice.
