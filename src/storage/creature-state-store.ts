import type { Redis } from 'iovalkey';
import type {
  CreatureState,
  CreatureStateReader,
  CreatureStateSnapshot,
} from '../ports/creature-state.js';

export const CREATURE_STATE_KEY = 'lifemodel:creature:state';
export const CREATURE_STATE_TTL_SECONDS = 15;
export const CREATURE_STATE_HEARTBEAT_MS = 5_000;

const PUBLISH_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  if tonumber(decoded.epoch) > tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

interface PublishedCreatureState {
  state: CreatureState;
  epoch: number;
  publishedAt: number;
}

/** Stores the short-lived state projection independently of the core snapshot. */
export class CreatureStateStore implements CreatureStateReader {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now
  ) {}

  async publishCreatureState(state: CreatureState, epoch: number): Promise<void> {
    if (!['thinking', 'awake', 'asleep'].includes(state)) {
      throw new Error(`Invalid creature state: ${state}`);
    }
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error('Creature state epoch must be a positive integer');
    const published: PublishedCreatureState = { state, epoch, publishedAt: this.now() };
    await this.redis.eval(
      PUBLISH_SCRIPT,
      1,
      CREATURE_STATE_KEY,
      String(epoch),
      JSON.stringify(published),
      String(CREATURE_STATE_TTL_SECONDS)
    );
  }

  async readCreatureState(): Promise<CreatureStateSnapshot | null> {
    const raw = await this.redis.get(CREATURE_STATE_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      !['thinking', 'awake', 'asleep'].includes((value as PublishedCreatureState).state) ||
      !Number.isSafeInteger((value as PublishedCreatureState).epoch) ||
      !Number.isFinite((value as PublishedCreatureState).publishedAt)
    ) {
      throw new Error('Invalid published creature state');
    }
    const published = value as PublishedCreatureState;
    const ageMs = this.now() - published.publishedAt;
    if (ageMs < 0 || ageMs > CREATURE_STATE_TTL_SECONDS * 1_000) return null;
    return { ...published, ageMs };
  }

  async deleteCreatureState(): Promise<void> {
    await this.redis.del(CREATURE_STATE_KEY);
  }
}

export function createCreatureStateStore(redis: Redis): CreatureStateStore {
  return new CreatureStateStore(redis);
}
