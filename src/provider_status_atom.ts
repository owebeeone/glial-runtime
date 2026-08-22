/** A real single-writer latest-state consumer of `atom.oracle/v1`.
 *
 * Provider status is owned by one provider identity. Readers reconnect with
 * their last observed atom version and receive only a newer retained status.
 * This is deliberately separate from Glial's multi-writer `value` fold.
 */

import {
  AtomNode,
  type AtomInput,
  type AtomOutput,
} from "@owebeeone/taut-shape";

type ReadResponse = Extract<AtomOutput, { readonly type: "read_response" }>;

export interface AtomSurfaceDeclaration {
  readonly id: string;
  readonly shape: "atom";
  readonly writer: string;
}

export class AtomWriterConflictError extends Error {
  readonly code = "GLIAL_ATOM_SECOND_WRITER";

  constructor(
    readonly atomId: string,
    readonly declaredWriter: string,
    readonly attemptedWriter: string,
  ) {
    super(
      `atom ${JSON.stringify(atomId)} is owned by ${JSON.stringify(declaredWriter)}; `
      + `second writer ${JSON.stringify(attemptedWriter)} rejected`,
    );
    this.name = "AtomWriterConflictError";
  }
}

/** Explicit Glial adapter over the canonical Taut atom engine. */
export class GlialAtomAdapter {
  readonly shape = "atom" as const;
  readonly contractVersion = "atom.oracle/v1" as const;
  private readonly node = new AtomNode({ stopWhen: "explicit_only" });

  dispatch(input: AtomInput): readonly AtomOutput[] {
    return this.node.handle(input);
  }

  replace(payload: Uint8Array): readonly AtomOutput[] {
    return this.dispatch({ type: "replace", payload });
  }

  read(
    atomId: string,
    streamId: string,
    version: bigint,
  ): readonly AtomOutput[] {
    return this.dispatch({
      type: "read",
      atom_id: atomId,
      stream_id: streamId,
      version: { version },
      timeout_ms: 0n,
    });
  }

  endStream(atomId: string, streamId: string): readonly AtomOutput[] {
    return this.dispatch({ type: "end_stream", atom_id: atomId, stream_id: streamId });
  }
}

export interface ProviderStatusWriter {
  replace(payload: Uint8Array): void;
}

export class ProviderStatusAtom {
  readonly adapter = new GlialAtomAdapter();

  constructor(readonly declaration: AtomSurfaceDeclaration) {}

  writer(writerId: string): ProviderStatusWriter {
    if (writerId !== this.declaration.writer) {
      throw new AtomWriterConflictError(
        this.declaration.id,
        this.declaration.writer,
        writerId,
      );
    }
    return { replace: (payload) => void this.adapter.replace(payload) };
  }

  reconnect(
    streamId: string,
    lastVersion: bigint,
  ): ReadResponse {
    const response = this.adapter
      .read(this.declaration.id, streamId, lastVersion)
      .find((output): output is ReadResponse => output.type === "read_response");
    if (response === undefined) {
      throw new Error("provider-status probe unexpectedly produced no response");
    }
    return response;
  }
}

/** Declaration registry enforcing one writer before a service starts. */
export class ProviderStatusAtomRegistry {
  private readonly atoms = new Map<string, ProviderStatusAtom>();

  declare(declaration: AtomSurfaceDeclaration): ProviderStatusAtom {
    const existing = this.atoms.get(declaration.id);
    if (existing !== undefined) {
      if (existing.declaration.writer !== declaration.writer) {
        throw new AtomWriterConflictError(
          declaration.id,
          existing.declaration.writer,
          declaration.writer,
        );
      }
      return existing;
    }
    const atom = new ProviderStatusAtom(Object.freeze({ ...declaration }));
    this.atoms.set(declaration.id, atom);
    return atom;
  }
}
