// The corpus-conformance gate — glial's folds must reproduce taut-shape's
// behavioral oracle byte-for-byte (the Lane C consolidation paying off: folds
// are corpus-conformant, not hand-trusted).
//
//  · value: all 11 vectors of corpus/value.v0.json (value.oracle/v0).
//  · log:   the 6 IMMEDIATE append + catch-up-read vectors of corpus/log.v0.json
//           (log.oracle/v0). The remaining 19 exercise the held-read/timer/
//           seal/close/evict/producer-stop delivery engine — out of scope for
//           binder v0's append fold (dev-docs/DecisionLog.md GAP-1).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ValueRegister } from "../src/folds/value.ts";
import { LogBuffer } from "../src/folds/log.ts";
import { b64ToBytes, bytesToB64 } from "../src/bytes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "..", "..", "taut-shape", "corpus");
const load = (f: string) => JSON.parse(readFileSync(join(corpusDir, f), "utf8"));

type Msg = Record<string, unknown>;
interface Step { in: Msg; out: Msg[]; }
interface Vector { name: string; steps: Step[]; }

// ---- value ----------------------------------------------------------------

function replayValue(steps: Step[]): Msg[][] {
  const reg = new ValueRegister();
  return steps.map((step) => {
    const m = step.in;
    if (m.type === "set") {
      const outcome = reg.set({
        origin: m.origin as string,
        seq: Number(m.seq),
        lamport: Number(m.lamport),
        prev: m.prev != null ? b64ToBytes(m.prev as string) : null,
        payload: b64ToBytes(m.payload as string),
      });
      return outcome === "equivocation"
        ? [{ code: "equivocation", severity: "error", type: "diagnostic" }]
        : [];
    }
    if (m.type === "read") {
      const s = reg.read();
      const rr: Msg =
        s.state === "empty"
          ? { state: "empty", stream_id: m.stream_id, type: "read_response", value: null, value_id: m.value_id, winner: null }
          : {
              state: "data",
              stream_id: m.stream_id,
              type: "read_response",
              value: bytesToB64(s.value),
              value_id: m.value_id,
              winner: { lamport: String(s.winner.lamport), origin: s.winner.origin, seq: String(s.winner.seq) },
            };
      return [rr];
    }
    throw new Error(`unknown value input ${String(m.type)}`);
  });
}

describe("value fold — corpus conformance (value.oracle/v0)", () => {
  const corpus = load("value.v0.json");
  it("declares the pinned oracle version", () => {
    expect(corpus.version).toBe("value.oracle/v0");
    expect(corpus.vectors.length).toBe(11);
  });
  for (const v of corpus.vectors as Vector[]) {
    it(`reproduces «${v.name}»`, () => {
      const got = replayValue(v.steps);
      expect(got).toEqual(v.steps.map((s) => s.out));
    });
  }
});

// ---- log ------------------------------------------------------------------

// The append + immediate catch-up-read subset (timeout_ms=0): push/read only,
// read_response state in {data, would_block}. See GAP-1.
const LOG_SUBSET = new Set([
  "push_then_read_data",
  "read_empty_probe",
  "resume_no_dup_no_skip",
  "batch_bounds",
  "forward_progress",
  "two_streams_two_positions",
]);

function replayLog(steps: Step[]): Msg[][] {
  const buf = new LogBuffer();
  return steps.map((step) => {
    const m = step.in;
    if (m.type === "push") {
      buf.push(b64ToBytes(m.payload as string));
      return [];
    }
    if (m.type === "read") {
      const cur = (m.cursor as Msg).seq as string;
      const res = buf.read({
        cursorSeq: Number(cur),
        maxRecords: m.max_records != null ? Number(m.max_records) : null,
        maxBytes: m.max_bytes != null ? Number(m.max_bytes) : null,
      });
      return [
        {
          error: null,
          log_id: m.log_id,
          next_cursor: { seq: String(res.nextCursorSeq) },
          records: res.records.map((r) => ({ payload: bytesToB64(r.payload), seq: String(r.seq) })),
          state: res.state,
          stream_id: m.stream_id,
          type: "read_response",
        },
      ];
    }
    throw new Error(`log input ${String(m.type)} is out of binder-v0 scope (GAP-1)`);
  });
}

describe("log fold — corpus conformance (append + catch-up subset)", () => {
  const corpus = load("log.v0.json");
  it("declares the pinned oracle version", () => {
    expect(corpus.version).toBe("log.oracle/v0");
  });
  const gated = (corpus.vectors as Vector[]).filter((v) => LOG_SUBSET.has(v.name));
  it("gates every vector in the declared subset", () => {
    expect(gated.map((v) => v.name).sort()).toEqual([...LOG_SUBSET].sort());
  });
  for (const v of gated) {
    it(`reproduces «${v.name}»`, () => {
      const got = replayLog(v.steps);
      expect(got).toEqual(v.steps.map((s) => s.out));
    });
  }
});
