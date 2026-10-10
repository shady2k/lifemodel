import type {
  JourneyEvent as InstanceJourneyEvent,
} from './instance-journey-fixture.js';

export function hasAuthenticatedTelegramRequest(
  journal: readonly InstanceJourneyEvent[],
  response: { requestId?: number; seq: number },
  method: 'getUpdates' | 'sendMessage',
): boolean {
  if (
    !Number.isInteger(response.requestId) ||
    !Number.isFinite(response.requestId) ||
    !(response.requestId! > 0) ||
    !Number.isInteger(response.seq) ||
    !Number.isFinite(response.seq) ||
    response.seq <= 0
  ) {
    return false;
  }

  const requests = journal.filter(event =>
    event.event === 'telegram.request' &&
    event.requestId === response.requestId,
  );
  if (requests.length !== 1) return false;

  const request = requests[0]!;
  return (
    Number.isInteger(request.seq) &&
    Number.isFinite(request.seq) &&
    request.seq > 0 &&
    request.seq < response.seq &&
    request.method === method &&
    request.tokenMatch === true &&
    typeof request.actualHost === 'string' &&
    (request.actualHost === 'api.telegram.org' || request.actualHost === 'api.telegram.org:443')
  );
}
