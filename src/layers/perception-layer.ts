import type { LayerResult, Logger } from '../types/index.js';
import type { ProcessingContext, PerceptionOutput, ContentType } from './context.js';
import { BaseLayer } from './base-layer.js';

/**
 * Layer 1: PERCEPTION
 *
 * Parses events and extracts structure.
 * "What type of event is this?"
 *
 * Handles:
 * - Content type detection (text, greeting, question, etc.)
 * - Basic entity extraction
 * - Language detection
 * - Structure analysis
 *
 * Cost: Zero (heuristics only, no LLM)
 */
export class PerceptionLayer extends BaseLayer {
  readonly name = 'perception';
  readonly confidenceThreshold = 0.7;

  // Common greeting patterns
  private readonly greetingPatterns = [
    /^(hi|hello|hey|good\s*(morning|afternoon|evening)|greetings|yo|sup)/i,
    /^(привет|здравствуй|добр(ый|ое|ая)\s*(день|утро|вечер))/i,
  ];

  // Common farewell patterns
  private readonly farewellPatterns = [
    /^(bye|goodbye|see\s*you|later|good\s*night|cya|ttyl)/i,
    /^(пока|до\s*свидания|увидимся|спокойной\s*ночи)/i,
  ];

  // Question patterns
  private readonly questionPatterns = [
    /\?$/,
    /^(what|who|where|when|why|how|can|could|would|is|are|do|does)/i,
    /^(что|кто|где|когда|почему|как|можно|могу)/i,
  ];

  // Acknowledgment patterns
  private readonly ackPatterns = [
    /^(ok|okay|k|got\s*it|understood|sure|yes|yeah|yep|no|nope|alright)/i,
    /^(ок|окей|понял|хорошо|да|нет|ладно)/i,
  ];

  constructor(logger: Logger) {
    super(logger, 'perception');
  }

  protected processImpl(context: ProcessingContext): LayerResult {
    context.stage = 'perception';

    // Only process communication events
    if (context.event.source !== 'communication') {
      // Non-communication events pass through with high confidence
      return this.success(context, 1.0);
    }

    // Extract text from payload
    const text = this.extractText(context.event.payload);

    if (!text) {
      // No text to analyze
      context.perception = {
        contentType: 'unknown',
        isQuestion: false,
        isCommand: false,
        entities: [],
        keywords: [],
      };
      return this.success(context, 0.5);
    }

    // Analyze the text
    const perception = this.analyzeText(text);
    context.perception = perception;

    // Confidence based on how well we understood the content
    const confidence = perception.contentType === 'unknown' ? 0.4 : 0.85;

    this.logger.debug(
      {
        eventId: context.event.id,
        contentType: perception.contentType,
        language: perception.language,
        isQuestion: perception.isQuestion,
        isCommand: perception.isCommand,
        keywords: perception.keywords.slice(0, 5),
        textPreview: text.slice(0, 50) + (text.length > 50 ? '...' : ''),
      },
      'Perception complete'
    );

    return this.success(context, confidence);
  }

  private extractText(payload: unknown): string | null {
    if (typeof payload === 'string') {
      return payload;
    }

    if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      if (typeof p['text'] === 'string') {
        return p['text'];
      }
      if (typeof p['message'] === 'string') {
        return p['message'];
      }
      if (typeof p['content'] === 'string') {
        return p['content'];
      }
    }

