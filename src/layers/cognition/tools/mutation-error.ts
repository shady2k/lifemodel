/** A durable mutation may have committed; only a replay of the owned turn can resolve it. */
export class UncertainMutationError extends Error {
  constructor() {
    super('Durable mutation outcome uncertain');
    this.name = 'UncertainMutationError';
  }
}
