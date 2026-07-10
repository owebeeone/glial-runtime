// The glial grip-side ADAPTER (Lane T step 3a). A well-behaved grip-core `Tap`
// that consumes a glial binding INSTANCE, so a grip consumer (useGrip) stays a
// pure projection and never learns that a share is behind the value.
//
// Module-graph separation (kept visible on purpose): this is the ONLY file in
// the glial repo that imports `@owebeeone/grip-core`. The kernel (binder /
// instance / folds / store / session / events) imports `@owebeeone/glade-decl`
// and nothing grip — the kernel's vocabulary stays mount/unmount of instances
// with fills, no matcher/scoring/tap terms (GlialClientRuntime §Boundaries). The
// adapter is what T3b's per-binding cutover (GC-3, RULED) wires one binding at a
// time; its surface is therefore consumable a single binding at a time.
//
// What it does: on attach -> `binder.mount` (the tap's attach/detach lifecycle
// IS the instance refcount); an `InstanceEvent` (refresh|delta) -> a grip value
// publication; a grip-side write (value `set` / log `append`) -> an instance op
// through the binder. Fill derivation is DECLARATIVE data (a `FillSpec` mapping
// each fill part to a literal or a param grip), honoring config-as-data.

import { BaseTap } from "@owebeeone/grip-core";
import type { Grip, GripContext, GripContextLike, Tap, TapFactory } from "@owebeeone/grip-core";
import type { BindingDecl } from "@owebeeone/glade-decl";

import type { GlialBinder, Mount, MountConfig } from "../binder.ts";
import type { Fill, GladeDestination } from "../instance.ts";
import type { InstanceEvent } from "../events.ts";
import { fromUtf8, utf8 } from "../bytes.ts";

// ---- declarative fill derivation (config-as-data) -------------------------

/** One fill field's source: a literal string, or "the value of this param grip"
 *  read at mount and re-read when it changes. No callbacks — pure data. */
export type FillPart = string | { readonly param: Grip<any> };

/** Maps the decl's fill anchors to concrete ids as DATA (GAP-2 `Fill`). `domain`
 *  is required; `zone`/`key` optional. A `{ param }` part reads the current grip
 *  value in the tap's params context and `String()`s it. */
export interface FillSpec {
  readonly domain: FillPart;
  readonly zone?: FillPart;
  readonly key?: FillPart;
}

function fillParamGrips(spec: FillSpec): Grip<any>[] {
  const out: Grip<any>[] = [];
  for (const part of [spec.domain, spec.zone, spec.key]) {
    if (part && typeof part === "object" && "param" in part) out.push(part.param);
  }
  return out;
}

function sameFill(a: Fill, b: Fill): boolean {
  return a.domain === b.domain && (a.zone ?? "") === (b.zone ?? "") && (a.key ?? "") === (b.key ?? "");
}

// ---- payload codec (bytes <-> app value / log entry) ----------------------

/** Bytes <-> the app's value (or a single log entry). Opaque to glade; only the
 *  adapter and the app know the type (cf. grip-share's PayloadCodec). Default is
 *  JSON; a typed surface supplies its own. */
export interface PayloadCodec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

export const JSON_CODEC: PayloadCodec = {
  encode: (v) => utf8(JSON.stringify(v ?? null)),
  decode: (b) => JSON.parse(fromUtf8(b)),
};

// ---- the write seam (grip-side -> instance op) ----------------------------

/** The controller a consumer gets (optionally, via `handleGrip`) to write the
 *  surface. `set` is the value-shape op; `append` is the log-shape op — each
 *  routes an instance op through the binder (which ships it when connectivity is
 *  configured, else persists locally). Wrong-shape use throws. */
export interface GlialTapController<T = unknown> {
  readonly gladeId: string;
  /** The current assembled projection (same value the grip carries). */
  get(): T | undefined;
  /** value shape: replace the whole value. */
  set(value: unknown): void;
  /** log shape: append one entry. */
  append(entry: unknown): void;
}

// ---- adapter config -------------------------------------------------------

