/** Optional GRIP integration. Graph/controller ports are local objects, never wire data. */
interface GripKey { readonly name: string; readonly key: string }
export interface LeafController {
  /** Stable local document/controller identity. Never serialized. */
  identity: object;
  /** Validate without mutation, then return the normal synchronous edit. */
  prepare(value: unknown): () => void;
}
export interface ValueController {
  get(): unknown; set(value: any): void; update(fn: (previous: any) => any): void;
  /** A specialized controller can make metadata read-only while exposing its
   * supported editable projection. Ordinary atoms need no leaf registration. */
  getLeafController?(path: readonly string[]): LeafController | undefined;
}
interface Node {
  readonly id: string;
  get_context(): object | undefined;
  readonly producers: ReadonlyMap<GripKey, { readonly tap: object; getDestinations?(): ReadonlyMap<Node, { getGrips(): ReadonlySet<GripKey> }> }>;
  readonly consumers: ReadonlyMap<GripKey, { deref(): { get(): unknown } | undefined }>;
  readonly resolvedProviders?: ReadonlyMap<GripKey, Node>;
}
export interface GripGraphPort { getGraph(): ReadonlyMap<string, Node> }
export interface ValueLocation { context: string; grip: string; gripKey: string; path: string[]; role?: "owner" | "destination"; ownerContext?: string; writeScope?: "owner-shared" | "destination-local" }
export interface DiscoveredValue extends ValueLocation {
  writable: boolean; type: string; ref?: string; value?: string | number | boolean | null; error?: string;
}
export interface GripAssistanceOptions {
  id(): string;
  excludeContext?(context: string): boolean;
  exclude?(location: ValueLocation): boolean;
  /** Associate an atom with its normal application controller/persistence once.
   * Unassociated discovered controllers remain enabled by default. */
  controller?(location: ValueLocation, controller: ValueController): ValueController;
}
interface Target { ref: string; location: ValueLocation; context: object; tap: object; grip: GripKey; controller: ValueController; type: string; binding?: object; owner?: object; leaf?: LeafController }
const scalarType = (value: unknown) => value === null ? "null" : ["string", "boolean"].includes(typeof value) ? typeof value : typeof value === "number" && Number.isFinite(value) ? "number" : undefined;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

