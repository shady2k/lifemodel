/**
 * Base person interface.
 *
 * Represents any person the agent knows about.
 * User extends this with more detailed tracking.
 */
export interface Person {
  /** Unique identifier */
  id: string;

  /** Person's name */
  name: string;

  /** Known personality traits */
  traits: string[];

  /** Topics associated with this person */
  topics: string[];

  /** When this person was last mentioned/interacted with */
  lastMentioned: Date;
}

/**
 * Create a new person with defaults.
 */
export function createPerson(id: string, name: string): Person {
  return {
    id,
    name,
    traits: [],
    topics: [],
    lastMentioned: new Date(),
  };
}
