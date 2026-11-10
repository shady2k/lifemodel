/** Failure evidence must never include an SDK message or response body (ADR-016 §9). */
export function modelErrorFields(error: unknown): {
  errorType: string;
  statusCode: number | undefined;
  code: string | undefined;
  retryable: boolean;
} {
  const value =
    error instanceof Error
      ? (error as Error & {
          statusCode?: number;
          code?: string;
          retryable?: boolean;
          isRetryable?: boolean;
        })
      : undefined;
  return {
    errorType: value?.name ?? 'Unknown',
    statusCode: value?.statusCode,
    code: value?.code,
    retryable: value?.retryable ?? value?.isRetryable ?? false,
  };
}

export function modelErrorMessage(error: unknown): string {
  const fields = modelErrorFields(error);
  return `${fields.errorType}${fields.statusCode === undefined ? '' : ` HTTP ${String(fields.statusCode)}`}${fields.code === undefined ? '' : ` (${fields.code})`}; retryable=${String(fields.retryable)}`;
}
