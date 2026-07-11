// The typed manifest (GLP-0006 P0.S5a) — the COMPILE-WALL surface. An app's
// glade ids are referenced through typed identifiers, so a typo'd or undefined
// surface is a TypeScript build error BY CONSTRUCTION: consumers write
// `M.notes`, never the string `"app:notes"`.
//
// `defineManifest({...})` returns a FROZEN object whose values are typed
// `Surface` handles — BindingDecl-shaped (glade id, shape, authority, domain,
// zone, retention) plus the wire `share` + zone `key` a supplier/mount needs.
// Because a `Surface` IS a `BindingDecl` (structurally), the kernel's
// `binder.mount(decl, fill)`, the grip adapter's `GlialTapConfig.decl`, and the
// supplier's `serve*` all accept `M.notes` with no change — and a raw decl
// stays accepted for back-compat (see those APIs' doc comments).
//
// GQ-6 SEAM (do NOT implement the hash here): `GladeDeclSurface.md` derives a
// glade id from `(package_id, grip_key)` and pins a manifest. The typed handle
// carries the EXPLICIT id today; the derivation slots in behind `SurfaceSpec.id`
// later with zero consumer churn (they reference the handle, never the id).

import type {
  Authority,
  BindingDecl,
  DomainAnchor,
  Retention,
  Shape,
  ZoneKind,
} from "@owebeeone/glade-decl";

/** A typed surface handle: a `BindingDecl` (narrowed to a concrete `Shape`) plus
 *  the wire `share` and zone `key` a supplier serves / a mount addresses. Frozen
 *  at manifest build. Assignable to `BindingDecl` (mount / adapter) and to the
 *  supplier's `SupplierSurface`. */
export interface Surface<S extends Shape = Shape> extends BindingDecl {
  readonly shape: S;
  /** The concrete replicated world this surface addresses (the decl's `domain`
   *  default resolved by grazel config). Supplier serving + wire routing use it. */
  readonly share: string;
  /** The zone key; absent/empty = commons. */
  readonly key?: Uint8Array;
}

/** One surface's declaration in a manifest. Only `id`, `shape`, `share` are
 *  required; the BindingDecl anchors default (document / commons / share). */
export interface SurfaceSpec {
  /** The glade id — EXPLICIT today (GQ-6 derivation slots in behind this later,
   *  see the module header). */
  readonly id: string;
  readonly shape: Shape;
  /** The concrete share (domain default). */
  readonly share: string;
  readonly domain?: DomainAnchor;
  readonly zone?: ZoneKind;
  readonly authority?: Authority;
  readonly source?: string | null;
  readonly retention?: Retention;
  readonly key?: Uint8Array;
}

/** The frozen manifest type: each key maps to a `Surface` carrying that spec's
 *  `Shape`. The key set is exact, so `M.<undefined>` is a compile error. */
export type Manifest<T extends Record<string, SurfaceSpec>> = {
  readonly [K in keyof T]: Surface<T[K]["shape"]>;
};

const DEFAULT_RETENTION: Retention = { policy: "latest", ttl_ms: null };

function toSurface(spec: SurfaceSpec): Surface {
  const surface: Surface = {
    glade_id: Object.freeze({ id: spec.id }),
    shape: spec.shape,
    authority: spec.authority ?? "share",
    source: spec.source ?? null,
    domain: spec.domain ?? "document",
    zone: spec.zone ?? "commons",
    retention: spec.retention ?? DEFAULT_RETENTION,
    share: spec.share,
    key: spec.key,
  };
  return Object.freeze(surface);
}

/** Build a manifest: a frozen map of typed `Surface` handles keyed by the names
 *  you give. Reference surfaces as `M.notes` — an undefined key is a TS build
 *  error, which IS the declared-surface compile wall (GLP-0006 P0.S5a). */
export function defineManifest<T extends Record<string, SurfaceSpec>>(specs: T): Manifest<T> {
  const out: Record<string, Surface> = {};
  for (const name of Object.keys(specs)) {
    out[name] = toSurface(specs[name]!);
  }
  return Object.freeze(out) as Manifest<T>;
}
