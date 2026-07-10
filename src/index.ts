// glial — the client-side kernel (GDL-035, ratified 2026-07-07).
//
// Persistence FIRST (every instance gets a local store destination, glade
// optional and configured-in), taut-shape-aware assembly INSIDE glial (value +
// log folds, corpus-conformant), rich incremental change events (the consumer
// chooses delta vs whole-refresh against live UI state). The binder's public
// vocabulary is decl / fill / instance / mount only — no matcher terms cross the
// seam. `glade-decl` is the shared leaf both grip-core and glial import.

export { GlialBinder, type Mount, type MountConfig } from "./binder.ts";
export { BindingInstance, type Fill, type GladeDestination, instanceKey } from "./instance.ts";
export {
  MemoryStoreEngine,
  type InstanceStore,
  type StoredOp,
  type StoreEngine,
} from "./store.ts";
export { IndexedDbStoreEngine } from "./store_idb.ts";
export { type InstanceEvent } from "./events.ts";
export {
  feedSession,
  SessionDestination,
  type OpBus,
  type Route,
  type SessionLike,
  type WireOp,
} from "./session.ts";
export { ValueRegister, type ValueState, type Winner } from "./folds/value.ts";
export { LogBuffer, type LogRecord, type ReadReq, type ReadResult } from "./folds/log.ts";
export * from "./bytes.ts";
