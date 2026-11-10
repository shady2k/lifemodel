// The records the logs page draws, as the page identifies them (WALK-LOGS-PAGE,
// ADR-016 §4, PRA-001).
//
// One drawn record is three things the store's own fields determine: its <time>
// line, whose `dateTime` is the record's `_time`; its module chip; and its
// message. Message text alone cannot tell records apart - "collector heartbeat"
// and CoreDNS's "[WARNING] No files matching import glob pattern" repeat every
// few seconds on the VM - so a page compared by message alone calls an honest
// second page a duplicate of the first. The identity below is exactly what the
// record element shows.

/** The page's own page size (loader/src/logs-query.ts, LOGS_PAGE_SIZE). */
export const PAGE_SIZE = 200;

/** One identity from a drawn entry or from an API record: time, module, message. */
export function identityOf({ time, module, message }) {
  return {
    time: typeof time === 'string' ? time : '',
    module: typeof module === 'string' ? module : '',
    message: typeof message === 'string' ? message.trim() : '',
  };
}

/** An API record's identity, in the loader's own record shape. */
export function identityOfAnswer(record) {
  return identityOf({
    time: record?.time,
    module: record?.fields?.module,
    message: record?.message,
  });
}

/** Whether two identities are the same record as the page draws it. */
export function sameIdentity(left, right) {
  return Boolean(
    left
      && right
      && left.time === right.time
      && left.module === right.module
      && left.message === right.message
  );
}

/** The identity the page draws, as one key: its time, module and message. */
export function identityKey(entry) {
  const value = identityOf(entry ?? {});
  return [value.time, value.module, value.message].join('\u0000');
}

/** How many times each drawn identity appears in a list of drawn entries. */
export function identityCounts(entries) {
  const counts = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = identityKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The store's rows for each identity the page draws.
 *
 * `rows` counts every stored record with that time, module and message;
 * `identities` counts each full stored identity (time, module, pod, message),
 * so a collector replay of one record is two rows of one identity (ADR-016 §6).
 */
export function storedIdentityCounts(records) {
  const counts = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const time = typeof record?.time === 'string' ? record.time : '';
    const module = typeof record?.fields?.module === 'string' ? record.fields.module : '';
    const pod = typeof record?.fields?.pod === 'string' ? record.fields.pod : '';
    const message = typeof record?.message === 'string' ? record.message.trim() : '';
    const key = [time, module, message].join('\u0000');
    const entry = counts.get(key) ?? { rows: 0, identities: new Map() };
    entry.rows += 1;
    const full = [time, module, pod, message].join('\u0000');
    entry.identities.set(full, (entry.identities.get(full) ?? 0) + 1);
    counts.set(key, entry);
  }
  return counts;
}

/**
 * The drawn identities the store does not explain, by how many times the page
 * draws one against how many rows the store holds. A record the store holds
 * twice is drawn on two pages legitimately: the collector replays at least once.
 */
export function overDrawnIdentities(drawn, repeated, stored) {
  const seen = new Set();
  const over = [];
  for (const entry of Array.isArray(repeated) ? repeated : []) {
    const key = identityKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    const drawnCount = drawn instanceof Map ? (drawn.get(key) ?? 0) : 0;
    const storedCount = stored instanceof Map ? (stored.get(key)?.rows ?? 0) : 0;
    if (drawnCount > storedCount) over.push({ entry, drawn: drawnCount, stored: storedCount });
  }
  return over;
}

/** The appended records whose identity the first page already holds. */
export function repeatedRecords(first, appended) {
  return appended.filter((entry) => first.some((held) => sameIdentity(held, entry)));
}

/** One identity in a failure line: the three drawn fields, the message bounded. */
export function describeIdentity(entry) {
  if (!entry) return 'no record';
  const message = entry.message.length > 80 ? `${entry.message.slice(0, 77)}...` : entry.message;
  return `${entry.time} | ${entry.module} | ${message}`;
}

/**
 * axe-core's violations as rule id, impact and each node's CSS target selector.
 * The node's `failureSummary` carries the page's text, and is never included.
 */
export function axeSummary(results) {
  const violations = Array.isArray(results?.violations) ? results.violations : [];
  return violations.map((rule) => {
    const nodes = Array.isArray(rule?.nodes) ? rule.nodes : [];
    return {
      id: typeof rule?.id === 'string' ? rule.id : 'unknown',
      impact: typeof rule?.impact === 'string' ? rule.impact : 'unknown',
      count: nodes.length,
      targets: nodes
        .map((node) => (Array.isArray(node?.target) ? node.target.join(' >>> ') : ''))
        .map((target) => target.trim())
        .filter((target) => target !== ''),
    };
  });
}

/** The modules a filter's option list is missing, by name. */
export function missingModules(options, modules) {
  const names = new Set(
    (Array.isArray(options) ? options : [])
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry !== '')
  );
  return (Array.isArray(modules) ? modules : []).filter(
    (module) => typeof module === 'string' && module !== '' && !names.has(module)
  );
}
