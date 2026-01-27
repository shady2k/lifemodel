/**
 * SMART Layer
 *
 * Complex reasoning using expensive LLM.
 * Only called when COGNITION is uncertain.
 *
 * Like deep reasoning - engaged only when necessary,
 * as it's expensive in both time and resources.
 */

export { SmartProcessor, createSmartProcessor } from './processor.js';
export type { SmartProcessorConfig, SmartProcessorDeps } from './processor.js';

export { EscalationHandler, createEscalationHandler } from './escalation-handler.js';
export type { EscalationHandlerConfig, EscalationResult } from './escalation-handler.js';
