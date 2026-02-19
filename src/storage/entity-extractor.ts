/**
 * Entity Extractor
 *
 * Extracts entities and relations from memory entries using LLM.
 * Used during sleep-cycle consolidation to populate the GraphStore.
 *
 * Guardrails:
 * - Zod schema validation on LLM output
 * - Entity names must appear in source text (grounding)
 * - Minimum confidence 0.5 for new entities
 * - Relations require both endpoints to exist or be in same batch
 * - Idempotent: entries marked graphExtracted are skipped
 */

import { z } from 'zod';
import type { Logger } from '../types/logger.js';
import type { MemoryEntry } from '../layers/cognition/tools/registry.js';
import type { CognitionLLM } from '../layers/cognition/agentic-loop-types.js';
import type { EntityType, RelationType } from './graph-store.js';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  aliases: string[];
  description?: string | undefined;
  confidence: number;
  sourceMemoryIds: string[];
}

export interface ExtractedRelation {
  fromName: string;
  toName: string;
  type: RelationType;
  strength: number;
  confidence: number;
  sourceMemoryIds: string[];
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

export interface EntityExtractor {
  extract(entries: MemoryEntry[], existingEntityNames: string[]): Promise<ExtractionResult>;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ENTITY_TYPES: EntityType[] = [
  'person',
  'place',
  'organization',
  'topic',
  'event',
  'concept',
  'thing',
];

const RELATION_TYPES: RelationType[] = [
  'about',
  'related_to',
  'married_to',
  'works_at',
  'lives_in',
  'friend_of',
  'parent_of',
  'child_of',
  'sibling_of',
  'colleague_of',
  'member_of',
  'part_of',
  'owns',
  'likes',
  'dislikes',
  'interested_in',
  'committed_to',
  'attended',
  'created',
  'mentioned_in',
];

const extractedEntitySchema = z.object({
  name: z.string().min(1),
  type: z.enum(ENTITY_TYPES as [EntityType, ...EntityType[]]),
  aliases: z.array(z.string()).default([]),
  description: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

const extractedRelationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(RELATION_TYPES as [RelationType, ...RelationType[]]),
  strength: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1),
});

const extractionResponseSchema = z.object({
  entities: z.array(extractedEntitySchema),
  relations: z.array(extractedRelationSchema),
});

// ─── LLM Implementation ──────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are an entity and relationship extractor. Given memory entries, extract:

1. **Entities**: People, places, organizations, topics, events, concepts, or things mentioned.
2. **Relations**: Connections between entities (e.g., "works_at", "married_to", "interested_in").

Rules:
- Entity names MUST appear in the source text (do not invent entities).
- Use canonical names (e.g., "John Smith" not "John").
- Merge duplicate entities — use aliases for alternate names.
- Confidence: 0.5 = mentioned once, 0.7 = stated clearly, 0.9 = confirmed fact.
- Strength: how strong is this relationship (0.5 = mentioned, 0.8 = important, 1.0 = defining).

Output ONLY valid JSON matching this schema:
{
  "entities": [{ "name": string, "type": "person"|"place"|"organization"|"topic"|"event"|"concept"|"thing", "aliases": string[], "description"?: string, "confidence": number }],
  "relations": [{ "from": string, "to": string, "type": "about"|"related_to"|"married_to"|"works_at"|"lives_in"|"friend_of"|"parent_of"|"child_of"|"sibling_of"|"colleague_of"|"member_of"|"part_of"|"owns"|"likes"|"dislikes"|"interested_in"|"committed_to"|"attended"|"created"|"mentioned_in", "strength": number, "confidence": number }]
}

If no entities or relations found, return {"entities": [], "relations": []}.`;

const BATCH_SIZE = 20;

export class LLMEntityExtractor implements EntityExtractor {
  private readonly logger: Logger;
  private readonly llm: CognitionLLM;

  constructor(logger: Logger, llm: CognitionLLM) {
    this.logger = logger.child({ component: 'entity-extractor' });
    this.llm = llm;
  }

  async extract(entries: MemoryEntry[], existingEntityNames: string[]): Promise<ExtractionResult> {
    const allEntities: ExtractedEntity[] = [];
    const allRelations: ExtractedRelation[] = [];

    // Batch entries
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      try {
        const result = await this.extractBatch(batch, existingEntityNames);
        allEntities.push(...result.entities);
        allRelations.push(...result.relations);

        // Add newly extracted entity names to existing list for next batches
        for (const entity of result.entities) {
          existingEntityNames.push(entity.name);
        }
      } catch (error) {
        this.logger.error(
          {
            batchIndex: Math.floor(i / BATCH_SIZE),
            error: error instanceof Error ? error.message : String(error),
          },
          'Entity extraction batch failed, skipping'
        );
      }
    }

    this.logger.info(
      { entities: allEntities.length, relations: allRelations.length, entries: entries.length },
      'Entity extraction complete'
    );

    return { entities: allEntities, relations: allRelations };
  }

  private async extractBatch(
    entries: MemoryEntry[],
    existingEntityNames: string[]
  ): Promise<ExtractionResult> {
    // Build user prompt with entry content and existing entity names
    const entryTexts = entries
      .map((e, i) => `[${String(i + 1)}] (${e.type}, id:${e.id}) ${e.content}`)
      .join('\n');

    const existingSection =
      existingEntityNames.length > 0
        ? `\nExisting entities (merge with these if same entity, use aliases for alternate names):\n${existingEntityNames.join(', ')}\n`
        : '';

    const userPrompt = `${existingSection}\nMemory entries to extract from:\n${entryTexts}`;

    const response = await this.llm.complete(
      { systemPrompt: EXTRACTION_SYSTEM_PROMPT, userPrompt },
      { temperature: 0.1, maxTokens: 2000 }
    );

    // Parse JSON from response
    const jsonMatch = /\{[\s\S]*\}/.exec(response);
    if (!jsonMatch) {
      this.logger.warn('No JSON found in extraction response');
      return { entities: [], relations: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      this.logger.warn('Failed to parse extraction response as JSON');
      return { entities: [], relations: [] };
    }

    // Validate with zod
    const validated = extractionResponseSchema.safeParse(parsed);
    if (!validated.success) {
      this.logger.warn(
        { errors: validated.error.issues.length },
        'Extraction response failed schema validation'
      );
      return { entities: [], relations: [] };
    }

    const data = validated.data;

    // Build source text corpus for grounding check
    const sourceCorpus = entries.map((e) => e.content.toLowerCase()).join(' ');
    const entryIds = entries.map((e) => e.id);

    // Apply guardrails to entities
    const validEntities: ExtractedEntity[] = [];
    const validEntityNames = new Set<string>(existingEntityNames.map((n) => n.toLowerCase()));

    for (const raw of data.entities) {
      // Grounding check: entity name must appear in source text
      if (!this.isGrounded(raw.name, sourceCorpus)) {
        this.logger.debug({ name: raw.name }, 'Entity not grounded in source text, skipping');
        continue;
      }

      // Minimum confidence
      if (raw.confidence < 0.5) {
        this.logger.debug(
          { name: raw.name, confidence: raw.confidence },
          'Entity below confidence threshold'
        );
        continue;
      }

      validEntities.push({
        name: raw.name,
        type: raw.type,
        aliases: raw.aliases,
        description: raw.description,
        confidence: raw.confidence,
        sourceMemoryIds: entryIds,
      });
      validEntityNames.add(raw.name.toLowerCase());
    }

    // Apply guardrails to relations
    const validRelations: ExtractedRelation[] = [];
    for (const raw of data.relations) {
      // Both endpoints must exist (either pre-existing or newly extracted)
      if (!validEntityNames.has(raw.from.toLowerCase())) {
        this.logger.debug({ from: raw.from }, 'Relation from-entity not found, skipping');
        continue;
      }
      if (!validEntityNames.has(raw.to.toLowerCase())) {
        this.logger.debug({ to: raw.to }, 'Relation to-entity not found, skipping');
        continue;
      }

      validRelations.push({
        fromName: raw.from,
        toName: raw.to,
        type: raw.type,
        strength: raw.strength,
        confidence: raw.confidence,
        sourceMemoryIds: entryIds,
      });
    }

    this.logger.debug(
      {
        rawEntities: data.entities.length,
        validEntities: validEntities.length,
        rawRelations: data.relations.length,
        validRelations: validRelations.length,
      },
      'Batch extraction validated'
    );

    return { entities: validEntities, relations: validRelations };
  }

  /**
   * Check if an entity name appears in the source text.
   * Case-insensitive, strips punctuation for fuzzy matching.
   */
  private isGrounded(name: string, sourceCorpus: string): boolean {
    const normalized = name.toLowerCase().replace(/[.,!?;:'"]/g, '');
    return sourceCorpus.includes(normalized);
  }
}
