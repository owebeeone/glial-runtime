# glial — the client-side kernel

Fresh build (GDL-035, ratified 2026-07-07). Design:
`glade-wz/dev-docs/glial/GlialClientRuntime.md`; seam contract in
`glade-decl` (`glade-wz/dev-docs/glade/GladeDeclSurface.md`).

What glial is: **local persistence FIRST** (glade optional, configured-in),
taut-shape-aware assembly inside glial, rich incremental change events
(consumer chooses delta vs whole-refresh against live UI state), taps as thin
declared conduits — **no direct tap→glade coupling**. `glade-decl` is the
shared leaf module both grip-core and glial import.

Repo is `owebeeone/glial-runtime` (the bare `glial` name is glial-dev's
historical remote); the gwz member path stays `glial`.

Build order (Lane T): glade-decl swap first (compile wall proves the seam),
then binder v0 — persistence-first store-only path (s-stack-local), then
mount→session (s-stack-connect). The ggg-viz s-stack-* traces are the spec.
