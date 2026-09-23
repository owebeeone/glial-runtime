// The glial binder — the instance registry. Its whole vocabulary is
// decl / fill / instance / mount (GlialClientRuntime §Boundaries): it never
// references a matcher, a matching context, or any scoring/selection idiom —
// how the grip side picks and parameterizes an instance stays on grip's side of
// the mount/unmount seam. Several instances per decl; a mount of a fill that is
// already live attaches (refcount++, no new fold/store); the last unmount tears
// the instance down.

import type { BindingDecl, ShapeProfileDecl } from "@owebeeone/glade-decl";
import { MemoryStoreEngine, type StoreEngine } from "./store.ts";
import { BindingInstance, type Fill, type GladeDestination, instanceKey } from "./instance.ts";
import type { InstanceEvent } from "./events.ts";
import { requireMountShapeAdapter } from "./shapes.ts";

export interface MountConfig {
  /** When present, connectivity is lit for this instance (config-as-data — a
   *  workspace mount adds a glade destination to the SAME binding). */
  glade?: GladeDestination;
  /** A CRDT engine is payload-agnostic. Mounts MUST opt into the concrete
   *  profile whose operations and projection Glial should expose. A profile
   *  declared for the glade id (the binder's `ShapeProfileLookup`) is read
   *  ahead of this field, which stays for back-compat. */
  crdtProfile?: "text_crdt";
}

/** Reads a declared shape profile by glade id (glade-decl v1, ruling R4(b)):
 *  the profile is a `ShapeProfileDecl` record keyed by glade id, never a
 *  `BindingDecl` field. Where the records come from is the caller's; the
 *  binder only looks one up when it mounts a `crdt` decl. */
export type ShapeProfileLookup = (gladeId: string) => ShapeProfileDecl | undefined;

export interface Mount {
  readonly instance: BindingInstance;
  /** Detach this consumer: refcount--, tearing the instance down at zero. */
  unmount(): void;
}

export class GlialBinder {
  private readonly instances = new Map<string, BindingInstance>();
  private readonly store: StoreEngine;
  private readonly origin: string;
  private readonly shapeProfiles?: ShapeProfileLookup;

  /** `shapeProfiles` is optional: without it, a `crdt` mount takes its profile
   *  from `MountConfig.crdtProfile` exactly as before. */
  constructor(store: StoreEngine = new MemoryStoreEngine(), origin = "local", shapeProfiles?: ShapeProfileLookup) {
    this.store = store;
    this.origin = origin;
    this.shapeProfiles = shapeProfiles;
  }

  /** Mount `(decl, fill)`. Creates the instance on first interest (own store +
   *  fold), or attaches to the live one. Persistence is always on; connectivity
   *  only when `config.glade` is supplied. An optional listener receives a
   *  refresh immediately and every change after.
   *
   *  `decl` accepts a typed `Surface` handle from a manifest (GLP-0006 P0.S5a —
   *  `@owebeeone/glial-runtime/manifest`; a `Surface` IS a `BindingDecl`), the
   *  preferred form. A raw `BindingDecl` remains accepted for back-compat. */
  mount(decl: BindingDecl, fill: Fill, listener?: (e: InstanceEvent) => void, config: MountConfig = {}): Mount {
    // Check before opening a store or creating any instance state.
    requireMountShapeAdapter(decl.shape, "mount");
    const crdtProfile = decl.shape === "crdt" ? this.crdtProfileOf(decl, config) : config.crdtProfile;
    const key = instanceKey(decl.glade_id.id, fill);
    let instance = this.instances.get(key);
    if (!instance) {
      instance = new BindingInstance(decl, fill, key, this.store.open(key), this.origin, crdtProfile);
      instance.hydrate();
      this.instances.set(key, instance);
    }
    if (config.glade) {
      instance.attachGlade(config.glade);
    }

    instance.refcount += 1;
    const off = listener ? instance.subscribe(listener) : () => {};

    let live = true;
    return {
      instance,
      unmount: () => {
        if (!live) {
          return;
        }
        live = false;
        off();
        instance!.refcount -= 1;
        if (instance!.refcount === 0) {
          instance!.dispose();
          this.instances.delete(key);
          this.store.drop(key);
        }
      },
    };
  }

  /** The profile a `crdt` mount runs: the one declared for its glade id, read
   *  ahead of `config.crdtProfile`. Glial mounts `crdt` only as `text_crdt`;
   *  anything else is refused here, before a store or instance exists. */
  private crdtProfileOf(decl: BindingDecl, config: MountConfig): "text_crdt" {
    const id = decl.glade_id.id;
    const declared = this.shapeProfiles?.(id);
    if (declared === undefined) {
      if (config.crdtProfile !== "text_crdt") {
        throw new Error(`Glial CRDT mount ${id} requires crdtProfile \"text_crdt\"`);
      }
      return "text_crdt";
    }
    if (declared.glade_id.id !== id) {
      throw new Error(`Glial CRDT mount ${id}: the shape-profile lookup answered with the declaration of ${declared.glade_id.id}`);
    }
    if (declared.profile !== "text_crdt") {
      throw new Error(`Glial CRDT mount ${id} declares shape profile ${JSON.stringify(declared.profile)}; Glial mounts crdt only as "text_crdt"`);
    }
    return "text_crdt";
  }

  /** Live-instance count — a mounted decl with two fills reports 2. */
  get instanceCount(): number {
    return this.instances.size;
  }

  /** The refcount of a live instance, or 0 if none. */
  refcountOf(decl: BindingDecl, fill: Fill): number {
    return this.instances.get(instanceKey(decl.glade_id.id, fill))?.refcount ?? 0;
  }

  /** Whether an instance for `(decl, fill)` is currently live. */
  isLive(decl: BindingDecl, fill: Fill): boolean {
    return this.instances.has(instanceKey(decl.glade_id.id, fill));
  }
}
