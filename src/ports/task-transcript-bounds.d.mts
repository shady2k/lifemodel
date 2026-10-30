export function boundTaskTranscript<
  T extends {
    text: string;
    tool: { name: string; outputTail: string } | null;
  },
>(entry: T): T;
