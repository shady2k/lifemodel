/**
 * Base person interface.
 *
 * Represents any person the agent knows about.
 * User extends this with more detailed tracking.
 */
export interface Person {
  /** Unique identifier */
  id: string;

  /** Person's name (null if unknown) */
  name: string | null;

  /** Known personality traits */
  traits: string[];

  /** Topics associated with this person */
  topics: string[];

  /** When this person was last mentioned/interacted with */
  lastMentioned: Date;
}

/**
 * Check if we know the person's name.
 */
export function isNameKnown(person: Person): boolean {
  return person.name !== null && person.name.trim().length > 0;
}

/**
 * Create a new person with defaults.
 */
export function createPerson(id: string, name: string | null = null): Person {
  return {
    id,
    name,
    traits: [],
    topics: [],
    lastMentioned: new Date(),
  };
}
