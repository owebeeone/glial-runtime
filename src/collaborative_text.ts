/** Offline-first collaborative text using only the canonical Taut CRDT core. */

import {
  CrdtNode,
  encodeTextDelete,
  encodeTextInsert,
  projectText,
  type CrdtDiagnostic,
  type CrdtOp,
  type CrdtOutput,
} from "@owebeeone/taut-shape";

export interface CollaborativeTextState {
  readonly text: string;
  readonly clock: Readonly<Record<string, bigint>>;
  readonly diagnostics: readonly string[];
}

/**
 * Glial's deliberately collaborative document surface. The adapter owns no
 * merge, dedup, or cursor rule: both local edits and peer exchange cross
 * `CrdtNode`, and display state comes from the shared `text_crdt` projection.
 */
export class GlialCollaborativeText {
  readonly shape = "text_crdt" as const;
  readonly contractVersion = "text_crdt.profile/v1";
  readonly origin: string;
  private readonly node = new CrdtNode();
  private readonly deliveryDiagnostics = new Set<string>();

  constructor(origin: string) {
    if (origin.length === 0) throw new TypeError("collaborative-text origin must not be empty");
    this.origin = origin;
  }

  insert(atomId: string, after: string | null, text: string): CrdtOp {
    return this.applyLocal(encodeTextInsert(atomId, after, text));
  }

  delete(atomId: string): CrdtOp {
    return this.applyLocal(encodeTextDelete(atomId));
  }

  /** Exchange durable vector cursors and missing operations in both directions. */
  reconnect(peer: GlialCollaborativeText): void {
    // A divergent peer's full vector contains components this side has not
    // observed yet, so it is correctly an invalid read cursor. Exchange the
    // retained op sets first (exact replay is idempotent), then use vector
    // reads as the resume/verification phase.
    for (const op of this.node.operations) peer.collect(peer.node.handle({ type: "apply", op }));
    for (const op of peer.node.operations) this.collect(this.node.handle({ type: "apply", op }));
    this.syncOneWay(this.node, peer);
    this.syncOneWay(peer.node, this);
  }

  state(): CollaborativeTextState {
    const projection = projectText(this.node);
    return {
      text: projection.text,
      clock: Object.freeze(Object.fromEntries(this.node.clock.entries.map((entry) => [entry.origin, entry.seq]))),
      diagnostics: Object.freeze([...this.deliveryDiagnostics, ...projection.diagnostics].sort()),
    };
  }

  private applyLocal(payload: Uint8Array): CrdtOp {
    const own = this.node.clock.entries.find((entry) => entry.origin === this.origin)?.seq ?? 0n;
    const op: CrdtOp = {
      origin: this.origin,
      seq: own + 1n,
      deps: this.node.clock,
      payload,
    };
    this.collect(this.node.handle({ type: "apply", op }));
    return op;
  }

  private syncOneWay(source: CrdtNode, target: GlialCollaborativeText): void {
    const [output] = source.handle({
      type: "read",
      crdt_id: "glial.document",
      stream_id: target.origin,
      cursor: target.node.clock,
    });
    if (output?.type !== "read_response") throw new Error("CRDT read did not produce a response");
    if (output.bootstrap !== null) {
      target.collect(target.node.handle({ type: "install_bootstrap", bootstrap: output.bootstrap }));
    }
    for (const op of output.ops) target.collect(target.node.handle({ type: "apply", op }));
  }

  private collect(outputs: readonly CrdtOutput[]): void {
    for (const output of outputs) {
      if (output.type === "diagnostic") this.deliveryDiagnostics.add(diagnosticName(output));
    }
  }
}

function diagnosticName(value: { readonly type: "diagnostic" } & CrdtDiagnostic): string {
  return `${value.code}:${value.origin ?? ""}:${value.seq ?? ""}`;
}
