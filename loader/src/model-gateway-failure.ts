import type { GatewayError } from './model-gateway-response.js';
import type { ModelSlotName } from './model.js';

export function gatewayFailureFields(
  failure: GatewayError,
  slot: ModelSlotName | undefined,
  conversation: string | undefined
) {
  return {
    code: failure.code,
    error_type: failure.code,
    status: failure.upstreamStatus ?? failure.status,
    modelRoute: slot,
    slot,
    reason: failure.reason,
    ...(conversation !== undefined ? { conversation_id: conversation } : {}),
  };
}
