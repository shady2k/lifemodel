/** Safe loader-to-browser status for the durable workbench import task. */
export type WorkbenchImportStep =
  | 'preparation'
  | 'source-manifest'
  | 'source-blob'
  | 'source-authentication'
  | 'destination-check'
  | 'destination-upload'
  | 'destination-manifest-write'
  | 'read-back-verify';
export interface WorkbenchImportDetail {
  step: WorkbenchImportStep;
  side: 'source' | 'destination';
  digest?: string;
  status?: number;
  sourceOrigin?: string;
  sourceRepository?: string;
  errorName?: string;
  errorCode?: string;
}
export interface WorkbenchImportStatus {
  state: 'pending' | 'importing' | 'ready' | 'failed';
  pinnedDigest: string;
  lastAttemptAt: number | null;
  reason?: string;
  detail?: WorkbenchImportDetail;
}
