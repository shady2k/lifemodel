/**
 * REAL cognition layer driven by a scripted fake LLM provider (no network)
 * for the shutdown-drain integration criterion: the real agentic loop,
 * intent compiler, response parser and tool registry run end to end; only
 * the provider boundary is scripted.
 *
 * The facade conforms to the CognitionLayer shape CoreLoop calls: process()
 * runs the real processor and records the turn; hang holds the provider's
 * next completion (the overrunning turn); triggerIds() lists the trigger
 * signals that reached cognition.
 */
import type { CognitionProcessorDeps } from '../../src/layers/cognition/processor.js';
import { CognitionProcessor } from '../../src/layers/cognition/processor.js';
import type { Logger } from '../../src/types/logger.js';
import type { CognitionContext, CognitionResult } from '../../src/types/layers.js';
import { createLLMAdapter } from '../../src/layers/cognition/llm-adapter.js';
import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
} from '../../src/llm/provider.js';
import { makeDeferred } from './core-loop-drain-harness.js';
import type { ScriptedResponse } from './scripted-llm.js';

const noopLogger = {
  child: () => noopLogger,
  level: 'silent',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as unknown as Logger;

/**
 * Scripted fake provider that can HOLD its next completion - that hanging
 * call is the overrunning turn. No network anywhere.
 */
export class HangableScriptedLLM implements LLMProvider {
  readonly name = 'hangable-scripted-test';
  /** Requests received (how many completions the loop asked for) */
  requests: CompletionRequest[] = [];
  /** When true, the next completion hangs until settleHangingTurn() */
  hang = true;
  private readonly script: ScriptedResponse[];
  private index = 0;
  private readonly hangs: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];

  constructor(script: ScriptedResponse[]) {
    this.script = [...script];
  }

  isAvailable(): boolean {
    return true;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    if (this.hang) {
      const deferred = makeDeferred<unknown>();
      this.hangs.push(deferred as never);
      await deferred.promise;
    }
    if (this.index >= this.script.length) {
      throw new Error(
        `HangableScriptedLLM: script exhausted (call ${String(this.requests.length)})`
      );
    }
    const scripted = this.script[this.index++]!;
    return {
      content: scripted.content ?? null,
      model: 'hangable-scripted-model',
      toolCalls: undefined,
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    };
  }

  /** Release every hanging completion; they then replay the script. */
  settleHangingTurn(): void {
    for (const h of this.hangs.splice(0)) {
      h.resolve(undefined);
    }
  }
}

/** The REAL cognition processor wrapped for the harness's drain tests. */
export class RealCognitionFacade {
  readonly name = 'cognition';
  readonly provider: HangableScriptedLLM;
  readonly processor: CognitionProcessor;
  readonly adapter: ReturnType<typeof createLLMAdapter>;
  readonly calls: { context: CognitionContext; done: Promise<CognitionResult> }[] = [];

  constructor(processor: CognitionProcessor, provider: HangableScriptedLLM) {
    this.processor = processor;
    this.provider = provider;
    this.adapter = createLLMAdapter(provider as never, noopLogger, { role: 'fast' });
  }

  setDependencies(deps: CognitionProcessorDeps): void {
    this.processor.setDependencies(deps);
  }

  /** Hold (or release) the fake provider's next completion */
  set hang(on: boolean) {
    this.provider.hang = on;
  }

  get hang(): boolean {
    return this.provider.hang;
  }

  /** Release every hanging completion; they replay the script */
  settleHangingTurn(): void {
    this.provider.settleHangingTurn();
  }

  process(context: CognitionContext): Promise<CognitionResult> {
    const done = this.processor.process(context);
    this.calls.push({ context, done: done.catch(() => undefined) });
    return done;
  }

  triggerIds(): string[] {
    const ids: string[] = [];
    for (const call of this.calls) {
      for (const s of call.context.triggerSignals) ids.push(s.id);
    }
    return ids;
  }
}

/**
 * The REAL cognition processor (agentic loop etc.) with a scripted fake LLM
 * provider - the container's construction, with only the provider scripted.
 */
export function createRealCognitionProcessor(
  _logger: Logger,
  _agent: unknown,
  script: ScriptedResponse[]
): RealCognitionFacade {
  const provider = new HangableScriptedLLM(script);
  const processor = new CognitionProcessor(noopLogger, {}, {} as CognitionProcessorDeps);
  return new RealCognitionFacade(processor, provider);
}
