import type { AgentIdentity } from '../types/index.js';
import type { LLMProvider, Message } from './provider.js';

/**
 * User state for classification context.
 */
export interface UserStateContext {
  name: string;
  energy: number;
  availability: number;
  mood: string;
  confidence: number;
}

/**
 * Context for fast model classification.
 */
export interface ClassificationContext {
  /** The user's message to classify */
  userMessage: string;

  /** Conversation history (compacted) */
  conversationHistory?: Message[] | undefined;

  /** Current user state (agent's beliefs) */
  userState?: UserStateContext | undefined;

  /** Messages that need compaction (older messages to summarize) */
  messagesToCompact?: Message[] | undefined;
}

/**
 * Result from fast model classification.
 */
export interface ClassificationResult {
  /** Can the fast model handle this confidently? */
  canHandle: boolean;

  /** Confidence level 0-1 */
  confidence: number;

  /** Suggested response if canHandle is true */
  suggestedResponse?: string | undefined;

  /** Brief reasoning for the decision */
  reasoning?: string | undefined;

  /** Tokens used */
  tokensUsed?: number | undefined;

  /** Summary of older conversation context (when compaction was requested) */
  contextSummary?: string | undefined;
}

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
        role: 'smart', // Use smart model for composition
        temperature: 0.7,
        maxTokens: 800, // Enough for detailed responses
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
   * Classify a message and optionally generate a response using the fast model.
   *
   * This is the first step in processing - if the fast model can handle it
   * confidently, we skip the expensive smart model.
   */
  async classifyAndRespond(context: ClassificationContext): Promise<ClassificationResult> {
    if (!this.provider.isAvailable()) {
      return {
        canHandle: false,
        confidence: 0,
        reasoning: 'LLM provider not available',
      };
    }

    try {
      const systemPrompt = this.buildClassificationPrompt(context);

      const messages: Message[] = [{ role: 'system', content: systemPrompt }];

      // Add conversation history if available
      if (context.conversationHistory) {
        messages.push(...context.conversationHistory);
      }

      // Add the user message
      messages.push({ role: 'user', content: context.userMessage });

      const response = await this.provider.complete({
        messages,
        role: 'fast', // Use fast model for classification
        temperature: 0.3, // Lower temperature for more consistent classification
        maxTokens: 5000, // Higher limit for "thinking" models that use tokens for reasoning
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'classification',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                canHandle: { type: 'boolean' },
                confidence: { type: 'number' },
                suggestedResponse: { type: 'string' },
                reasoning: { type: 'string' },
                contextSummary: { type: 'string' },
              },
              required: ['canHandle', 'confidence'],
            },
          },
        },
      });

      // Parse JSON response
      const parsed = this.parseClassificationResponse(response.content);

      return {
        ...parsed,
        tokensUsed: response.usage?.totalTokens,
      };
    } catch (error) {
      return {
        canHandle: false,
        confidence: 0,
        reasoning: `Classification failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Build system prompt for classification with full context.
   */
  private buildClassificationPrompt(context: ClassificationContext): string {
    const personality = this.identity.personality;

    // Build personality traits description
    const traits: string[] = [];
    if (personality.humor > 0.7) traits.push('witty and playful');
    if (personality.formality < 0.3) traits.push('casual and relaxed');
    if (personality.formality > 0.7) traits.push('professional and polished');
    if (personality.empathy > 0.7) traits.push('warm and empathetic');
    if (personality.curiosity > 0.7) traits.push('curious and engaged');
    if (personality.shyness > 0.6) traits.push('somewhat reserved');
    if (personality.patience > 0.7) traits.push('patient');

    // Build user state section
    let userStateSection = '';
    if (context.userState) {
      const { name, energy, availability, mood, confidence } = context.userState;
      userStateSection = `
## Current User State (your beliefs about them)
- Name: ${name}
- Energy level: ${energy.toFixed(1)}/1.0 (${this.describeEnergy(energy)})
- Availability: ${availability.toFixed(1)}/1.0
- Mood: ${this.describeMood(mood)}
- Confidence in these beliefs: ${confidence.toFixed(1)}/1.0`;
    }

    // Build compaction section if needed
    let compactionSection = '';
    let compactionJsonField = '';
    if (context.messagesToCompact && context.messagesToCompact.length > 0) {
      compactionSection = `
## Conversation Compaction Required
The conversation history includes older messages (marked below as [OLDER CONTEXT]) that need summarizing for future reference.
After responding to the current message, provide a brief summary of the KEY FACTS from the older messages.
Include: topics discussed, user preferences revealed, decisions made, important context.
Keep the summary concise (2-4 sentences) but preserve essential information.

[OLDER CONTEXT - Summarize this:]
${context.messagesToCompact.map((m) => `${m.role}: ${m.content}`).join('\n')}
[END OLDER CONTEXT]`;
      compactionJsonField =
        ',\n  "contextSummary": "Brief summary of older context (only when compaction requested)"';
    }

    return `You are ${this.identity.name}, a personal AI assistant.

## Your Personality
- Traits: ${traits.length > 0 ? traits.join(', ') : 'balanced and helpful'}
- Values: ${this.identity.values.join(', ')}
- Boundaries: ${this.identity.boundaries.join(', ')}
${userStateSection}
${compactionSection}

## Your Task
Analyze the user's message and decide if you can respond naturally and confidently.

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "canHandle": true or false,
  "confidence": 0.0 to 1.0,
  "suggestedResponse": "Your response in character (only if canHandle=true)",
  "reasoning": "Brief explanation of your decision"${compactionJsonField}
}

## Guidelines
- Simple social interactions ("Hi", "How are you?", "Thanks") → canHandle=true, respond naturally
- If user seems tired/busy based on their state → keep response brief and considerate
- Complex questions, deep reasoning, technical topics → canHandle=false
- Anything you're unsure about → canHandle=false, let smart model handle it
- Match the language of the user's message (if they write in Russian, respond in Russian)
- Keep responses concise and natural
- Do NOT use markdown in suggestedResponse (no asterisks, no bold, plain text only)`;
  }

  /**
   * Parse the classification response from JSON.
   * Falls back to treating non-JSON responses as direct answers.
   */
  private parseClassificationResponse(content: string): Omit<ClassificationResult, 'tokensUsed'> {
    const trimmed = content.trim();

    // Try to parse as JSON first
    try {
      let jsonStr = trimmed;

      // Handle markdown code blocks
      if (jsonStr.startsWith('```')) {
        const match = /```(?:json)?\s*([\s\S]*?)```/.exec(jsonStr);
        if (match) {
          jsonStr = match[1]?.trim() ?? jsonStr;
        }
      }

      // Try to find JSON object in response (some models add text around it)
      const jsonMatch = /\{[\s\S]*"canHandle"[\s\S]*\}/.exec(jsonStr);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const parsed = JSON.parse(jsonStr) as {
        canHandle?: boolean;
        confidence?: number;
        suggestedResponse?: string;
        reasoning?: string;
        contextSummary?: string;
      };

      return {
        canHandle: Boolean(parsed.canHandle),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        suggestedResponse: parsed.suggestedResponse,
        reasoning: parsed.reasoning,
        contextSummary: parsed.contextSummary,
      };
    } catch {
      // JSON parsing failed - check if we got a meaningful text response
      // Some models (like GLM thinking models) respond with plain text instead of JSON
      if (trimmed.length > 10) {
        // Non-trivial response - treat it as a direct answer
        return {
          canHandle: true,
          confidence: 0.7, // Moderate confidence since format wasn't followed
          suggestedResponse: trimmed,
          reasoning: 'Model responded with plain text instead of JSON - using as direct response',
        };
      }

      // Empty or very short response - can't handle
      return {
        canHandle: false,
        confidence: 0,
        reasoning: 'Failed to parse classification response',
      };
    }
  }

  /**
   * Describe energy level in human-readable terms.
   */
  private describeEnergy(energy: number): string {
    if (energy < 0.2) return 'very low, likely tired or sleeping';
    if (energy < 0.4) return 'low, winding down';
    if (energy < 0.6) return 'moderate';
    if (energy < 0.8) return 'good, active';
    return 'high, very alert';
  }

  /**
   * Describe mood in human-readable terms.
   */
  private describeMood(mood: string): string {
    switch (mood) {
      case 'positive':
        return 'good mood, seems happy';
      case 'negative':
        return 'seems upset or frustrated';
      case 'tired':
        return 'tired, low energy';
      default:
        return 'neutral/unknown';
    }
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

    prompt += `\n\nRespond naturally and conversationally. Keep messages concise.
Do NOT use markdown formatting (no asterisks for bold, no headers, no bullet lists with dashes).
Write plain text only.`;

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

  /**
   * Classify the conversation status based on the last exchange.
   * Used to determine appropriate follow-up timing.
   */
  async classifyConversationStatus(
    lastAssistantMessage: string,
    lastUserMessage?: string
  ): Promise<{
    status: 'active' | 'awaiting_answer' | 'closed' | 'idle';
    confidence: number;
    reasoning: string;
  }> {
    const systemPrompt = `You analyze conversation state to determine appropriate follow-up timing.

Classify the conversation status based on the last messages:

- "active": Mid-conversation, natural exchange happening, user likely to respond soon
- "awaiting_answer": Assistant asked a specific question or requested information, waiting for user's answer
- "closed": Conversation ended (farewell, user said they're busy, "talk later", etc.) - don't disturb
- "idle": Natural pause, statement made but no specific question asked, OK to reach out later

Respond ONLY with valid JSON:
{
  "status": "active" | "awaiting_answer" | "closed" | "idle",
  "confidence": 0.0 to 1.0,
  "reasoning": "Brief explanation"
}`;

    let userPrompt = `Last assistant message: "${lastAssistantMessage}"`;
    if (lastUserMessage) {
      userPrompt = `Last user message: "${lastUserMessage}"\n${userPrompt}`;
    }

    try {
      const response = await this.provider.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        role: 'fast',
        temperature: 0.2,
        maxTokens: 200,
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'conversation_status',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  enum: ['active', 'awaiting_answer', 'closed', 'idle'],
                },
                confidence: { type: 'number' },
                reasoning: { type: 'string' },
              },
              required: ['status', 'confidence', 'reasoning'],
            },
          },
        },
      });

      const parsed = JSON.parse(response.content) as {
        status: 'active' | 'awaiting_answer' | 'closed' | 'idle';
        confidence: number;
        reasoning: string;
      };

      return {
        status: parsed.status,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
      };
    } catch {
      // Fallback: simple heuristic
      const hasQuestion = lastAssistantMessage.trim().endsWith('?');
      const hasClosingWords = /(\bпока\b|\bbye\b|\bдо свидания\b|\bсвяжемся\b|\blater\b)/i.test(
        lastAssistantMessage
      );

      if (hasClosingWords) {
        return {
          status: 'closed',
          confidence: 0.6,
          reasoning: 'Contains closing words (fallback)',
        };
      }
      if (hasQuestion) {
        return {
          status: 'awaiting_answer',
          confidence: 0.6,
          reasoning: 'Ends with question mark (fallback)',
        };
      }
      return { status: 'idle', confidence: 0.5, reasoning: 'Default fallback' };
    }
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
