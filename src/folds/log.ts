// The `log` fold (append) — glial's own assembly, gated against the append +
// catch-up-read subset of taut-shape's log oracle (`corpus/log.v0.json`). A
// push assigns the next seq (first record = seq 1, D8); a read returns the
// records after a cursor bounded by max_records and/or max_bytes (raw payload
// bytes, D10), advancing next_cursor to the last delivered seq; an immediate
// read (timeout_ms=0) with nothing to deliver is `would_block` (D14).
//
// Scope (see dev-docs/DecisionLog.md GAP-1): binder v0 covers the IMMEDIATE
// append/read core — the held-read/timer/seal/close/evict/producer-stop vectors
// are the full log+window delivery engine and are out of scope here.

export interface LogRecord {
  seq: number;
  payload: Uint8Array;
}

export interface ReadReq {
  /** exclusive: records with seq > cursorSeq are returned */
  cursorSeq: number;
  maxRecords?: number | null;
  maxBytes?: number | null;
}

export interface ReadResult {
  state: "data" | "would_block";
  records: LogRecord[];
  nextCursorSeq: number;
}

export class LogBuffer {
  private records: LogRecord[] = [];

  /** Append a record; the returned record carries its assigned seq. */
  push(payload: Uint8Array): LogRecord {
    const rec: LogRecord = { seq: this.records.length + 1, payload };
    this.records.push(rec);
    return rec;
  }

  get head(): number {
    return this.records.length;
  }

  /** All records currently assembled (the whole-value refresh). */
  all(): LogRecord[] {
    return this.records.slice();
  }

  /** Catch-up read from a cursor, bounded by max_records / max_bytes. */
  read(req: ReadReq): ReadResult {
    const out: LogRecord[] = [];
    let bytes = 0;
    for (const rec of this.records) {
      if (rec.seq <= req.cursorSeq) continue;
      if (req.maxRecords != null && out.length >= req.maxRecords) break;
      if (req.maxBytes != null && out.length > 0 && bytes + rec.payload.length > req.maxBytes) break;
      out.push(rec);
      bytes += rec.payload.length;
    }
    const nextCursorSeq = out.length ? out[out.length - 1].seq : req.cursorSeq;
    return { state: out.length ? "data" : "would_block", records: out, nextCursorSeq };
  }
}
