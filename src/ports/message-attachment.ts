/** Durable message references only. Bytes and storage URLs never enter a transcript. */
export interface MessageAttachment {
  /** Storage-module object UUID, not a task id or a storage path. */
  artifactId: string;
  name: string;
  size: number;
  contentType: string;
}

/** Separate from TranscriptReader so read-only transcript clients need no new operation. */
export interface AttachmentAuthorizer {
  /** Resolve only an attachment on a visible assistant message for this recipient. */
  findAttachment(artifactId: string): Promise<MessageAttachment | null>;
}

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_FIELDS = new Set(['artifactId', 'name', 'size', 'contentType']);
const MAX_ATTACHMENTS = 20;
const MAX_NAME_BYTES = 1024;
const MAX_CONTENT_TYPE_LENGTH = 128;
// Bare RFC 6838 type/subtype, without parameters, whitespace or wildcards.
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && ARTIFACT_ID.test(value);
}

/** Validate at each write boundary, returning a detached metadata-only copy. */
export function validateMessageAttachments(
  value: unknown,
  role: string
): MessageAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (role !== 'assistant') throw new Error('Message attachments require an assistant role');
  if (!Array.isArray(value)) throw new Error('Message attachments must be an array');
  if (value.length > MAX_ATTACHMENTS) throw new Error('Message attachments exceed the limit of 20');
  return Array.from(value, (entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new Error('Message attachment metadata must be an object');
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).some((key) => !ATTACHMENT_FIELDS.has(key)) ||
      !isArtifactId(item['artifactId']) ||
      typeof item['name'] !== 'string' ||
      item['name'].length === 0 ||
      item['name'].length > MAX_NAME_BYTES ||
      !item['name'].isWellFormed() ||
      Buffer.byteLength(item['name'], 'utf8') > MAX_NAME_BYTES ||
      typeof item['size'] !== 'number' ||
      !Number.isSafeInteger(item['size']) ||
      item['size'] < 0 ||
      typeof item['contentType'] !== 'string' ||
      item['contentType'].length > MAX_CONTENT_TYPE_LENGTH ||
      /[\r\n]/.test(item['contentType']) ||
      !CONTENT_TYPE.test(item['contentType'])
    ) {
      throw new Error('Message attachment metadata is malformed');
    }
    return {
      artifactId: item['artifactId'].toLowerCase(),
      name: item['name'],
      size: item['size'],
      contentType: item['contentType'],
    };
  });
}
