/**
 * Response doubles for the two status readers' resource-ownership tests: a
 * body that never ends, a body that stalls after its first part, a body far
 * larger than the reader's byte bound — each reporting whether it was
 * cancelled — and a fetch double that reports whether the request's own
 * signal was aborted.
 */
export interface CancellableResponse {
  response: Response;
  /** Whether the reader cancelled this response's body. */
  cancelled(): boolean;
}

function trackedBody(
  parts: { chunk: Uint8Array | undefined; slow: boolean }[],
  repeat: Uint8Array | undefined
): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < parts.length) {
        const part = parts[index++]!;
        if (part.chunk !== undefined) controller.enqueue(part.chunk);
        if (part.slow) return new Promise<void>(() => undefined);
        return;
      }
      if (repeat !== undefined) controller.enqueue(repeat);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A status response whose body sends nothing and never ends. */
export function neverEndingResponse(status: number): CancellableResponse {
  const { body, cancelled } = trackedBody([{ chunk: undefined, slow: true }], undefined);
  return { response: new Response(body, { status }), cancelled };
}

/** A status response that sends `first` and then never sends or ends again. */
export function stallingResponse(status: number, first: string): CancellableResponse {
  const { body, cancelled } = trackedBody([{ chunk: encode(first), slow: true }], undefined);
  return { response: new Response(body, { status }), cancelled };
}

/**
 * A status response far past a reader's byte bound: `chunks` parts of
 * `chunkBytes` bytes, ending after them. A reader that stops at its bound must
 * cancel the body before it is exhausted.
 */
export function overlongResponse(
  status: number,
  chunkBytes: number,
  chunks: number
): CancellableResponse {
  const filler = 'x'.repeat(chunkBytes);
  const parts = Array.from({ length: chunks }, () => ({ chunk: encode(filler), slow: false }));
  const { body, cancelled } = trackedBody(parts, undefined);
  return { response: new Response(body, { status }), cancelled };
}

export interface AbortTrackingFetch {
  fetch: typeof fetch;
  aborted(): boolean;
  calls(): number;
}

/** A fetch double that records whether its request signal was ever aborted. */
export function abortTrackingFetch(
  inner: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): AbortTrackingFetch {
  let aborted = false;
  let calls = 0;
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls += 1;
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return await inner(input, init);
    }) as typeof fetch,
    aborted: () => aborted,
    calls: () => calls,
  };
}
