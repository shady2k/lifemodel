import type { AgentIdentity } from '../types/index.js';
import type { LLMProvider, Message } from './provider.js';

/**
 * Context for composing a message.
 */
export interface CompositionContext {
  /** What triggered this message (e.g., "user said hello", "social debt high") */
  trigger: string;

  /** Recent conversation history */
  conversationHistory?: Message[] | undefined;

  /** User's last message (if responding) */
  userMessage?: string | undefined;

  /** Mood/tone to use */
  mood?: 'neutral' | 'friendly' | 'concerned' | 'curious' | 'apologetic' | undefined;

  /** Additional context or constraints */
  constraints?: string[] | undefined;
}

/**
 * Result of message composition.
 */
export interface CompositionResult {
  /** The composed message */
  message: string;

  /** Tokens used */
  tokensUsed?: number | undefined;

  /** Whether composition was successful */
  success: boolean;

  /** Error message if failed */
  error?: string | undefined;
}

/**
 * MessageComposer - uses LLM to generate natural responses.
 *
 * Takes agent identity and context, produces human-like messages.
 */
export class MessageComposer {
  private readonly provider: LLMProvider;
  private readonly identity: AgentIdentity;

  constructor(provider: LLMProvider, identity: AgentIdentity) {
    this.provider = provider;
    this.identity = identity;
  }

  /**
   * Compose a message based on context.
   */
  async compose(context: CompositionContext): Promise<CompositionResult> {
    if (!this.provider.isAvailable()) {
      return {
        message: '',
        success: false,
        error: 'LLM provider not available',
      };
    }

    try {
      const systemPrompt = this.buildSystemPrompt(context);
      const userPrompt = this.buildUserPrompt(context);

      const messages: Message[] = [{ role: 'system', content: systemPrompt }];

      // Add conversation history if available
      if (context.conversationHistory) {
        messages.push(...context.conversationHistory);
      }

      messages.push({ role: 'user', content: userPrompt });

      const response = await this.provider.complete({
        messages,
        temperature: 0.7,
        maxTokens: 300,
      });

      return {
        message: response.content.trim(),
        tokensUsed: response.usage?.totalTokens,
        success: true,
      };
    } catch (error) {
      return {
        message: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Compose a proactive message (agent initiating contact).
   */
  async composeProactive(reason: string): Promise<CompositionResult> {
    return this.compose({
      trigger: reason,
      mood: 'friendly',
      constraints: ['Keep it brief and natural', "Don't be intrusive", 'Show genuine interest'],
    });
  }

  /**
   * Compose a response to user message.
   */
  async composeResponse(userMessage: string, history?: Message[]): Promise<CompositionResult> {
    return this.compose({
      trigger: 'responding to user',
      userMessage,
      conversationHistory: history,
      mood: 'neutral',
    });
  }

  /**
   * Build system prompt based on agent identity.
   */
  private buildSystemPrompt(context: CompositionContext): string {
    const personality = this.identity.personality;

    const traits: string[] = [];
    if (personality.humor > 0.7) traits.push('witty and playful');
    if (personality.formality < 0.3) traits.push('casual and relaxed');
    if (personality.formality > 0.7) traits.push('professional and polished');
    if (personality.empathy > 0.7) traits.push('warm and empathetic');
    if (personality.curiosity > 0.7) traits.push('curious and engaged');

    const moodInstructions: Record<string, string> = {
      neutral: 'Be balanced and natural.',
      friendly: 'Be warm and approachable.',
      concerned: 'Show care and understanding.',
      curious: 'Show genuine interest.',
      apologetic: 'Be understanding and humble.',
    };

    let prompt = `You are ${this.identity.name}, a helpful AI assistant.

Your personality: ${traits.length > 0 ? traits.join(', ') : 'balanced and helpful'}.

Values: ${this.identity.values.join(', ')}.

Boundaries: ${this.identity.boundaries.join(', ')}.

${moodInstructions[context.mood ?? 'neutral'] ?? 'Be balanced and natural.'}`;

    if (context.constraints && context.constraints.length > 0) {
      prompt += `\n\nAdditional guidelines:\n${context.constraints.map((c) => `- ${c}`).join('\n')}`;
    }

    prompt += `\n\nRespond naturally and conversationally. Keep messages concise.`;

    return prompt;
  }

  /**
   * Build user prompt based on context.
   */
  private buildUserPrompt(context: CompositionContext): string {
    if (context.userMessage) {
      return context.userMessage;
    }

    // For proactive messages
    return `Generate a message to the user. Reason: ${context.trigger}`;
  }
}

/**
 * Factory function.
 */
export function createMessageComposer(
  provider: LLMProvider,
  identity: AgentIdentity
): MessageComposer {
  return new MessageComposer(provider, identity);
}
