import { isDeepStrictEqual } from 'node:util';

const KNOWN_FIELDS = [
  'Type',
  'Name',
  'Source',
  'Destination',
  'Driver',
  'Mode',
  'RW',
  'Propagation',
] as const;

type KnownField = typeof KNOWN_FIELDS[number];
type ChangedField = KnownField | 'otherFields';

export interface InstanceMountsComparison {
  equal: boolean;
  valid: boolean;
  sameCount: boolean;
  sameDestinationSet: boolean;
  changedFields: ChangedField[];
}

type MountRecord = Record<string, unknown> & {
  Type: string;
  Destination: string;
};

const knownFields: ReadonlySet<PropertyKey> = new Set(KNOWN_FIELDS);
const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function invalid(): InstanceMountsComparison {
  return {
    equal: false,
    valid: false,
    sameCount: false,
    sameDestinationSet: false,
    changedFields: [],
  };
}

/**
 * Accept only bounded, dense mount lists and plain data records.
 * Values and paths are never cleaned, coerced or rewritten.
 *
 * Null-prototype records are plain records too. A difference between null
 * and Object.prototype remains significant in the structural comparison.
 */
function sortedMounts(value: unknown): MountRecord[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    return undefined;
  }

  // Copying must not silently discard extra array properties or holes.
  const arrayKeys = Reflect.ownKeys(value);
  if (arrayKeys.length !== value.length + 1 ||
      !own(value, 'length')) {
    return undefined;
  }

  const destinations = new Set<string>();
  const records: MountRecord[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const slot = Object.getOwnPropertyDescriptor(value, String(index));
    if (slot === undefined || !('value' in slot) || !slot.enumerable) {
      return undefined;
    }

    const record: unknown = slot.value;
    if (record === null || typeof record !== 'object' ||
        Array.isArray(record)) {
      return undefined;
    }

    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }

    // Docker JSON contains enumerable data fields, not getters or hidden
    // properties. Reject those forms rather than silently omit their fields.
    for (const key of Reflect.ownKeys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined ||
          !('value' in descriptor) ||
          !descriptor.enumerable) {
        return undefined;
      }
    }

    const type = Object.getOwnPropertyDescriptor(record, 'Type');
    const destination = Object.getOwnPropertyDescriptor(record, 'Destination');

    if (type === undefined || !('value' in type) ||
        typeof type.value !== 'string' || type.value.length === 0 ||
        destination === undefined || !('value' in destination) ||
        typeof destination.value !== 'string' ||
        destination.value.length === 0 ||
        !destination.value.startsWith('/') ||
        destinations.has(destination.value)) {
      return undefined;
    }

    destinations.add(destination.value);
    records.push(record as MountRecord);
  }

  // Only the copied top-level list is sorted. Nested arrays stay untouched.
  return records.sort((left, right) =>
    left.Destination < right.Destination
      ? -1
      : left.Destination > right.Destination
        ? 1
        : 0,
  );
}

/** Internal diagnostic view only; never returned or logged. */
function otherFields(record: MountRecord): object {
  const result: object = Object.create(Object.getPrototypeOf(record));
  for (const key of Reflect.ownKeys(record)) {
    if (!knownFields.has(key)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor !== undefined) {
        Object.defineProperty(result, key, descriptor);
      }
    }
  }
  return result;
}

/**
 * Compare complete records as a Destination-keyed set.
 *
 * Only top-level mount-list order is ignored. Equality uses the complete
 * records, including unknown fields, prototypes and nested array order.
 * Diagnostics contain only fixed public field names and booleans.
 */
export function compareInstanceMounts(
  left: unknown,
  right: unknown,
): InstanceMountsComparison {
  try {
    const leftMounts = sortedMounts(left);
    const rightMounts = sortedMounts(right);
    if (leftMounts === undefined || rightMounts === undefined) {
      return invalid();
    }

    const sameCount = leftMounts.length === rightMounts.length;
    const sameDestinationSet = sameCount && leftMounts.every(
      (record, index) =>
        record.Destination === rightMounts[index]?.Destination,
    );

    // Never use a diagnostic projection to decide equality.
    const equal = isDeepStrictEqual(leftMounts, rightMounts);
    const changed = new Set<ChangedField>();

    if (!sameDestinationSet) {
      changed.add('Destination');
    }

    const rightByDestination = new Map(
      rightMounts.map(record => [record.Destination, record] as const),
    );

    for (const leftRecord of leftMounts) {
      const rightRecord = rightByDestination.get(leftRecord.Destination);
      if (rightRecord === undefined) continue;

      for (const field of KNOWN_FIELDS) {
        if (own(leftRecord, field) !== own(rightRecord, field) ||
            !isDeepStrictEqual(leftRecord[field], rightRecord[field])) {
          changed.add(field);
        }
      }

      if (!isDeepStrictEqual(
        otherFields(leftRecord),
        otherFields(rightRecord),
      )) {
        changed.add('otherFields');
      }
    }

    return {
      equal,
      valid: true,
      sameCount,
      sameDestinationSet,
      changedFields: [
        ...KNOWN_FIELDS.filter(field => changed.has(field)),
        ...(changed.has('otherFields') ? ['otherFields' as const] : []),
      ],
    };
  } catch {
    // Malformed inputs, including throwing reflection traps, fail closed.
    // Never expose the input or an exception message.
    return invalid();
  }
}
