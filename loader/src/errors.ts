/**
 * The one error the loader stops for (lifemodel-q4x.2.1).
 *
 * A missing input - the seed bundle the image carries, a volume it cannot
 * write, a port already taken - is never worked around: the loader says in one
 * line what is missing and why it matters, and leaves with a non-zero code.
 */
export class LoaderFatalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LoaderFatalError';
  }
}
