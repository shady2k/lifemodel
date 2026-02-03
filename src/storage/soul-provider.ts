/**
 * Soul Provider
 *
 * Manages persistence and loading of soul state.
 * Uses DeferredStorage for safe, batched writes.
 *
 * Key design:
 * - Soul state is persisted as a single JSON file for atomic saves
 * - Budget resets are handled automatically
 * - Migrations supported via version field
 * - Uses JSON.stringify/parse with Date handling (same as persistable-state.ts)
 */

import type { Storage } from './storage.js';
import type { Logger } from '../types/logger.js';
import type {
  SoulState,
  RevisionNote,
  LivingConstitution,
  CaseLaw,
  NarrativeLoom,
  SelfModel,
} from '../types/agent/soul.js';
import type { Parliament, Deliberation } from '../types/agent/parliament.js';
import type { SocraticEngine, UnanswerableCore, SelfQuestion } from '../types/agent/socratic.js';
import { createDefaultSoulState, SOUL_STATE_VERSION } from '../types/agent/soul.js';
import { createDefaultParliament } from '../types/agent/parliament.js';
import {
  createDefaultSocraticEngine,
  createDefaultUnanswerableCore,
} from '../types/agent/socratic.js';
import { dateReplacer, createDateReviver } from '../utils/date.js';

/**
 * Configuration for Soul Provider.
 */
export interface SoulProviderConfig {
  /** Storage interface (DeferredStorage recommended) */
  storage: Storage;
  /** Storage key for soul data */
  storageKey: string;
}

const DEFAULT_CONFIG: Omit<SoulProviderConfig, 'storage'> = {
  storageKey: 'soul',
};

/**
 * Extended soul state including Parliament and Socratic Engine.
 */
export interface FullSoulState extends SoulState {
  parliament: Parliament;
  socraticEngine: SocraticEngine;
  unanswerableCore: UnanswerableCore;
  deliberations: Deliberation[];
}

/**
 * Soul Provider - manages soul state persistence.
 */
export class SoulProvider {
  private readonly config: SoulProviderConfig;
  private readonly logger: Logger;
  private state: FullSoulState | null = null;
  private loaded = false;

