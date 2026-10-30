/** Re-bound scrubbed transcript fields and both JSON wire/JSONB text budgets. */
export function boundTaskTranscript(entry) {
  const clip = (text, max, tail = false) => {
    if (max <= 0) return '';
    const b = Buffer.from(text);
    return (tail ? b.subarray(-max) : b.subarray(0, max))
      .toString('utf8')
      .replace(tail ? /^\uFFFD+/ : /\uFFFD+$/, '');
  };
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
