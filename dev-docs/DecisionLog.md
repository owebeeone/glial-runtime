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