export interface GlialTapConfig<T = unknown> {
  /** The glial instance registry this tap mounts against. */
  readonly binder: GlialBinder;
  /** The app-static binding declaration (glade id + shape + anchors). */
  readonly decl: BindingDecl;
  /** The grip this tap provides (the value surface consumers read). */
  readonly grip: Grip<T>;
  /** Declarative fill derivation: (decl, params) -> the instance's concrete fill. */
  readonly fill: FillSpec;
  /** bytes <-> value/entry codec; defaults to JSON. */
  readonly codec?: PayloadCodec;
  /** Optional handle grip exposing the write controller (value set / log append). */
  readonly handleGrip?: Grip<GlialTapController<T>>;
  /** Connectivity, config-as-data: fill -> glade destination (undefined = local
   *  persistence only). A workspace mount supplies this; a bare app omits it. */
  readonly gladeFor?: (fill: Fill) => GladeDestination | undefined;
}

// ---- the tap --------------------------------------------------------------

export class GlialTap<T = unknown> extends BaseTap implements Tap, GlialTapController<T> {
  readonly gladeId: string;

  private readonly binder: GlialBinder;
  private readonly decl: BindingDecl;
  private readonly grip: Grip<T>;
  private readonly spec: FillSpec;
  private readonly codec: PayloadCodec;
  private readonly handleGrip?: Grip<GlialTapController<T>>;
  private readonly gladeFor?: (fill: Fill) => GladeDestination | undefined;
  private readonly params: Grip<any>[];
  private readonly isLog: boolean;

  private mounted?: Mount;
  private currentFill?: Fill;
  private current: T | undefined;

  constructor(config: GlialTapConfig<T>) {
    const params = fillParamGrips(config.fill);
    super({
      provides: config.handleGrip ? [config.grip, config.handleGrip] : [config.grip],
      homeParamGrips: params.length ? params : undefined,
    });
    this.binder = config.binder;
    this.decl = config.decl;
    this.grip = config.grip;
    this.spec = config.fill;
    this.codec = config.codec ?? JSON_CODEC;
    this.handleGrip = config.handleGrip;
    this.gladeFor = config.gladeFor;
    this.params = params;
    this.isLog = config.decl.shape === "log";
    this.gladeId = config.decl.glade_id.id;
  }

  // --- lifecycle: attach mounts the instance, detach releases the refcount ---

  onAttach(home: GripContext | GripContextLike): void {
    super.onAttach(home);
    // Ensure the fill's param grips resolve to a provider so `readParam` sees a
    // value (mirrors FunctionTap.onAttach; BaseTap already drives produceOnParams
    // on every home-param change, so we do NOT subscribe again here).
    const ctx = this.getParamsContext();
    if (ctx) {
      for (const g of this.params) {
        ctx.getOrCreateConsumer(g);
        ctx.getGrok().resolver.addConsumer(ctx, g);
      }
    }
    this.syncMount();
  }

  onDetach(): void {
    this.mounted?.unmount();
    this.mounted = undefined;
    this.currentFill = undefined;
    this.current = undefined;
    super.onDetach();
  }

  /** Publish the live projection (and the controller) to a destination or all. */
  produce(opts?: { destContext?: GripContext }): void {
    const updates = new Map<Grip<any>, any>([[this.grip, this.current]]);
    if (this.handleGrip) updates.set(this.handleGrip, this);
    this.publish(updates, opts?.destContext);
  }

  /** A fill param changed: re-derive and (re)mount the instance as needed. */
  produceOnParams(_paramGrip: Grip<any>): void {
    this.syncMount();
  }

  produceOnDestParams(_destContext: GripContext | undefined, _paramGrip: Grip<any>): void {}

  // --- write seam (GlialTapController) --------------------------------------

  get(): T | undefined {
    return this.current;
  }

  set(value: unknown): void {
    if (this.isLog) throw new Error(`GlialTap ${this.gladeId}: set() is a value-shape op; use append() for a log`);
    this.writePayload(this.codec.encode(value));
  }

