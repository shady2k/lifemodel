import type {
  Rule,
  RuleContext,
  UserBeliefs,
  Intent,
  Event,
  AgentState,
  Logger,
} from '../types/index.js';

/**
 * RuleEngine - evaluates rules and collects intents.
 *
 * Rules don't mutate state directly. The engine:
 * 1. Builds context from current state
 * 2. Evaluates each rule's condition
 * 3. Executes matching rules' actions
 * 4. Collects and returns all intents
 *
 * The core then validates and applies these intents.
 */
export class RuleEngine {
  private readonly rules = new Map<string, Rule>();
  private readonly logger: Logger;
  private lastInteractionAt: Date = new Date();
  private userBeliefs: UserBeliefs | undefined;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'rule-engine' });
  }

  /**
   * Set current user beliefs for rule evaluation.
   * Call this to update user state available to rules.
   */
  setUserBeliefs(beliefs: UserBeliefs | undefined): void {
    this.userBeliefs = beliefs;
  }

  /**
   * Register a rule.
   */
  addRule(rule: Rule): void {
    this.rules.set(rule.id, rule);
    this.logger.debug({ ruleId: rule.id, trigger: rule.trigger }, 'Rule registered');
  }

  /**
   * Remove a rule by ID.
   */
  removeRule(id: string): boolean {
    const removed = this.rules.delete(id);
    if (removed) {
      this.logger.debug({ ruleId: id }, 'Rule removed');
    }
    return removed;
  }

  /**
   * Get all registered rules.
   */
  getRules(): Rule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Record an interaction (resets timeSinceLastInteraction).
   */
  recordInteraction(): void {
    this.lastInteractionAt = new Date();
  }

  /**
   * Evaluate all rules for a tick event.
   * Called every tick cycle.
   */
  evaluateTick(state: AgentState): Intent[] {
    const context = this.buildContext(state);
    return this.evaluateRules('tick', context);
  }

  /**
   * Evaluate rules for a specific event.
   */
  evaluateEvent(state: AgentState, event: Event): Intent[] {
    const context = this.buildContext(state, event);
    return this.evaluateRules(event.type, context);
  }

  /**
   * Build rule context from current state.
   */
  private buildContext(state: AgentState, event?: Event): RuleContext {
    const now = new Date();
    return {
      state,
      userBeliefs: this.userBeliefs,
      event,
      now,
      hour: now.getHours(),
      timeSinceLastInteraction: now.getTime() - this.lastInteractionAt.getTime(),
      logger: this.logger,
    };
  }

  /**
   * Evaluate rules that match a trigger.
   * Rules only fire when their trigger exactly matches the current trigger.
   * Tick rules run only during tick cycles, event rules only on their specific events.
   */
  private evaluateRules(trigger: string, context: RuleContext): Intent[] {
    const allIntents: Intent[] = [];
    const matchingRules = Array.from(this.rules.values()).filter(
      (rule) => rule.trigger === trigger
    );

    this.logger.debug(
      {
        trigger,
        rulesCount: matchingRules.length,
        hour: context.hour,
        energy: context.state.energy.toFixed(2),
        socialDebt: context.state.socialDebt.toFixed(2),
      },
      'Evaluating rules'
    );

    for (const rule of matchingRules) {
      try {
        // Check condition
        const conditionMet = rule.condition(context);

        this.logger.debug({ ruleId: rule.id, conditionMet }, `Rule condition: ${rule.description}`);

        if (!conditionMet) {
          continue;
        }

        // Execute action
        const intents = rule.action(context);

        if (intents.length > 0) {
          // Update rule usage stats
          rule.lastUsed = context.now;
          rule.useCount++;

          // Collect intents
          allIntents.push(...intents);

          this.logger.debug(
            {
              ruleId: rule.id,
              intents: intents.length,
              intentTypes: intents.map((i) => i.type),
            },
            `🔥 Rule fired: ${rule.description}`
          );
        }
      } catch (error) {
        this.logger.error(
          {
            ruleId: rule.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Rule evaluation failed'
        );
      }
    }

    return allIntents;
  }
}

/**
 * Factory function.
 */
export function createRuleEngine(logger: Logger): RuleEngine {
  return new RuleEngine(logger);
}
