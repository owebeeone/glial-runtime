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
  type AppendOutcome,
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
export {
  glialShapeCapabilities,
  requireExchangeShape,
  requireFoldShapeAdapter,
  requireMountShapeAdapter,
  requireShapeAdapter,
  UnsupportedShapeError,
  type GlialDeliveryShape,
  type GlialMountShape,
  type GlialShapeAdapter,
} from "./shapes.ts";
export {
  assembleSwmr,
  decodeSwmrAction,
  encodeSwmrAction,
  projectFileWindow,
  SwmrAdapterError,
  type FileWindow,
  type FileWindowRequest,
  type GlialSwmrAction,
  type SwmrAssembly,
} from "./swmr.ts";
export {
  AtomWriterConflictError,
  GlialAtomAdapter,
  ProviderStatusAtomRegistry,
  type AtomSurfaceDeclaration,
  type ProviderStatusWriter,
} from "./provider_status_atom.ts";
export {
  GlialStreamAdapter,
  LiveMetricsReader,
  LiveMetricsStream,
  LiveMetricsStreamRegistry,
  StreamWriterConflictError,
  type LiveMetricsWriter,
  type StreamSurfaceDeclaration,
} from "./live_metrics_stream.ts";
export {
  GlialCollaborativeText,
  type CollaborativeTextState,
} from "./collaborative_text.ts";
export {
  anchorSelection,
  assembleTextCrdt,
  decodeTextEdit,
  emptyTextCrdtState,
  encodeTextEdit,
  nextTextCounter,
  planTextReplacement,
  resolveSelection,
  textAtomId,
  TextCrdtError,
  type TextAffinity,
  type TextCrdtElement,
  type TextCrdtState,
  type TextCursorAnchor,
  type TextEdit,
  type TextElementId,
  type TextSelectionAnchor,
  type TextSelectionOffsets,
} from "./text_crdt.ts";
export * from "./bytes.ts";
