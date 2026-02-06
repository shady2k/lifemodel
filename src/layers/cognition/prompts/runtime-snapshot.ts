/**
 * Runtime Snapshot Helpers
 *
 * Determines when and what runtime state to include in prompts.
 * Pure functions — no state mutation.
 */

import type { Signal } from '../../../types/signal.js';
import type { LoopContext } from '../agentic-loop-types.js';

export function shouldIncludeRuntimeSnapshot(context: LoopContext, useSmart: boolean): boolean {
  const { agentState, userModel } = context;
  const triggerText = getTriggerText(context.triggerSignal);
  const isProactive = isProactiveTrigger(context.triggerSignal);
  const isQuery = triggerText ? isStateQuery(triggerText) : false;

  const agentExtreme =
    agentState.energy < 0.35 ||
    agentState.energy > 0.85 ||
    agentState.socialDebt > 0.6 ||
    agentState.taskPressure > 0.6 ||
    agentState.acquaintancePressure > 0.6;

  const userEnergy = asNumber(userModel['energy']);
  const userAvailability = asNumber(userModel['availability']);
  const userExtreme =
    (userEnergy !== null && userEnergy < 0.35) ||
    (userAvailability !== null && userAvailability < 0.35);

  if (isProactive || isQuery || agentExtreme || userExtreme) {
    return true;
  }

  // Cheap models benefit from more frequent state grounding (lower thresholds).
  if (!useSmart) {
    const cheapAgentExtreme =
      agentState.energy < 0.45 ||
      agentState.energy > 0.55 ||
      agentState.socialDebt > 0.45 ||
      agentState.taskPressure > 0.45;
    if (cheapAgentExtreme) return true;
  }

  return false;
}

export interface RuntimeSnapshotScope {
  includeAgentEnergy: boolean;
  includeSocialDebt: boolean;
  includeTaskPressure: boolean;
  includeCuriosity: boolean;
  includeAcquaintancePressure: boolean;
  includeUserEnergy: boolean;
  includeUserAvailability: boolean;
}

export function getRuntimeSnapshotScope(
  context: LoopContext,
  triggerText: string | null
): RuntimeSnapshotScope {
  const isProactive = isProactiveTrigger(context.triggerSignal);
  const isQuery = triggerText ? isStateQuery(triggerText) : false;
  const isUserQuery = triggerText ? isUserStateQuery(triggerText) : false;

  if (isQuery || isProactive) {
    return {
      includeAgentEnergy: true,
      includeSocialDebt: true,
      includeTaskPressure: true,
      includeCuriosity: isQuery,
      includeAcquaintancePressure: isProactive,
      includeUserEnergy: isUserQuery,
      includeUserAvailability: isUserQuery,
    };
  }

  const userEnergy = asNumber(context.userModel['energy']);
  const userAvailability = asNumber(context.userModel['availability']);

  return {
    includeAgentEnergy: context.agentState.energy < 0.35 || context.agentState.energy > 0.85,
    includeSocialDebt: context.agentState.socialDebt > 0.6,
    includeTaskPressure: context.agentState.taskPressure > 0.6,
    includeCuriosity: context.agentState.curiosity > 0.8,
    includeAcquaintancePressure: context.agentState.acquaintancePressure > 0.6,
    includeUserEnergy: userEnergy !== null && userEnergy < 0.35,
    includeUserAvailability: userAvailability !== null && userAvailability < 0.35,
  };
}

export function isStateQuery(text: string): boolean {
  return matchesAny(text, [
    /how are you/i,
    /are you (tired|sleepy|busy|stressed|overwhelmed|okay|ok)/i,
    /\b(tired|sleepy|energy|burned out|burnt out|overwhelmed|busy|stressed)\b/i,
    /как ты/i,
    /ты (устал|устала|уставш|сонн|занят|занята|перегруж|нормально)/i,
    /силы|энерг/i,
  ]);
}

export function isUserStateQuery(text: string): boolean {
  return matchesAny(text, [
    /am i (tired|ok|okay|stressed|overwhelmed)/i,
    /how am i/i,
    /do i seem/i,
    /я (устал|устала|уставш|перегруж|выспал|выспалась)/i,
    /мне (плохо|тяжело|нормально)/i,
  ]);
}

export function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function describeLevel(value: number): 'low' | 'medium' | 'high' {
  if (value <= 0.35) return 'low';
  if (value >= 0.7) return 'high';
  return 'medium';
}

export function getTriggerText(signal: Signal): string | null {
  if (signal.type !== 'user_message') return null;
  const data = signal.data as Record<string, unknown> | undefined;
  const text = typeof data?.['text'] === 'string' ? data['text'] : '';
  return text.trim().length > 0 ? text : null;
}

export function isProactiveTrigger(signal: Signal): boolean {
  if (signal.type !== 'threshold_crossed') return false;
  const data = signal.data as Record<string, unknown> | undefined;
  const thresholdName = typeof data?.['thresholdName'] === 'string' ? data['thresholdName'] : '';
  return thresholdName.includes('proactive') || thresholdName.includes('contact_urge');
}
