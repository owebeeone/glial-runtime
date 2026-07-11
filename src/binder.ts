// The glial binder — the instance registry. Its whole vocabulary is
// decl / fill / instance / mount (GlialClientRuntime §Boundaries): it never
// references a matcher, a matching context, or any scoring/selection idiom —
// how the grip side picks and parameterizes an instance stays on grip's side of
// the mount/unmount seam. Several instances per decl; a mount of a fill that is
// already live attaches (refcount++, no new fold/store); the last unmount tears
// the instance down.

import type { BindingDecl } from "@owebeeone/glade-decl";
import { MemoryStoreEngine, type StoreEngine } from "./store.ts";
import { BindingInstance, type Fill, type GladeDestination, instanceKey } from "./instance.ts";
import type { InstanceEvent } from "./events.ts";

export interface MountConfig {
  /** When present, connectivity is lit for this instance (config-as-data — a
   *  workspace mount adds a glade destination to the SAME binding). */
  glade?: GladeDestination;
}

export interface Mount {
  readonly instance: BindingInstance;
  /** Detach this consumer: refcount--, tearing the instance down at zero. */
  unmount(): void;
}

export class GlialBinder {
  private readonly instances = new Map<string, BindingInstance>();
  private readonly store: StoreEngine;
  private readonly origin: string;

  constructor(store: StoreEngine = new MemoryStoreEngine(), origin = "local") {
    this.store = store;
    this.origin = origin;
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
    const key = instanceKey(decl.glade_id.id, fill);
    let instance = this.instances.get(key);
    if (!instance) {
      instance = new BindingInstance(decl, fill, key, this.store.open(key), this.origin);
      instance.hydrate();
      this.instances.set(key, instance);
    }
    if (config.glade) instance.attachGlade(config.glade);

    instance.refcount += 1;
    const off = listener ? instance.subscribe(listener) : () => {};

    let live = true;
    return {
      instance,
      unmount: () => {
        if (!live) return;
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
