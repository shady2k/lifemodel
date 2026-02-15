/**
 * Test factories for creating test data.
 */

import { vi } from 'vitest';
import type { AgentState } from '../../src/types/agent/state.js';
import type { SignalAggregate, Signal } from '../../src/types/signal.js';
import { createSignal } from '../../src/types/signal.js';
import { Priority } from '../../src/types/priority.js';
import type { Logger } from '../../src/types/logger.js';
import { createAgent, type Agent } from '../../src/core/agent.js';
import { createMetrics } from '../../src/core/metrics.js';
import type { SkillPolicy, SkillStatus } from '../../src/runtime/skills/skill-types.js';
import type { LoadedSkill } from '../../src/runtime/skills/skill-types.js';

/**
 * Create a mock logger that captures all log calls.
 */
export function createMockLogger(): Logger & {
  calls: Record<string, unknown[][]>;
  reset: () => void;
} {
  const calls: Record<string, unknown[][]> = {
    trace: [],
    debug: [],
    info: [],
    warn: [],
    error: [],
  };

  const logger = {
    trace: vi.fn((...args: unknown[]) => calls.trace.push(args)),
    debug: vi.fn((...args: unknown[]) => calls.debug.push(args)),
    info: vi.fn((...args: unknown[]) => calls.info.push(args)),
    warn: vi.fn((...args: unknown[]) => calls.warn.push(args)),
    error: vi.fn((...args: unknown[]) => calls.error.push(args)),
    child: () => logger,
    calls,
    reset: () => {
      calls.trace = [];
      calls.debug = [];
      calls.info = [];
      calls.warn = [];
      calls.error = [];
      vi.clearAllMocks();
    },
  };

  return logger as Logger & { calls: Record<string, unknown[][]>; reset: () => void };
}

/**
 * Create agent state with sensible defaults.
 */
export function createAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    energy: 0.8,
    socialDebt: 0.3,
    taskPressure: 0,
    curiosity: 0.5,
    acquaintancePressure: 0,
    acquaintancePending: false,
    thoughtPressure: 0,
    pendingThoughtCount: 0,
    lastTickAt: new Date(),
    tickInterval: 1000,
    ...overrides,
  };
}

/**
 * Create a contact pressure aggregate.
 */
export function createContactPressureAggregate(
  currentValue: number,
  overrides: Partial<SignalAggregate> = {}
): SignalAggregate {
  return {
    type: 'contact_pressure',
    source: 'neuron.contact_pressure',
    currentValue,
    rateOfChange: 0,
    count: 1,
    maxValue: currentValue,
    minValue: currentValue,
    avgValue: currentValue,
    trend: 'stable',
    ...overrides,
  };
}

/**
 * Create a user message signal.
 */
export function createUserMessageSignal(
  text: string,
  chatId = '123',
  userId = '456'
): Signal {
  return createSignal(
    'user_message',
    'sense.telegram',
    { value: 1, confidence: 1 },
    {
      priority: Priority.HIGH,
      data: {
        kind: 'user_message',
        text,
        chatId,
        userId,
      },
    }
  );
}

/**
 * Create a pattern break signal.
 */
export function createPatternBreakSignal(
  patternName: string,
  description: string
): Signal {
  return createSignal(
    'pattern_break',
    'meta.pattern_detector',
    { value: 0.8, confidence: 0.8 },
    {
      priority: Priority.NORMAL,
      data: {
        kind: 'pattern',
        patternName,
        description,
      },
    }
  );
}

/**
 * Create a mock conversation manager.
 */
export function createMockConversationManager(options: {
  status?: 'active' | 'closed' | 'awaiting_answer' | 'idle';
  lastMessageAt?: Date | null;
} = {}) {
  const { status = 'active', lastMessageAt = new Date(Date.now() - 2 * 60 * 60 * 1000) } = options;

  return {
    getStatus: vi.fn().mockResolvedValue({
      status,
      lastMessageAt,
    }),
  };
}

/**
 * Create a mock user model.
 */
export function createMockUserModel(beliefs: {
  energy?: number;
  availability?: number;
  mood?: string;
} = {}) {
  const { energy = 0.7, availability = 0.7, mood = 'neutral' } = beliefs;

  return {
    getBeliefs: vi.fn().mockReturnValue({
      energy,
      availability,
      mood,
    }),
  };
}

/**
 * Create a mock channel for testing message sending.
 */
export function createMockChannel(options: {
  name?: string;
  sendSuccess?: boolean;
  isAvailable?: boolean;
} = {}) {
  const { name = 'telegram', sendSuccess = true, isAvailable = true } = options;

  return {
    name,
    isAvailable: vi.fn().mockReturnValue(isAvailable),
    sendMessage: vi.fn().mockResolvedValue(sendSuccess),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock recipient registry for testing recipient resolution.
 */
export function createMockRecipientRegistry(options: {
  channel?: string;
  destination?: string;
  resolveSuccess?: boolean;
} = {}) {
  const { channel = 'telegram', destination = '123456', resolveSuccess = true } = options;

  return {
    resolve: vi.fn().mockReturnValue(
      resolveSuccess ? { channel, destination } : null
    ),
    register: vi.fn(),
    unregister: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  };
}

/**
 * Create a test agent with mocked dependencies.
 * Returns both the agent and mocked dependencies for verification.
 */
export function createTestAgent(options: {
  initialState?: Partial<AgentState>;
} = {}): { agent: Agent; logger: ReturnType<typeof createMockLogger>; metrics: ReturnType<typeof createMetrics> } {
  const logger = createMockLogger();
  const metrics = createMetrics();

  const agent = createAgent(
    { logger: logger as any, metrics },
    { initialState: options.initialState }
  );

  return { agent, logger, metrics };
}

// ─── Skill & Policy Factories ───────────────────────────────────────

/** Minimal valid SKILL.md content. */
export const TEST_SKILL_MD = `---
name: test-skill
description: A test skill for testing
---
# Test Skill
Do something useful.
`;

/**
 * Create a v2 SkillPolicy with sensible defaults.
 * Single source of truth for policy schema in tests.
 */
export function createTestPolicy(overrides: Partial<SkillPolicy> & { status?: SkillStatus } = {}): SkillPolicy {
  return {
    schemaVersion: 2,
    status: 'approved',
    domains: ['api.example.com'],
    ...overrides,
  };
}

/**
 * Create a LoadedSkill for unit tests.
 * Policy defaults to approved with standard test domains.
 */
export function createTestLoadedSkill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    frontmatter: { name: 'test-skill', description: 'A test skill' },
    policy: createTestPolicy(),
    body: '# Test Skill\nDo something useful.',
    path: '/data/skills/test-skill',
    skillPath: '/data/skills/test-skill/SKILL.md',
    ...overrides,
  };
}
