/**
 * An input the loader needs and does not have (lifemodel-q4x.2.1).
 *
 * It is never worked around: the loader says in one line what is missing and
 * why it matters, and never falls back to something else quietly.
 *
 * Where it is raised decides what happens next (rework 1). The loader's OWN
 * inputs - a volume it cannot prepare, its port, the front door, and the code
 * the image carries while the volume holds no repository yet - are checked
 * before it serves, and end the process with a non-zero code. A failure of the
 * instance instead (a seed, a build, a start) reaches the bootstrap, which
 * keeps the loader up with its interface and records the reason in its state.
 */
export class LoaderFatalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LoaderFatalError';
  }
}