/** Auto-discovered existing scalar leaves. No parent object replacement or schema inference. */
export class GripAssistance {
  private pairing?: string;
  private targets = new Map<string, Target>();
  constructor(private graph: GripGraphPort, private options: GripAssistanceOptions) {}
  read(pairing: string): DiscoveredValue[] {
    if (pairing !== this.pairing) { this.targets.clear(); this.pairing = pairing; }
    const out: DiscoveredValue[] = [], seen = new Set<string>();
    const excluded = (location: ValueLocation) => this.options.exclude?.(location) || location.role === "destination" && this.options.exclude?.({ ...location, context: location.ownerContext!, role: "owner" });
    const append = (location: ValueLocation, value: unknown, source: { context: object; tap: object; grip: GripKey; controller?: ValueController; binding?: object; owner?: object }, ancestors: Set<object>) => {
      if (excluded(location)) return;
      if (out.length >= 10000 || location.path.length > 64) throw Error("Discovery limit exceeded");
      const type = scalarType(value);
      if (type) {
        let ref: string | undefined;
        const leaf = source.controller?.getLeafController?.(location.path);
        const writable = !!source.controller && (!source.controller.getLeafController || !!leaf);
        if (source.controller && writable) {
          const key = JSON.stringify([location.role, location.context, location.gripKey, location.path]);
          let target = this.targets.get(key);
          if (!target || target.context !== source.context || target.tap !== source.tap || target.grip !== source.grip || target.type !== type || target.binding !== source.binding || target.owner !== source.owner || target.leaf?.identity !== leaf?.identity) {
            target = { ...source, controller: source.controller, location, type, leaf, ref: this.options.id() }; this.targets.set(key, target);
          } else { target.controller = source.controller; target.leaf = leaf; }
          seen.add(key); ref = target.ref;
        }
        out.push({ ...location, writable, type, ...(ref ? { ref } : {}), value: value as string | number | boolean | null }); return;
      }
      if (!value || typeof value !== "object" || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) || ancestors.has(value)) {
        out.push({ ...location, writable: false, type: typeof value, error: "unsupported runtime value (or cycle)" }); return;
      }
      out.push({ ...location, writable: false, type: Array.isArray(value) ? "array" : "object" });
      const nextAncestors = new Set(ancestors).add(value);
      for (const key of Object.keys(value)) {
        const child = { ...location, path: [...location.path, key] };
        if (excluded(child)) continue;
        const property = Object.getOwnPropertyDescriptor(value, key)!;
        if (forbidden.has(key) || !("value" in property)) {
          out.push({ ...child, writable: false, type: "unsupported", error: "unsupported property or accessor" }); continue;
        }
        append(child, property.value, source, nextAncestors);
      }
    };
    for (const node of new Set(this.graph.getGraph().values())) {
      if (this.options.excludeContext?.(node.id)) continue;
      const context = node.get_context(); if (!context) continue;
      const maps = new Map<object, ReadonlyMap<GripKey, ValueController> | undefined>();
      for (const [grip, record] of node.producers) {
        const location: ValueLocation = { context: node.id, grip: grip.name, gripKey: grip.key, path: [], role: "owner", ownerContext: node.id, writeScope: "owner-shared" };
        if (excluded(location)) continue;
        const tap = record.tap as { getValueControllers?(): ReadonlyMap<GripKey, ValueController>; destinationParamGrips?: readonly GripKey[] };
        if (!maps.has(tap)) maps.set(tap, tap.getValueControllers?.());
        const controllers = maps.get(tap), original = controllers?.get(grip);
        if (controllers && !original) continue; // Handle outputs are never data.
        const controller = original && (this.options.controller?.(location, original) ?? original);
        const reader = controller ?? node.consumers.get(grip)?.deref();
        if (!reader) { out.push({ ...location, writable: false, type: "unavailable", error: "no published value at this context" }); }
        else { append(location, reader.get(), { context, tap, grip, controller }, new Set()); }
        // Existing destination bindings are authoritative. Never query/create a
        // consumer or walk parent paths to guess which provider won resolution.
        for (const [destination, binding] of record.getDestinations?.() ?? []) {
          if (this.options.excludeContext?.(destination.id) || !binding.getGrips().has(grip) || destination.resolvedProviders?.get(grip) !== node) continue;
          const destContext = destination.get_context(); if (!destContext) continue;
          const destLocation: ValueLocation = { ...location, context: destination.id, role: "destination", writeScope: destination === node ? "destination-local" : "owner-shared" };
          if (excluded(destLocation)) continue;
          const drip = destination.consumers.get(grip)?.deref(); if (!drip) continue;
          // An atom's mapped controller edits its owner, including when viewed
          // from a destination. Parameter-dependent output controllers cannot
          // be inferred from a home controller and remain read-only here.
          const destController = tap.destinationParamGrips?.length ? undefined : controller;
          append(destLocation, destController?.getLeafController ? destController.get() : drip.get(), { context: destContext, tap, grip, controller: destController, binding, owner: context }, new Set());
        }
      }
    }
    for (const key of this.targets.keys()) if (!seen.has(key)) this.targets.delete(key);
    return out;
  }
  prepareWrite(input: unknown, pairing: string): () => void {
    const args = input as { ref?: unknown; value?: unknown };
    if (!args || typeof args.ref !== "string" || Object.keys(args).sort().join(",") !== "ref,value") throw Error("Invalid write reference and value");
    const resolve = () => {
      this.read(pairing);
      const target = [...this.targets.values()].find(t => t.ref === args.ref);
      if (!target) throw Error("Stale or unknown writable reference");
      if (scalarType(args.value) !== target.type) throw Error("Scalar type mismatch");
      return target;
    };
    const prepared = resolve(), specialized = prepared.leaf?.prepare(args.value);
    return () => {
      const target = resolve();
      if (specialized) specialized();
      else target.controller.update(previous => replaceLeaf(previous, target.location.path, args.value));
    };
  }
}

export interface VersionedTextDocument {
  readonly value: { text: string; version: number; ready: boolean };
  replace(text: string, expectedVersion: number): void;
}
/** Normal document controller association, once per collection. Every loaded
 * document's text is discoverable by default; metadata is read-only. No mirror
 * mutation, eager document creation, or persistence/recovery protocol. */
export function versionedTextDocuments(documents: () => ReadonlyMap<string, VersionedTextDocument>): ValueController {
  const unsupported = () => { throw Error("Document collections cannot be replaced directly"); };
  return {
    get: () => Object.fromEntries([...documents()].map(([key, document]) => [key, document.value])),
    set: unsupported, update: unsupported,
    getLeafController(path) {
      if (path.length !== 2 || path[1] !== "text") return;
      const document = documents().get(path[0]); if (!document?.value.ready) return;
      const version = document.value.version;
      const check = () => {
        if (documents().get(path[0]) !== document) throw Error("Document changed; read a fresh reference");
        if (!document.value.ready || document.value.version !== version) throw Error("Draft changed or disconnected; read its latest version");
      };
      return { identity: document, prepare(value) {
        if (typeof value !== "string") throw Error("Document text must be a string");
        check(); return () => { check(); document.replace(value, version); };
      } };
    },
  };
}

/** Clone only ancestors with descriptors: excluded sibling getters are never invoked. */
function replaceLeaf(current: any, path: string[], value: unknown): any {
  if (!path.length) return value;
  const [key, ...rest] = path;
  const property = current && Object.getOwnPropertyDescriptor(current, key);
  if (!property || !("value" in property) || forbidden.has(key)) throw Error("Stale writable path");
  const descriptors = Object.getOwnPropertyDescriptors(current);
  descriptors[key] = { ...property, value: replaceLeaf(property.value, rest, value) };
  return Object.defineProperties(Array.isArray(current) ? [] : Object.create(Object.getPrototypeOf(current)), descriptors);
}