  append(entry: unknown): void {
    if (!this.isLog) throw new Error(`GlialTap ${this.gladeId}: append() is a log-shape op; use set() for a value`);
    this.writePayload(this.codec.encode(entry));
  }

  private writePayload(payload: Uint8Array): void {
    if (!this.mounted) throw new Error(`GlialTap ${this.gladeId}: write before mount (no live instance)`);
    this.mounted.instance.write(payload);
  }

  // --- mount management ------------------------------------------------------

  private readParam(grip: Grip<any>): unknown {
    return this.getParamsContext()?.getOrCreateConsumer(grip).get();
  }

  /** null => a referenced param is not ready yet (defer the mount). */
  private partValue(part: FillPart | undefined): string | undefined | null {
    if (part === undefined) return undefined;
    if (typeof part === "string") return part;
    const v = this.readParam(part.param);
    return v === undefined || v === null ? null : String(v);
  }

  private deriveFill(): Fill | null {
    const domain = this.partValue(this.spec.domain);
    if (domain == null) return null; // required, or a param not ready
    const zone = this.partValue(this.spec.zone);
    if (zone === null) return null;
    const key = this.partValue(this.spec.key);
    if (key === null) return null;
    const fill: Fill = { domain };
    if (zone !== undefined) fill.zone = zone;
    if (key !== undefined) fill.key = key;
    return fill;
  }

  private syncMount(): void {
    const fill = this.deriveFill();
    if (fill === null) return; // not derivable yet — a later param change retries
    if (this.currentFill && sameFill(this.currentFill, fill)) return; // unchanged
    this.mounted?.unmount(); // fill changed: release the old instance interest
    this.currentFill = fill;
    const glade = this.gladeFor?.(fill);
    const config: MountConfig = glade ? { glade } : {};
    // The listener fires a refresh synchronously here (assembly is fanned, not
    // recomputed); onInstanceEvent updates `current` and publishes.
    this.mounted = this.binder.mount(this.decl, fill, (e) => this.onInstanceEvent(e), config);
  }

  private onInstanceEvent(e: InstanceEvent): void {
    this.current = this.assemble(e);
    this.produce();
  }

  /** InstanceEvent -> the grip value. value shape: the decoded whole (default on
   *  empty). log shape: the decoded record list (`records` is the whole list on
   *  both refresh and delta, so the consumer always projects the full log). */
  private assemble(e: InstanceEvent): T | undefined {
    if (this.isLog) {
      const records = e.records ?? [];
      return records.map((r) => this.codec.decode(r.payload)) as unknown as T;
    }
    if (e.empty) return this.grip.defaultValue;
    return (e.value !== undefined ? this.codec.decode(e.value) : this.grip.defaultValue) as T | undefined;
  }
}

// ---- factory form (usable as a matcher-row `tap:`) ------------------------

/** The `TapFactory` form of the adapter. A per-context matcher row (CoinColumn)
 *  or an engine-global binding row (WeatherColumn) `build()`s one adapter tap per
 *  home; each attaches -> mounts its own instance -> distinct fill => distinct
 *  instance. The idiom choice (param grip vs matcher row) stays grip's business —
 *  glial only ever sees the fill. */
export class GlialTapFactory<T = unknown> implements TapFactory {
  readonly kind: "TapFactory" = "TapFactory";
  readonly provides: readonly Grip<any>[];
  readonly label: string;

  constructor(private readonly config: GlialTapConfig<T>) {
    this.provides = config.handleGrip ? [config.grip, config.handleGrip] : [config.grip];
    this.label = `glial:${config.decl.glade_id.id}`;
  }

  build(): Tap {
    return new GlialTap(this.config) as unknown as Tap;
  }
}

/** Build a single adapter tap (an engine-global instance row). */
export function glialTap<T>(config: GlialTapConfig<T>): GlialTap<T> {
  return new GlialTap(config);
}

/** Build the factory form for a matcher-row / lazy instantiation. */
export function glialTapFactory<T>(config: GlialTapConfig<T>): GlialTapFactory<T> {
  return new GlialTapFactory(config);
}
