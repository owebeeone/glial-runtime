# Glial Log Corpus Applicability

Status: normative Glial adapter boundary for `log.oracle/v0`

Date: 2026-08-22

Machine-readable gate: `log-corpus-applicability.v0.json`

## Decision

Glial's `LogBuffer` is a replicated-op **assembly seam**, not a second portable
log node. It MUST assign stable materialized sequence numbers, select records
after an exclusive cursor, honor immediate batch bounds, and make forward
progress. The six corpus vectors that exercise only those behaviors MUST run
byte-for-byte through `LogBuffer` in `test/oracle.test.ts`.

The portable `taut-shape` log node owns reader mailboxes, held-read timers,
supersession, terminal lifecycle, retention floors, cursor-expiry protocol
outcomes, reader teardown, and producer-stop policy. Glial's binder does not
expose or emulate those node operations, so the 19 vectors whose observations
require them MUST remain gated by each language's canonical node engine rather
than be copied into the assembly fold.

This is an ownership boundary, not a coverage waiver. The applicability test
MUST fail when:

- the canonical corpus adds, removes, or renames a vector without an adjacent
  classification update;
- a vector is classified more than once;
- the manifest names a different corpus version; or
- an applicable vector stops reproducing the canonical expected transcript.

## Classification summary

| Owner | Vectors | Count |
| --- | --- | ---: |
| Glial `LogBuffer` assembly | `push_then_read_data`, `read_empty_probe`, `resume_no_dup_no_skip`, `batch_bounds`, `forward_progress`, `two_streams_two_positions` | 6 |
| Portable `taut-shape` log node | holds/timers (4), terminal lifecycle (5), eviction/cursor expiry (3), multi-reader wake-up (1), stream teardown/producer stop (4), post-terminal diagnostics (2) | 19 |

The adjacent JSON records the precise owner and reason for every named vector.
It is the source consumed by the test; this prose is the human-facing rationale.

## Integration consequence

Consumers that use `GlialTap` for a log receive a whole assembled record list on
refresh/delta. They MUST NOT infer portable held-read, timeout, EOF, expired,
or producer-stop behavior from that projection. A consumer needing those
observations MUST cross a canonical `taut-shape` node adapter (as the existing
atom and stream consumers do) and retain its corpus-defined states.
