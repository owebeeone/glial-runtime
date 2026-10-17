# Glial — the client-side kernel

The npm package is `@owebeeone/glial`; its source repository remains
`owebeeone/glial-runtime`. The separate `owebeeone/glial` repository is the
historical development workspace and is not part of this release.

The first runtime release is `0.1.0`. Install `@owebeeone/glial@^0.1.0`
alongside `@owebeeone/grip-core@^0.3.0`. The earlier
`0.0.0-bootstrap.0` package contains no runtime and is not for application use.

Public entry points are `@owebeeone/glial`, `@owebeeone/glial/grip`,
`@owebeeone/glial/supplier`, and `@owebeeone/glial/manifest`. Published packages
contain ESM JavaScript and TypeScript declarations; workspace exports retain
TypeScript source. Use pnpm to pack so `publishConfig` is applied.

Run `pnpm check:release` with Node 24, pnpm 10.24.0, Git, and network access.
It validates a temporary copy against published dependencies and pinned test
fixtures, then tests all four entry points from the packed package. See
[RELEASE.md](RELEASE.md) for the release procedure.

Known limitation: offline-created operations are locally durable, but do not
automatically upload when Glade is connected later. See GAP-11 in
[DecisionLog.md](dev-docs/DecisionLog.md). Applications requiring that behavior
must account for it; this release does not implement an offline outbox.

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
released `CrdtNode` and projects `text_crdt.profile/v1`. Its editor-facing state
retains element identities and tombstones so selections survive remote deltas.
Provider
status uses a separate single-writer `atom.oracle/v1` service, and disposable
provider metrics use a bounded `stream.oracle/v1` surface whose consumer
explicitly observes loss and reconnects as a live-only late join.

Repo is `owebeeone/glial-runtime` (the bare `glial` name is glial-dev's
historical remote); the gwz member path stays `glial`.

Build order (Lane T): glade-decl swap first (compile wall proves the seam),
then binder v0 — persistence-first store-only path (s-stack-local), then
mount→session (s-stack-connect). The ggg-viz s-stack-* traces are the spec.
