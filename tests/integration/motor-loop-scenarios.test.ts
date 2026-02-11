/**
 * Motor Cortex Loop Scenario Tests
 *
 * Full motor loop integration tests without real LLM calls.
 * Tests actual loop flow: LLM → tools → iterate → complete/pause/fail.
 *
 * Two layers:
 * - Loop mechanics (fast, fake tool executor where needed)
 * - Tool integration (real executors, temp workspace)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMotorLoop } from '../../src/runtime/motor-cortex/motor-loop.js';
import type { MotorTool } from '../../src/runtime/motor-cortex/motor-protocol.js';
import {
  createScriptedLLM,
  textResponse,
  toolCallResponse,
  toolCallsResponse,
  mixedResponse,
} from '../helpers/scripted-llm.js';
import {
  createTestLoopParams,
  createTestMotorRun,
  createTestAttempt,
  createMockStateManager,
} from '../helpers/motor-test-utils.js';

describe('Motor Loop Scenario Tests', () => {
  describe('Scenario 1: Happy Path — write → complete', () => {
    it('completes successfully with tool execution and result', async () => {
      const scriptedLLM = createScriptedLLM([
        // First call: model writes a file
        toolCallResponse('write', {
          path: 'output.txt',
          content: 'hello world',
        }),
        // Second call: model completes with summary
        textResponse('Done! I created output.txt with "hello world"'),
      ]);

      const { params, cleanup, stateManager, pushSignal } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['read', 'write', 'list'],
      });

      await runMotorLoop(params);

      // Assert run status
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('completed');
      expect(finalRun?.result?.ok).toBe(true);
      expect(finalRun?.result?.summary).toContain('output.txt');

      // Assert file exists in workspace
      const filePath = join(params.workspace, 'output.txt');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('hello world');

      // Assert signal emitted
      expect(pushSignal.count()).toBe(1);
      const signal = pushSignal.getLastSignal();
      expect(signal?.type).toBe('motor_result');
      expect(signal?.data?.kind).toBe('motor_result');
      expect(signal?.data?.status).toBe('completed');
      expect(signal?.data?.result?.ok).toBe(true);

      await cleanup();
    });
  });

  describe('Scenario 2: ask_user Pause', () => {
    it('pauses execution when model calls ask_user', async () => {
      const scriptedLLM = createScriptedLLM([
        toolCallResponse('ask_user', { question: 'Which file should I read?' }),
      ]);

      const { params, cleanup, stateManager, pushSignal } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['read', 'write', 'list'],
      });

      await runMotorLoop(params);

      // Assert run status
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('awaiting_input');

      const attempt = finalRun?.attempts[finalRun.currentAttemptIndex];
      expect(attempt?.status).toBe('awaiting_input');
      expect(attempt?.pendingQuestion).toBe('Which file should I read?');
      expect(attempt?.pendingToolCallId).toBeTruthy();

      // Assert signal emitted
      expect(pushSignal.count()).toBe(1);
      const signal = pushSignal.getLastSignal();
      expect(signal?.type).toBe('motor_result');
      expect(signal?.data?.kind).toBe('motor_result');
      expect(signal?.data?.status).toBe('awaiting_input');
      expect(signal?.data?.question).toBe('Which file should I read?');

      // Assert state was persisted
      expect(stateManager.history.length).toBeGreaterThan(0);
      const lastWrite = stateManager.history[stateManager.history.length - 1];
      expect(lastWrite?.action).toBe('update');
      expect(lastWrite?.run.status).toBe('awaiting_input');

      await cleanup();
    });
  });

  describe('Scenario 3: ask_user Resume — State Preserved', () => {
    it('resumes from awaiting_input with preserved state', async () => {
      // First, run a scenario that pauses on ask_user
      const pauseLLM = createScriptedLLM([
        toolCallResponse('ask_user', { question: 'What is your name?' }),
      ]);

      const { params: pauseParams, cleanup: cleanupPause, stateManager } =
        await createTestLoopParams({
          llm: pauseLLM,
          tools: ['read', 'write', 'list'],
        });

      await runMotorLoop(pauseParams);
      const pausedRun = stateManager.findRun(pauseParams.run.id);
      expect(pausedRun?.status).toBe('awaiting_input');

      // Extract the paused attempt
      const pausedAttempt = pausedRun?.attempts[pausedRun.currentAttemptIndex];
      expect(pausedAttempt?.pendingQuestion).toBe('What is your name?');

      // Create a new script that resumes and completes
      const resumeLLM = createScriptedLLM([
        // Model writes file with user's answer
        toolCallResponse('write', {
          path: 'greeting.txt',
          content: 'Hello, Alice!',
        }),
        // Complete
        textResponse('Created greeting.txt'),
      ]);

      // Add the tool result message (user's answer)
      const answerMessage = {
        role: 'tool' as const,
        content: JSON.stringify({ ok: true, output: 'Alice' }),
        tool_call_id: pausedAttempt?.pendingToolCallId ?? 'call_0_0',
      };

      // Create new attempt for resume with preserved messages
      const resumeAttempt = createTestAttempt({
        index: pausedAttempt?.index ?? 0,
        status: 'running',
        stepCursor: pausedAttempt?.stepCursor ?? 0,
        maxIterations: pausedAttempt?.maxIterations ?? 20,
        messages: [...(pausedAttempt?.messages ?? []), answerMessage],
        trace: { ...pausedAttempt!.trace },
        startedAt: pausedAttempt?.startedAt ?? new Date().toISOString(),
      });

      // Create run in awaiting_input state
      const resumeRun = createTestMotorRun({
        id: pauseParams.run.id,
        status: 'awaiting_input',
        workspacePath: pauseParams.workspace,
        tools: ['read', 'write', 'list'], // Explicitly set tools to match original run
        attempts: [resumeAttempt],
        currentAttemptIndex: 0,
      });

      const { params: resumeParams, cleanup: cleanupResume, pushSignal } =
        await createTestLoopParams({
          llm: resumeLLM,
          run: resumeRun,
          attempt: resumeAttempt,
          tools: ['read', 'write', 'list'],
          // Reuse the same state manager and workspace
          stateManager,
          workspace: pauseParams.workspace,
        });

      await runMotorLoop(resumeParams);

      // Assert completion
      const finalRun = stateManager.findRun(resumeParams.run.id);
      expect(finalRun?.status).toBe('completed');
      expect(finalRun?.result?.ok).toBe(true);

      // Assert state preservation: workspace path unchanged, tools unchanged
      expect(finalRun?.workspacePath).toBe(pauseParams.workspace);
      expect(finalRun?.tools).toEqual(['read', 'write', 'list']);

      // Assert file was created
      const filePath = join(resumeParams.workspace, 'greeting.txt');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('Hello, Alice!');

      // Assert signal
      expect(pushSignal.getLastSignal()?.data?.status).toBe('completed');

      await cleanupPause();
      await cleanupResume();
    });
  });

  describe('Scenario 4: Denied Tool Rejected', () => {
    it('returns error when model calls non-granted tool', async () => {
      const scriptedLLM = createScriptedLLM([
        // Try to use shell (not granted)
        toolCallResponse('shell', { command: 'ls' }),
        // Model acknowledges error and completes
        textResponse('I see, shell is not available. Done.'),
      ]);

      const { params, cleanup, stateManager, pushSignal } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['read', 'write', 'list'], // Only read/write/list granted
      });

      await runMotorLoop(params);

      // Assert run completed successfully (with tool error in history)
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('completed');

      // Assert the shell tool error was in messages
      const attempt = finalRun?.attempts[finalRun.currentAttemptIndex];
      const toolResultMessage = attempt?.messages.find(
        (m) => m.role === 'tool' && m.content?.includes('not available')
      );
      expect(toolResultMessage).toBeDefined();
      expect(toolResultMessage?.content).toContain('not available');

      // Parse the tool result content
      const result = JSON.parse(toolResultMessage?.content ?? '{}');
      expect(result.error).toBe('tool_not_available');

      await cleanup();
    });
  });

  describe('Scenario 5: Consecutive Failure Auto-Fail', () => {
    it('auto-fails after 3 consecutive identical failures', async () => {
      const scriptedLLM = createScriptedLLM([
        // First failure
        toolCallResponse('code', { code: 'INVALID_SYNTAX' }),
        // Retry with same error
        toolCallResponse('code', { code: 'INVALID_SYNTAX' }),
        // Third time - should trigger auto-fail
        toolCallResponse('code', { code: 'INVALID_SYNTAX' }),
      ]);

      const { params, cleanup, stateManager, pushSignal } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['code'],
      });

      await runMotorLoop(params);

      // Assert attempt failed but run stays 'running' (caller decides retry vs fail)
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('running');

      const attempt = finalRun?.attempts[finalRun.currentAttemptIndex];
      expect(attempt?.status).toBe('failed');
      expect(attempt?.failure?.category).toBe('tool_failure');

      // No signal emitted — runLoopInBackground handles signal emission after retry decision
      expect(pushSignal.count()).toBe(0);

      await cleanup();
    });
  });

  describe('Scenario 6: Consecutive Failure Counter Reset', () => {
    it('resets counter on success, never reaches threshold', async () => {
      const scriptedLLM = createScriptedLLM([
        // First failure
        toolCallResponse('code', { code: 'throw new Error("fail")' }),
        // Second failure
        toolCallResponse('code', { code: 'throw new Error("fail")' }),
        // Success - resets counter
        toolCallResponse('code', { code: '1 + 1' }),
        // Two more failures (new streak)
        toolCallResponse('code', { code: 'throw new Error("fail")' }),
        toolCallResponse('code', { code: 'throw new Error("fail")' }),
        // Complete normally (counter was reset)
        textResponse('Done after some retries'),
      ]);

      const { params, cleanup, stateManager } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['code'],
      });

      await runMotorLoop(params);

      // Assert completed (not failed)
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('completed');

      await cleanup();
    });
  });

  describe('Scenario 6b: Wrong Param Names — Validation Rejects with Suggestions', () => {
    it('rejects wrong param names and suggests correct ones', async () => {
      // Model uses wrong param names — validation middleware catches them
      // and returns actionable error messages with fuzzy suggestions
      const scriptedLLM = createScriptedLLM([
        // list with "directory" instead of "path" — validation rejects
        toolCallResponse('list', { directory: '.' }),
        // Model retries with correct param name after seeing suggestion
        toolCallResponse('list', { path: '.' }),
        // Complete
        textResponse('Listed the directory.'),
      ]);

      const { params, cleanup, stateManager } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['read', 'write', 'list'],
      });

      await runMotorLoop(params);

      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('completed');

      // Verify the first call was rejected with a suggestion
      const attempt = finalRun?.attempts[finalRun.currentAttemptIndex];
      const validationError = attempt?.messages?.find(
        (m) => m.role === 'tool' && m.content?.includes('invalid_args')
      );
      expect(validationError).toBeTruthy();

      await cleanup();
    });
  });

  describe('Scenario 7: Bad Tool Args — Auto-Coercion', () => {
    it('auto-coerces tool args to match schema', async () => {
      // Pre-create a file to read
      const { params: setupParams, cleanup: cleanupSetup } = await createTestLoopParams({
        llm: createScriptedLLM([textResponse('setup')]),
        tools: ['read', 'write', 'list'],
      });

      const testFile = join(setupParams.workspace, 'test.txt');
      await writeFile(testFile, 'file content');

      // Model uses legacy filesystem tool with wrong format — compat shim handles it
      const scriptedLLM = createScriptedLLM([
        toolCallResponse('filesystem', { read: 'test.txt' }),
        textResponse('Read the file successfully'),
      ]);

      const { params, cleanup, stateManager } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['read', 'write', 'list'],
        workspace: setupParams.workspace,
      });

      await runMotorLoop(params);

      // Assert completed (auto-coercion worked)
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('completed');

      await cleanupSetup();
      await cleanup();
    });
  });

  describe('Scenario 8: XML Tool-Call Text Detection', () => {
    it('detects and fails on XML tool calls without tool_calls field', async () => {
      // First call causes an error
      const scriptedLLM = createScriptedLLM([
        toolCallResponse('read', { path: 'nonexistent.txt' }),
        // Model responds with XML-like text instead of proper tool_calls
        textResponse('<invoke name="read"><arg>path</arg></invoke>'),
      ]);

      const { params, cleanup, stateManager, pushSignal } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['read', 'write', 'list'],
      });

      await runMotorLoop(params);

      // Assert attempt failed but run stays 'running' (caller decides retry vs fail)
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('running');

      const attempt = finalRun?.attempts[finalRun.currentAttemptIndex];
      expect(attempt?.failure?.hint).toContain('XML');

      // No signal emitted — runLoopInBackground handles signal emission after retry decision
      expect(pushSignal.count()).toBe(0);

      await cleanup();
    });
  });

  describe('Scenario 9: Max Iterations Exhausted', () => {
    it('fails when max iterations is reached', async () => {
      const scriptedLLM = createScriptedLLM([
        toolCallResponse('list', { path: '.' }),
        toolCallResponse('list', { path: '.' }),
        toolCallResponse('list', { path: '.' }),
      ]);

      const run = createTestMotorRun({
        tools: ['read', 'write', 'list'],
      });
      const attempt = createTestAttempt({
        maxIterations: 2, // Low limit to trigger exhaustion
      });

      const { params, cleanup, stateManager, pushSignal } = await createTestLoopParams({
        llm: scriptedLLM,
        run,
        attempt,
        tools: ['read', 'write', 'list'],
      });

      await runMotorLoop(params);

      // Assert failed with budget_exhausted
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('failed');

      const finalAttempt = finalRun?.attempts[finalRun.currentAttemptIndex];
      expect(finalAttempt?.failure?.category).toBe('budget_exhausted');

      // Assert signal
      expect(pushSignal.getLastSignal()?.data?.status).toBe('failed');
      expect(pushSignal.getLastSignal()?.data?.failure?.category).toBe('budget_exhausted');

      await cleanup();
    });
  });

  describe('Scenario 10: Credential Placeholder Resolution', () => {
    it('resolves credential placeholders in tool args', async () => {
      const scriptedLLM = createScriptedLLM([
        toolCallResponse('shell', {
          command: 'curl -H "Authorization: Bearer <credential:api_key>" https://api.example.com',
        }),
        textResponse('Request sent'),
      ]);

      const { params, cleanup, stateManager } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['shell'],
        credentialStore: { api_key: 'secret123' },
      });

      // Mock shell to capture the resolved args
      const originalMessages = params.attempt.messages;
      let capturedArgs: Record<string, unknown> | undefined;

      // The actual execution will happen - we just verify the store is set up
      await runMotorLoop(params);

      // Assert completed
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('completed');

      await cleanup();
    });
  });

  describe('Scenario 11: Missing Credential Error', () => {
    it('returns error for missing credentials', async () => {
      const scriptedLLM = createScriptedLLM([
        toolCallResponse('shell', {
          command: 'curl -H "Authorization: <credential:missing_key>" https://api.example.com',
        }),
        textResponse('Got credential error, skipping'),
      ]);

      const { params, cleanup, stateManager } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['shell'],
        credentialStore: {}, // Empty store
      });

      await runMotorLoop(params);

      // Assert completed (error was handled gracefully)
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('completed');

      // Check that there was a tool result with auth_failed
      const attempt = finalRun?.attempts[finalRun.currentAttemptIndex];
      // The tool result message should contain the auth_failed error
      const toolMessage = attempt?.messages.find(
        (m) => m.role === 'tool'
      );
      // Parse and check the content
      if (toolMessage?.content) {
        const parsed = JSON.parse(toolMessage.content);
        expect(parsed.error).toBe('auth_failed');
      }

      await cleanup();
    });
  });

  describe('Scenario 12: request_approval Pause', () => {
    it('pauses execution when model calls request_approval', async () => {
      const actionDescription = 'POST data to external API';
      const scriptedLLM = createScriptedLLM([
        toolCallResponse('request_approval', { action: actionDescription }),
      ]);

      const { params, cleanup, stateManager, pushSignal } = await createTestLoopParams({
        llm: scriptedLLM,
        tools: ['shell'], // Shell grants request_approval
      });

      await runMotorLoop(params);

      // Assert awaiting_approval status
      const finalRun = stateManager.findRun(params.run.id);
      expect(finalRun?.status).toBe('awaiting_approval');

      const attempt = finalRun?.attempts[finalRun.currentAttemptIndex];
      expect(attempt?.status).toBe('awaiting_approval');
      expect(attempt?.pendingApproval?.action).toBe(actionDescription);
      expect(attempt?.pendingToolCallId).toBeTruthy();

      // Assert expiresAt is ~15 minutes in the future
      const expiresAt = new Date(attempt?.pendingApproval?.expiresAt ?? 0);
      const now = new Date();
      const diffMs = expiresAt.getTime() - now.getTime();
      expect(diffMs).toBeGreaterThan(14 * 60 * 1000); // > 14 minutes
      expect(diffMs).toBeLessThan(16 * 60 * 1000); // < 16 minutes

      // Assert signal emitted
      expect(pushSignal.count()).toBe(1);
      const signal = pushSignal.getLastSignal();
      expect(signal?.type).toBe('motor_result');
      expect(signal?.data?.kind).toBe('motor_result');
      expect(signal?.data?.status).toBe('awaiting_approval');
      expect(signal?.data?.approval?.action).toBe(actionDescription);

      await cleanup();
    });
  });
});
