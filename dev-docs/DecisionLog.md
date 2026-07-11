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

4. The echo guard is SEMANTIC, not origin-based (completion, 2026-07-11):
   `InstanceStore.append` returns `appended | duplicate` and the instance
   folds/fans only when something actually landed, so the subscribe path now
   admits own-origin ops — a genuine wire echo dedups to a no-op, genuine
   catch-up (an own-origin replay arriving AFTER the mount, memory engine)
   folds like anyone's ops and own state reappears LIVE, no remount.

Residual, noted not fixed in glial: two tabs sharing one profile's stable
origin can fork concurrently — origin allocation is the app's identity
policy, not glial's. RULED for the demo (Gianni, 2026-07-11): per-tab origins
(sessionStorage-scoped identity; each tab a distinct participant is the
product intent); per-profile identity + a write-serializing store is
explicitly NOT the demo's model.

## GAP-11 — offline outbox: locally-minted ops never ship on a later attach (recorded, not fixed)

`write()` without connectivity mints via `mintLocal` (origin = the binder's
local origin, 1-based seq, `prev: null`, no wire address) and persists
locally — but nothing re-ships those ops when `attachGlade` later lights
connectivity, and their chain scheme is not the session's (no prev hash), so
they cannot simply ride `hydrate`. OUT OF GAP-9's SCOPE by ruling
(2026-07-11). A fix needs an outbox: mark stored ops unsent, re-mint them
through the session at attach (fresh seq/prev under the session chain), then
ship — with the lww/lamport consequences thought through. Until then an
offline-first write is local-only durable, never replicated.

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

---

Spec-gap calls made building the **supplier kit** (GLP-0006 P0.S4) —
`src/supplier/index.ts` (`@owebeeone/glial-runtime/supplier`). These resolve
under-specified points in `plan-docs/plans/GLP-0006-.../SupplierRequirements.md`
+ `dev-docs/glade/GladeSupplierModel.md` §2 (the RULED attachment contract).

## GAP-12 — the supplier session is a STRUCTURAL seam; the two shape mechanisms stay distinct

The kit "attaches over a GladeClient", but binding to the concrete client-ts
class would couple the kernel-adjacent module to a carrier. **Decision:** a
structural `SupplierSession` interface (mirrors the kernel's `SessionLike` /
`OpBus` seams) captures exactly the provider-side surface — `subscribe`,
`onExchangeReq` / `respondExchange`, `append` / `onOps`, optional `hello`,
optional `onDrop`. A `GladeClient` is the intended satisfier; tests use a fake
that models the node. Grip-free (imports glade-decl types + `../bytes.ts` only),
so the kernel stays dependency-clean and there is no new wire.

The `GladeSupplierModel.md` §2 shape distinction is encoded as TWO methods, not
one attach act (mid-flight design correction, 2026-07-12):
- **`serveExchange`** — a Subscribe on a declared exchange id registers the
  session as THE provider in the node's `providers` map (`attach_provider`); the
  handler answers each `ExchangeReq` with `corr` preserved, a thrown/rejected
  handler → `ok:false` data. This IS an attach ceremony.
- **`serveShare`** — value/log serving is OP-PUBLISHING, not an attach: the
  ServeClaim / authority lives with the NODE (F1, node-side), any session may
  append in stage-1, and "serving" is the `set`/`append` ops the source
  publishes. The subscribe here only RECEIVES the surface's inbound ops so the
  source can fold them. Framed and doc-commented as such throughout.

## GAP-13 — reattach-on-drop is backoff over an injectable clock; attribution is best-effort

`onDrop` is optional on the seam (some carriers cannot signal a drop). **When
present**, a drop re-Hellos + re-Subscribes every serving with exponential
backoff (`initialMs`·`factor^attempt`, capped at `maxMs`; a clean attach resets
the attempt, consecutive subscribe failures escalate); the `schedule` is
injectable so tests drive the clock without real timers. **When absent**,
reattach is inert and the caller re-`serve*`s. `detachAll` cancels a pending
reattach and unsubscribes the drop signal. Attribution (`hello(principal)`) is
called ONCE per connection and is best-effort — a hello failure is swallowed
(stage-1: identity as data, nothing enforced, §4). **Integration points noted
for the parallel glade work** (client-ts today): inbound `ExchangeReq` (tag 6)
is decoded but dropped — needs surfacing via `onExchangeReq`; there is no
`respondExchange`; `onOps` is a single settable field — a multi-surface client
needs it as a fan-out; `Hello(principal)` is being added in parallel and is
called defensively (`client.hello?.(principal)`). No glade-node binary was
spawned in tests: the glade repo is under parallel modification, and the
in-process client-ts Session already exercises the real fold/store/chain for the
share path (GAP-4's established fallback).

---

Spec-gap calls made building the **typed manifest** (GLP-0006 P0.S5a) —
`src/manifest.ts` (`@owebeeone/glial-runtime/manifest`).

## GAP-14 — the compile wall is a frozen typed-key map; `Surface` extends `BindingDecl`

The ask: glade ids referenced via typed identifiers, undefined = TS build error.
**Decision:** `defineManifest<T extends Record<string, SurfaceSpec>>(specs)`
returns `Manifest<T> = { readonly [K in keyof T]: Surface<T[K]["shape"]> }` — the
key set is EXACT, so `M.<undefined>` is a compile error by construction (proven
by `@ts-expect-error` tests the `tsc --noEmit` gate validates). Per-surface
`Shape` literals survive inference (verified: `M.gwzOps.shape` is `"exchange"`,
not the widened `Shape`), which keeps shape-safe serving available later.

`Surface<S extends Shape>` **extends `BindingDecl`** (narrowing `shape` to `S`)
and adds the wire `share` + zone `key`. Consequence: a `Surface` IS a
`BindingDecl` structurally, so `binder.mount`, the grip adapter's
`GlialTapConfig.decl`, and the supplier's `SupplierSurface` accept `M.notes` with
NO kernel change — pure structural compatibility, no cross-module import, kernel
stays clean. Raw `BindingDecl`s remain accepted for back-compat (doc-noted as the
lower-level form on those APIs). The handle + its `glade_id` are `Object.freeze`d.

**GQ-6 NOT implemented (seam left):** the id is EXPLICIT on `SurfaceSpec.id`
today; `GladeDeclSurface.md`'s `derive_glade_id(package_id, grip_key)` +
pinned-manifest derivation slots in behind that field later with zero consumer
churn (they reference the handle, never the string). The hash is deliberately
not built here.
