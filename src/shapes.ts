/** Exact delivery capabilities implemented by Glial.
 *
 * Declaration recognition and runtime support are deliberately separate. A
 * known Glade shape reaches assembly only through this registry; unsupported or
 * future names are never reinterpreted as Value.
 */

export type GlialDeliveryShape = "atom" | "crdt" | "value" | "log" | "stream" | "swmr" | "text_crdt";
export type GlialFoldShape = "value" | "log";
export type GlialMountShape = GlialFoldShape | "swmr" | "crdt";

export interface GlialShapeAdapter {
  readonly shape: GlialDeliveryShape;
  readonly contractVersion: string;
  readonly operations: readonly string[];
}

const ADAPTERS: Readonly<Record<GlialDeliveryShape, GlialShapeAdapter>> = Object.freeze({
  atom: Object.freeze({
    shape: "atom",
    contractVersion: "atom.oracle/v1",
    operations: Object.freeze(["replace", "read", "end-stream"]),
  }),
  crdt: Object.freeze({
    shape: "crdt",
    contractVersion: "crdt.oracle/v1",
    operations: Object.freeze(["apply", "read", "bootstrap", "reconnect"]),
  }),
  value: Object.freeze({
    shape: "value",
    contractVersion: "value.oracle/v0",
    operations: Object.freeze(["read", "set", "local-invalidation"]),
  }),
  log: Object.freeze({
    shape: "log",
    contractVersion: "log.oracle/v0",
    operations: Object.freeze(["append", "read", "subscribe"]),
  }),
  stream: Object.freeze({
    shape: "stream",
    contractVersion: "stream.oracle/v1",
    operations: Object.freeze(["push", "read", "reconnect", "end-stream"]),
  }),
  swmr: Object.freeze({
    shape: "swmr",
    contractVersion: "swmr.oracle/v1",
    operations: Object.freeze(["snapshot_push", "delta_push", "reset", "read"]),
  }),
  text_crdt: Object.freeze({
    shape: "text_crdt",
    contractVersion: "text_crdt.profile/v1",
    operations: Object.freeze(["insert", "delete", "read", "bootstrap", "reconnect"]),
  }),
});

export class UnsupportedShapeError extends Error {
  readonly code = "GLIAL_UNSUPPORTED_SHAPE";
  readonly shape: string;
  readonly operation: string;
  readonly supported: readonly string[];

  constructor(shape: string, operation: string, supported: readonly string[]) {
    super(`Glial does not support shape ${JSON.stringify(shape)} for ${operation}; supported: ${supported.join(", ")}`);
    this.name = "UnsupportedShapeError";
    this.shape = shape;
    this.operation = operation;
    this.supported = supported;
  }
}

export function requireShapeAdapter(shape: string, operation = "delivery"): GlialShapeAdapter {
  if (shape === "atom" || shape === "crdt" || shape === "value" || shape === "log" || shape === "stream" || shape === "swmr" || shape === "text_crdt") {
    return ADAPTERS[shape];
  }
  throw new UnsupportedShapeError(shape, operation, Object.keys(ADAPTERS));
}

/** Exact durable instance adapters. SWMR has canonical assembly, not a fold. */
export function requireMountShapeAdapter(
  shape: string,
  operation = "mount delivery",
): GlialShapeAdapter & { readonly shape: GlialMountShape } {
  if (shape === "value" || shape === "log" || shape === "swmr" || shape === "crdt") {
    return ADAPTERS[shape] as GlialShapeAdapter & { readonly shape: GlialMountShape };
  }
  throw new UnsupportedShapeError(shape, operation, ["crdt", "log", "swmr", "value"]);
}

/** Glial's op-fold/store seam remains multi-writer value/log only. */
export function requireFoldShapeAdapter(
  shape: string,
  operation = "fold delivery",
): GlialShapeAdapter & { readonly shape: GlialFoldShape } {
  if (shape === "value" || shape === "log") {
    return ADAPTERS[shape] as GlialShapeAdapter & { readonly shape: GlialFoldShape };
  }
  throw new UnsupportedShapeError(shape, operation, ["log", "value"]);
}

/** Exchange is a dedicated correlated service path, never a delivery fold. */
export function requireExchangeShape(shape: string, operation = "serveExchange"): void {
  if (shape !== "exchange") throw new UnsupportedShapeError(shape, operation, ["exchange"]);
}

export function glialShapeCapabilities(): readonly GlialShapeAdapter[] {
  return Object.freeze(Object.values(ADAPTERS));
}
