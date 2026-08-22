/** A real bounded live-metrics consumer of `stream.oracle/v1`.
 *
 * Metrics are disposable: readers join at the current head, explicitly see a
 * `slow_consumer` drop if they fall behind the ring, and reconnect as a new
 * late join without replaying the lost interval.
 */

import {
  StreamNode,
  type StreamInput,
  type StreamOutput,
} from "@owebeeone/taut-shape";

type ReadResponse = Extract<StreamOutput, { readonly type: "read_response" }>;

export interface StreamSurfaceDeclaration {
  readonly id: string;
  readonly shape: "stream";
  readonly writer: string;
  readonly capacityRecords: number;
}

export class StreamWriterConflictError extends Error {
  readonly code = "GLIAL_STREAM_SECOND_WRITER";

  constructor(
    readonly streamId: string,
    readonly declaredWriter: string,
    readonly attemptedWriter: string,
  ) {
    super(
      `stream ${JSON.stringify(streamId)} is owned by ${JSON.stringify(declaredWriter)}; `
      + `second writer ${JSON.stringify(attemptedWriter)} rejected`,
    );
    this.name = "StreamWriterConflictError";
  }
}

/** Explicit Glial adapter over the canonical bounded stream engine. */
export class GlialStreamAdapter {
  readonly shape = "stream" as const;
  readonly contractVersion = "stream.oracle/v1" as const;
  private readonly node: StreamNode;

  constructor(capacityRecords: number) {
    this.node = new StreamNode({ capacityRecords, stopWhen: "explicit_only" });
  }

  dispatch(input: StreamInput): readonly StreamOutput[] {
    return this.node.handle(input);
  }

  push(payload: Uint8Array): readonly StreamOutput[] {
    return this.dispatch({ type: "push", payload });
  }

  read(streamId: string): ReadResponse {
    const response = this.dispatch({
      type: "read",
      stream_id: streamId,
      max_records: null,
      max_bytes: null,
      timeout_ms: 0n,
    }).find((output): output is ReadResponse => output.type === "read_response");
    if (response === undefined) throw new Error("live-metrics probe unexpectedly held");
    return response;
  }
}

export interface LiveMetricsWriter {
  publish(payload: Uint8Array): void;
}

export class LiveMetricsReader {
  lossCount = 0;
  connected = true;

  constructor(
    private readonly adapter: GlialStreamAdapter,
    readonly streamId: string,
  ) {}

  poll(): ReadResponse {
    const response = this.adapter.read(this.streamId);
    if (response.state === "dropped") {
      this.lossCount += 1;
      this.connected = false;
    }
    return response;
  }

  /** Rejoin at the current head. Lost records are deliberately not replayed. */
  reconnect(): ReadResponse {
    this.connected = true;
    return this.poll();
  }
}

export class LiveMetricsStream {
  readonly adapter: GlialStreamAdapter;

  constructor(readonly declaration: StreamSurfaceDeclaration) {
    this.adapter = new GlialStreamAdapter(declaration.capacityRecords);
  }

  writer(writerId: string): LiveMetricsWriter {
    if (writerId !== this.declaration.writer) {
      throw new StreamWriterConflictError(
        this.declaration.id,
        this.declaration.writer,
        writerId,
      );
    }
    return { publish: (payload) => void this.adapter.push(payload) };
  }

  reader(streamId: string): LiveMetricsReader {
    return new LiveMetricsReader(this.adapter, streamId);
  }
}

export class LiveMetricsStreamRegistry {
  private readonly streams = new Map<string, LiveMetricsStream>();

  declare(declaration: StreamSurfaceDeclaration): LiveMetricsStream {
    const existing = this.streams.get(declaration.id);
    if (existing !== undefined) {
      if (existing.declaration.writer !== declaration.writer) {
        throw new StreamWriterConflictError(
          declaration.id,
          existing.declaration.writer,
          declaration.writer,
        );
      }
      if (existing.declaration.capacityRecords !== declaration.capacityRecords) {
        throw new Error(`stream ${JSON.stringify(declaration.id)} capacity cannot change`);
      }
      return existing;
    }
    const stream = new LiveMetricsStream(Object.freeze({ ...declaration }));
    this.streams.set(declaration.id, stream);
    return stream;
  }
}
