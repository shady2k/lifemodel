/** State and freshness exposed to the web module. */
export type CreatureState = 'thinking' | 'awake' | 'asleep';

export interface CreatureStateSnapshot {
  state: CreatureState;
  epoch: number;
  publishedAt: number;
  ageMs: number;
}

/** The web-facing operation for reading the creature's current fresh state. */
export interface CreatureStateReader {
  readCreatureState(): Promise<CreatureStateSnapshot | null>;
}
