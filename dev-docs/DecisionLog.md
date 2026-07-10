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
