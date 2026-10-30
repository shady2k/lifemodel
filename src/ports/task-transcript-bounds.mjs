import { Buffer } from 'node:buffer';
/**
 * Cut encoded UTF-8 only at code point boundaries. Real U+FFFD is content.
 * @param {string} text @param {number} max @param {boolean} [tail]
 */
export function transcriptSlice(text, max, tail = false) {
  const b = Buffer.from(text);
  let start = tail ? Math.max(0, b.length - Math.max(0, max)) : 0;
  let end = tail ? b.length : Math.min(b.length, Math.max(0, max));
  if (tail) {
    while (start < b.length && (b[start] & 0xc0) === 0x80) start++;
  } else {
    while (end > 0 && end < b.length && (b[end] & 0xc0) === 0x80) end--;
  }
  let consumed = 0;
  if (!tail) {
    let bytes = 0;
    for (const point of text) {
      bytes += Buffer.byteLength(point);
      if (bytes > end) break;
      consumed += point.length;
    }
  }
  return { text: b.subarray(start, end).toString('utf8'), consumed };
}
/**
 * Re-bound scrubbed transcript fields and both JSON wire/JSONB text budgets.
 * @param {{text: string, tool: {name: string, outputTail: string} | null}} entry
 */
export function boundTaskTranscript(entry) {
  /** @param {string} text @param {number} max @param {boolean} [tail] */
  const clip = (text, max, tail = false) =>
    transcriptSlice(text.replaceAll('\0', ''), max, tail).text;
  const value = {
    ...entry,
    text: clip(entry.text, 4000),
    tool: entry.tool
      ? {
          ...entry.tool,
          name: clip(entry.tool.name, 128),
          outputTail: clip(entry.tool.outputTail, 2000, true),
        }
      : null,
  };
  // PostgreSQL jsonb::text inserts spaces after separators. Reserving 256 bytes
  // covers this fixed shape, including worst-case escaping and metadata.
  while (Buffer.byteLength(JSON.stringify(value)) > 8192 - 256) {
    if (value.text.length)
      value.text = clip(value.text, Math.max(0, Buffer.byteLength(value.text) - 256));
    else if (value.tool?.outputTail.length)
      value.tool.outputTail = clip(
        value.tool.outputTail,
        Math.max(0, Buffer.byteLength(value.tool.outputTail) - 256),
        true
      );
    else throw new Error('invalid_transcript_size');
  }
  return value;
}
