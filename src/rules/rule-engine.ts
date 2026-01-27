import type { Rule, RuleContext, Intent, Event, AgentState, Logger } from '../types/index.js';

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

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'rule-engine' });
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
      event,
      now,
      hour: now.getHours(),
      timeSinceLastInteraction: now.getTime() - this.lastInteractionAt.getTime(),
    };
  }

  /**
   * Evaluate rules that match a trigger.
   */
  private evaluateRules(trigger: string, context: RuleContext): Intent[] {
    const allIntents: Intent[] = [];
    const matchingRules = Array.from(this.rules.values()).filter(
      (rule) => rule.trigger === trigger || rule.trigger === 'tick'
    );

    for (const rule of matchingRules) {
      try {
        // Check condition
        if (!rule.condition(context)) {
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
              trigger,
            },
            'Rule fired'
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
