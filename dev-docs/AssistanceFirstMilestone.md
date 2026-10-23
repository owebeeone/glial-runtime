# Optional assistance integration, first local milestone

The `/assistance`, `/assistance/glade` and `/assistance/mcp` subpaths are integration
code, not kernel exports. The supplier consumes a synchronous read projection,
asynchronous mutation-free preparation and a synchronous normal application
commit. Composition injects clock, token generation and UI change notification.
The structural Client port is satisfied by current Glade client-ts; concrete
readiness and routing were tested with the real node. No GRIP dependency is added.

The operator-authorized bounded scope and preceding source/real-node evidence are
in `garns-wz/garns-dw/dev-docs/SessionAssistanceFirstMilestone-Phase1.md`.
The additive `@owebeeone/glade-decl/assistance` data module is generated from
Glade Decl's Taut source. This is local development, not a published dependency
release. The published-dependency release gate remains blocked until that module
is separately released/versioned and the dependent version is reviewed.

Supplier access defaults off. Readiness alone permits no read or mutation.
Enable makes offers possible; explicit accept binds one consumer/token/epoch to
the exact application/workspace/supplier/generation. Eligibility is copied when
the supplier is constructed. Changing eligibility requires ending this supplier
and constructing a fresh generation with fresh consent. Preparation must not
mutate and commit must not return asynchronous work. The integration revalidates
permission, deadline and expected revision/sequence immediately before commit.
Product handlers remain responsible for schema/choice validation and persistence.

Use a dedicated assistance client: `binding.close()` invalidates grants before
teardown and closes that client. Never pass the ordinary synchronization client.
Drop does not reattach or restore consent. Supplier handles a maximum of 128
offers, retaining ended reasons until disposal; reaching capacity requires a new
generation. MCP bounds advertisements and pairing records to 128 each.

Existing Glade exchange correlation, response and failure behavior is reused.
No action ID, deduplication, replay, receipt store or retry/recovery protocol is
added. Application failure after possible commit and transport failure are
unknown. One unresolved mutation blocks further mutations until explicit manual
abandonment/end. A normal fresh read is available for manual inspection; it does
not establish cancellation or exactly-once execution. Presentation is never
claimed by an `applied` result. Underlying Glade exchange-waiter and directory-log
retention are existing limits, not production sustained-use acceptance.

Only tool-based discovery/pair/read/action/end is advertised. Graphs, continuous
resources/subscriptions, generic writes/settings, dynamic route provisioning,
actual connector installation and full probe replacement remain later work.
The fixture provisions distinct shares because provider routing uses share +
service ID, not a key. Production provisioning is not inferred from this test.

Fast deterministic checks: `pnpm exec vitest run test/assistance.test.ts test/assistanceTransport.test.ts`
(ten tests, 0.888 s including transform on this Windows run), then
`pnpm typecheck` and `pnpm build`. `pnpm test` passed all 166 tests before the
additional capability-widening and consumer-disconnect regressions; the changed
focused suite passed after those corrections. No architecture allowlist was relaxed.
