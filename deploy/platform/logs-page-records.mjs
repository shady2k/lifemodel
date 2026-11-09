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