    return null;
  }

  private analyzeText(text: string): PerceptionOutput {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    // Detect content type
    const contentType = this.detectContentType(trimmed);

    // Detect if question
    const isQuestion = this.questionPatterns.some((p) => p.test(trimmed));

    // Detect if command (starts with verb or imperative)
    const isCommand = this.detectCommand(trimmed);

    // Extract entities (simple pattern matching for MVP)
    const entities = this.extractEntities(trimmed);

    // Extract keywords
    const keywords = this.extractKeywords(lower);

    // Detect language (simple heuristic)
    const language = this.detectLanguage(trimmed);

    return {
      contentType,
      text: trimmed,
      language,
      isQuestion,
      isCommand,
      entities,
      keywords,
    };
  }

  private detectContentType(text: string): ContentType {
    // Check greetings first (often short)
    if (this.greetingPatterns.some((p) => p.test(text))) {
      return 'greeting';
    }

    // Check farewells
    if (this.farewellPatterns.some((p) => p.test(text))) {
      return 'farewell';
    }

    // Check acknowledgments
    if (text.length < 20 && this.ackPatterns.some((p) => p.test(text))) {
      return 'acknowledgment';
    }

    // Check if question
    if (this.questionPatterns.some((p) => p.test(text))) {
      return 'question';
    }

    // Check for emotional content (exclamation marks, caps, emoji)
    if (this.hasEmotionalMarkers(text)) {
      return 'emotional';
    }

    // Check for command patterns
    if (this.detectCommand(text)) {
      return 'command';
    }

    // Default to text for longer content
    if (text.length > 10) {
      return 'text';
    }

    return 'unknown';
  }

  private detectCommand(text: string): boolean {
    // Commands often start with imperative verbs
    const commandStarts = [
      /^(do|make|create|add|remove|delete|show|tell|give|help|find|search|get|set|open|close|start|stop|run|send)/i,
      /^(сделай|создай|добавь|удали|покажи|скажи|дай|помоги|найди|открой|закрой|запусти|останови|отправь)/i,
    ];
    return commandStarts.some((p) => p.test(text.trim()));
  }

  private hasEmotionalMarkers(text: string): boolean {
    // Multiple exclamation marks
    if (/!{2,}/.test(text)) return true;

    // Significant caps (more than 50% and longer than 5 chars)
    if (text.length > 5) {
      const caps = text.replace(/[^A-ZА-Я]/g, '').length;
      const letters = text.replace(/[^A-Za-zА-Яа-я]/g, '').length;
      if (letters > 0 && caps / letters > 0.5) return true;
    }

    // Common emoji patterns (simplified)
    if (/[\u{1F600}-\u{1F64F}]/u.test(text)) return true;

    return false;
  }

  private extractEntities(text: string): string[] {
    const entities: string[] = [];

    // Extract capitalized words (potential names) - simple heuristic
    const namePattern = /\b[A-ZА-Я][a-zа-я]+(?:\s+[A-ZА-Я][a-zа-я]+)?\b/g;
    const matches = text.match(namePattern);
    if (matches) {
      // Filter out sentence starters
      const words = text.split(/\s+/);
      for (const match of matches) {
        const idx = words.findIndex((w) => w.startsWith(match.split(' ')[0] ?? ''));
        // Keep if not at sentence start
        if (idx > 0) {
          entities.push(match);
        }
      }
    }

    // Extract URLs
    const urlPattern = /https?:\/\/[^\s]+/g;
    const urls = text.match(urlPattern);
    if (urls) {
      entities.push(...urls);
    }

    return [...new Set(entities)];
  }

  private extractKeywords(text: string): string[] {
    // Remove common stop words and extract significant words
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'shall',
      'can',
      'need',
      'dare',
      'ought',
      'used',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'under',
      'again',
      'further',
      'then',
      'once',
      'и',
      'в',
      'на',
      'с',
      'к',
      'по',
      'за',
      'из',
      'у',
      'о',
      'от',
      'до',
      'для',
      'при',
      'что',
      'как',
      'это',
      'но',
      'или',
      'если',
      'я',
      'ты',
      'он',
      'она',
      'мы',
      'вы',
      'они',
      'i',
      'you',
      'he',
      'she',
      'it',
      'we',
      'they',
      'me',
      'him',
      'her',
      'us',
      'them',
      'my',
      'your',
      'his',
      'its',
      'our',
      'their',
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\sа-яё]/gi, '')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    // Return unique keywords, max 10
    return [...new Set(words)].slice(0, 10);
  }

  private detectLanguage(text: string): string {
    // Simple heuristic based on character sets
    const cyrillicCount = (text.match(/[а-яёА-ЯЁ]/g) ?? []).length;
    const latinCount = (text.match(/[a-zA-Z]/g) ?? []).length;

    if (cyrillicCount > latinCount) {
      return 'ru';
    }
    if (latinCount > 0) {
      return 'en';
    }
    return 'unknown';
  }
}

/**
 * Factory function.
 */
export function createPerceptionLayer(logger: Logger): PerceptionLayer {
  return new PerceptionLayer(logger);
}
