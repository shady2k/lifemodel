export function boundTaskTranscript<
  T extends {
    text: string;
    tool: { name: string; input?: string; outputTail: string } | null;
  },
>(entry: T): T;

export function transcriptSlice(
  text: string,
  max: number,
  tail?: boolean
): { text: string; consumed: number };