  constructor(logger: Logger, config: SoulProviderConfig) {
    this.logger = logger.child({ component: 'soul-provider' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the loaded state (throws if not loaded - should never happen after ensureLoaded).
   */
  private getLoadedState(): FullSoulState {
    if (!this.state) {
      throw new Error('SoulProvider: state not loaded. Call ensureLoaded() first.');
    }
    return this.state;
  }

  /**
   * Get the current soul state (loads if needed).
   */
  async getState(): Promise<FullSoulState> {
    await this.ensureLoaded();
    return this.getLoadedState();
  }

  /**
   * Check if budget allows an operation.
   * Does NOT deduct tokens - call deductTokens after operation completes.
   */
  async canAfford(estimatedTokens: number): Promise<boolean> {
    await this.ensureLoaded();
    this.maybeResetBudget();
    return (
      this.getLoadedState().budget.tokensUsedToday + estimatedTokens <=
      this.getLoadedState().budget.dailyTokenLimit
    );
  }

  /**
   * Deduct tokens from daily budget.
   */
  async deductTokens(tokens: number): Promise<void> {
    await this.ensureLoaded();
    this.maybeResetBudget();
    this.getLoadedState().budget.tokensUsedToday += tokens;
    await this.persist();
  }

  /**
   * Check if reflection is allowed (respects cooldown).
   */
  async canReflect(): Promise<boolean> {
    await this.ensureLoaded();
    const budget = this.getLoadedState().budget;
    if (!budget.lastReflectionAt) return true;

    const elapsed = (Date.now() - budget.lastReflectionAt.getTime()) / 1000;
    return elapsed >= budget.reflectionCooldownSeconds;
  }

  /**
   * Record that a reflection was performed.
   */
  async recordReflection(): Promise<void> {
    await this.ensureLoaded();
    this.getLoadedState().budget.lastReflectionAt = new Date();
    await this.persist();
  }

  /**
   * Check if full audit is allowed (respects cooldown).
   */
  async canAudit(): Promise<boolean> {
    await this.ensureLoaded();
    const budget = this.getLoadedState().budget;
    if (!budget.lastAuditAt) return true;

    const elapsed = (Date.now() - budget.lastAuditAt.getTime()) / 1000;
    return elapsed >= budget.auditCooldownSeconds;
  }

  /**
   * Record that an audit was performed.
   */
  async recordAudit(): Promise<void> {
    await this.ensureLoaded();
    this.getLoadedState().budget.lastAuditAt = new Date();
    await this.persist();
  }

  /**
   * Add a revision note.
   */
  async addRevision(revision: RevisionNote): Promise<void> {
    await this.ensureLoaded();
    this.getLoadedState().revisions.push(revision);
    await this.persist();
    this.logger.debug({ revisionId: revision.id }, 'Revision note added');
  }

  /**
   * Add a deliberation.
   */
  async addDeliberation(deliberation: Deliberation): Promise<void> {
    await this.ensureLoaded();
    this.getLoadedState().deliberations.push(deliberation);
    // Keep only last 50 deliberations
    if (this.getLoadedState().deliberations.length > 50) {
      this.getLoadedState().deliberations = this.getLoadedState().deliberations.slice(-50);
    }
    await this.persist();
  }

  /**
   * Update constitution (with proper ceremony tracking).
   */
  async updateConstitution(updates: Partial<LivingConstitution>): Promise<void> {
    await this.ensureLoaded();
    Object.assign(this.getLoadedState().constitution, updates);
    this.getLoadedState().constitution.lastModifiedAt = new Date();
    await this.persist();
    this.logger.info('Constitution updated');
  }

  /**
   * Update self-model.
   */
  async updateSelfModel(updates: Partial<SelfModel>): Promise<void> {
    await this.ensureLoaded();
    Object.assign(this.getLoadedState().selfModel, updates);
    this.getLoadedState().selfModel.lastUpdatedAt = new Date();
    this.updateHealth();
    await this.persist();
  }

  /**
   * Update narrative.
   */
  async updateNarrative(updates: Partial<NarrativeLoom>): Promise<void> {
    await this.ensureLoaded();
    Object.assign(this.getLoadedState().narrative, updates);
    this.getLoadedState().narrative.currentNarrative.lastUpdatedAt = new Date();
    this.updateHealth();
    await this.persist();
  }

  /**
   * Add a precedent to case law.
   */
  async addPrecedent(precedent: CaseLaw['precedents'][0]): Promise<void> {
    await this.ensureLoaded();
    this.getLoadedState().caseLaw.precedents.push(precedent);

    // Prune if over max
    if (
      this.getLoadedState().caseLaw.precedents.length > this.getLoadedState().caseLaw.maxPrecedents
    ) {
      // Remove oldest non-binding precedents first
      const nonBinding = this.getLoadedState().caseLaw.precedents.filter((p) => !p.binding);
      nonBinding.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const toRemove = nonBinding[0];
      if (toRemove) {
        this.getLoadedState().caseLaw.precedents = this.getLoadedState().caseLaw.precedents.filter(
          (p) => p.id !== toRemove.id
        );
      }
    }

    await this.persist();
    this.logger.debug({ precedentId: precedent.id }, 'Precedent added');
  }

  /**
   * Update parliament voice (e.g., reliability, ledger).
   */
  async updateVoice(voiceId: string, updates: Partial<Parliament['voices'][0]>): Promise<void> {
    await this.ensureLoaded();
    const voice = this.getLoadedState().parliament.voices.find((v) => v.id === voiceId);
    if (voice) {
      Object.assign(voice, updates);
      await this.persist();
    }
  }

  /**
   * Add a self-question to Socratic Engine.
   */
  async addQuestion(question: SelfQuestion): Promise<void> {
    await this.ensureLoaded();

    // Enforce max active questions
    if (
      this.getLoadedState().socraticEngine.activeQuestions.length >=
      this.getLoadedState().socraticEngine.maxActiveQuestions
    ) {
      // Remove oldest question
      this.getLoadedState().socraticEngine.activeQuestions.shift();
    }

    this.getLoadedState().socraticEngine.activeQuestions.push(question);
    await this.persist();
    this.logger.debug({ questionId: question.id }, 'Self-question added');
  }

  /**
   * Resolve a self-question.
   */
  async resolveQuestion(
    questionId: string,
    answer: string,
    output: SocraticEngine['resolvedQuestions'][0]['output']
  ): Promise<void> {
    await this.ensureLoaded();

    const state = this.getLoadedState();
    const index = state.socraticEngine.activeQuestions.findIndex((q) => q.id === questionId);
    if (index < 0) {
      this.logger.warn({ questionId }, 'Question not found for resolution');
      return;
    }

    // Safe to access since we checked index >= 0
    const question = state.socraticEngine.activeQuestions[index];
    if (!question) {
      // Should never happen since findIndex returned valid index, but satisfy TypeScript
      this.logger.warn({ questionId, index }, 'Question disappeared during resolution');
      return;
    }
    state.socraticEngine.activeQuestions.splice(index, 1);
    state.socraticEngine.resolvedQuestions.push({
      question,
      answer,
      output,
      resolvedAt: new Date(),
    });

    // Keep only last 100 resolved questions
    if (state.socraticEngine.resolvedQuestions.length > 100) {
      state.socraticEngine.resolvedQuestions = state.socraticEngine.resolvedQuestions.slice(-100);
    }

    await this.persist();
  }

  /**
   * Get budget status.
   */
  async getBudgetStatus(): Promise<{
    tokensRemaining: number;
    tokensUsed: number;
    dailyLimit: number;
    canReflect: boolean;
    canAudit: boolean;
  }> {
    await this.ensureLoaded();
    this.maybeResetBudget();

    const budget = this.getLoadedState().budget;
    return {
      tokensRemaining: budget.dailyTokenLimit - budget.tokensUsedToday,
      tokensUsed: budget.tokensUsedToday,
      dailyLimit: budget.dailyTokenLimit,
      canReflect: await this.canReflect(),
      canAudit: await this.canAudit(),
    };
  }

  /**
   * Persist soul state to storage.
   */
  async persist(): Promise<void> {
    if (!this.state) return;

    this.state.lastSavedAt = new Date();

    // Serialize with Date handling using shared utility
    const serialized = JSON.stringify(this.state, dateReplacer);
    await this.config.storage.save(this.config.storageKey, JSON.parse(serialized));

    this.logger.debug('Soul state persisted');
  }

  /**
   * Ensure soul state is loaded.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      const data = await this.config.storage.load(this.config.storageKey);

      if (data) {
        this.state = this.deserializeState(data);
        this.logger.info('Soul state loaded from storage');
      } else {
        this.state = this.createDefaultFullState();
        this.loaded = true; // Set before persist to avoid recursion
        await this.persist();
        this.logger.info('No existing soul state, created and persisted defaults');
      }

      this.loaded = true;
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to load soul state'
      );
      this.state = this.createDefaultFullState();
      this.loaded = true;
    }
  }

  /**
   * Create default full soul state.
   */
  private createDefaultFullState(): FullSoulState {
    const base = createDefaultSoulState();
    return {
      ...base,
      parliament: createDefaultParliament(),
      socraticEngine: createDefaultSocraticEngine(),
      unanswerableCore: createDefaultUnanswerableCore(),
      deliberations: [],
    };
  }

  /**
   * Reset budget if past reset time.
   */
  private maybeResetBudget(): void {
    if (!this.state) return;

    const now = new Date();
    if (now >= this.state.budget.resetAt) {
      // Reset budget
      this.state.budget.tokensUsedToday = 0;

      // Set next reset to tomorrow midnight
      const tomorrow = new Date(now);
      tomorrow.setHours(0, 0, 0, 0);
      tomorrow.setDate(tomorrow.getDate() + 1);
      this.state.budget.resetAt = tomorrow;

      // Also refresh parliament voice budgets
      for (const voice of this.state.parliament.voices) {
        if (voice.budget) {
          voice.budget.remaining = voice.budget.attentionTokensPerDay;
          voice.budget.refreshAt = tomorrow;
        }
      }

      this.logger.info('Soul budget reset');
    }
  }

  /**
   * Update health metrics based on current state.
   *
   * Note: openWoundCount is now computed from memory (thoughts with tags
   * ['soul:reflection', 'state:unresolved']) rather than from a stored array.
   * This method updates stability; coherence should be updated by the caller
   * after querying memory for unresolved thoughts.
   */
  private updateHealth(): void {
    if (!this.state) return;

    // Stability: based on how recently constitution was modified
    const lastMod = this.state.constitution.lastModifiedAt;
    const daysSinceMod = (Date.now() - lastMod.getTime()) / (1000 * 60 * 60 * 24);
    this.state.health.stability = Math.min(1, daysSinceMod / 7); // Max stability after 1 week

    // Note: coherence and openWoundCount are now computed from memory
    // by querying for thoughts with tags ['soul:reflection', 'state:unresolved'].
    // The caller should update these after querying memory.
  }

  /**
   * Deserialize state from storage.
   * Handles Date restoration and version migrations.
   */
  private deserializeState(data: unknown): FullSoulState {
    // Convert to JSON string and parse with Date reviver using shared utility
    const jsonStr = JSON.stringify(data);
    // Parse as partial - stored data may be from older versions missing fields
    const parsed = JSON.parse(jsonStr, createDateReviver()) as Partial<FullSoulState> & {
      version: number;
    };

    // Handle version migrations if needed
    if (parsed.version < SOUL_STATE_VERSION) {
      this.logger.warn(
        { storedVersion: parsed.version, currentVersion: SOUL_STATE_VERSION },
        'Migrating soul state from older version'
      );
      // Add migration logic here when version changes
      parsed.version = SOUL_STATE_VERSION;
    }

    // Ensure all required fields exist (defensive - for older stored versions)
    // Cast to FullSoulState after ensuring all fields are populated
    return {
      ...parsed,
      parliament: parsed.parliament ?? createDefaultParliament(),
      socraticEngine: parsed.socraticEngine ?? createDefaultSocraticEngine(),
      unanswerableCore: parsed.unanswerableCore ?? createDefaultUnanswerableCore(),
      deliberations: parsed.deliberations ?? [],
    } as FullSoulState;
  }
}

/**
 * Create a Soul Provider.
 */
export function createSoulProvider(logger: Logger, config: SoulProviderConfig): SoulProvider {
  return new SoulProvider(logger, config);
}
