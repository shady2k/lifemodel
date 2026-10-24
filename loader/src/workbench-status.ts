/** Safe loader-to-browser status for the durable workbench import task. */
export interface WorkbenchImportStatus {
  state: 'pending' | 'importing' | 'ready' | 'failed';
  pinnedDigest: string;
  lastAttemptAt: number | null;
  reason?: string;
}
