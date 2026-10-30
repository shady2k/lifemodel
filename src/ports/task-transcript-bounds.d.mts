export function boundTaskTranscript<
  T extends {
    text: string;
    tool: { name: string; input?: string; outputTail: string } | null;
  },
>(entry: T, raw?: boolean): T;

export function transcriptRunSlice(text: string, max: number, tail?: boolean): string;

export function transcriptSlice(
  text: string,
  max: number,
  tail?: boolean
): { text: string; consumed: number };
