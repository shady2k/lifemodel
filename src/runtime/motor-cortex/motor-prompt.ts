/**
 * Motor Cortex Prompt Builder
 *
 * Builds system prompts for Motor Cortex runs.
 * This module is used by core.act - NOT by Motor Cortex itself.
 * Motor Cortex receives the prompt as an opaque string.
 *
 * ## Separation of concerns
 *
 * This module only knows about Motor Cortex runtime concepts:
 * - Available tools and their descriptions
 * - Domain restrictions / network access rules
 * - Iteration limits
 * - Recovery context for retry attempts
 * - File path conventions, output truncation
 *
 * Skill-specific knowledge (SKILL.md format, skill improvement rules,
 * credential guidance, dependency info) is passed from the caller
 * via the `callerInstructions` field — an opaque string that gets
 * appended to the prompt. Motor Cortex never interprets it.
 */

import type { MotorTool, SyntheticTool, MotorAttempt } from './motor-protocol.js';

/**
 * Context for building a Motor Cortex system prompt.
 */
export interface MotorPromptContext {
  /** Task description */
  task: string;

  /** Tools available to the sub-agent */
  tools: MotorTool[];

  /** Synthetic tools to inject */
  syntheticTools: SyntheticTool[];

  /** Allowed network domains */
  domains?: string[];

  /** Maximum iterations */
  maxIterations?: number;

  /** Recovery context for retry attempts */
  recoveryContext?: MotorAttempt['recoveryContext'];

  /**
   * Opaque instructions from the caller (e.g. skill context, credential
   * guidance, custom task instructions). Appended to the prompt as-is.
   * Motor Cortex never interprets this content.
   */
  callerInstructions?: string;
}

/**
 * Tool descriptions for the system prompt.
 */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: '- read: Read a file (line numbers, offset/limit for pagination, max 2000 lines)',
  write: '- write: Write content to a file (auto-creates directories)',
  list: '- list: List files and directories (optional recursive mode)',
  glob: '- glob: Find files by glob pattern (e.g., "**/*.ts")',
  ask_user: '- ask_user: Ask the user a question (pauses execution)',
  save_credential:
    '- save_credential: Save a credential (e.g. API key from signup) for future runs',
  bash: '- bash: Run commands (node, npm, npx, python, pip, curl, jq, grep, git, etc.). Supports pipes, loops (for/while), and conditionals. Full async Node.js via "node script.js".',
  grep: '- grep: Search patterns across files (regex, max 100 matches)',
  patch: '- patch: Find-and-replace text in a file (whitespace-flexible matching)',
  fetch: '- fetch: Fetch a URL (GET/POST). Returns page content. Prefer over curl.',
};

/**
 * Build the system prompt for a Motor Cortex run.
 *
 * This function is called by core.act to build the prompt.
 * The prompt is then passed to Motor Cortex as an opaque string.
 */
export function buildMotorSystemPrompt(ctx: MotorPromptContext): string {
  const {
    task,
    tools,
    syntheticTools,
    domains,
    maxIterations,
    recoveryContext,
    callerInstructions,
  } = ctx;

  // Include only configured synthetic tools in the description
  const allTools: string[] = [...tools, ...syntheticTools];
  const toolsDesc = allTools.map((t) => TOOL_DESCRIPTIONS[t] ?? `- ${t}`).join('\n');

  // Recovery context injection for retry attempts
  const recoverySection = recoveryContext
    ? `\n\n<recovery_context source="${recoveryContext.source}">
Previous attempt (${recoveryContext.previousAttemptId}) failed.
Guidance: ${recoveryContext.guidance}${
        recoveryContext.constraints && recoveryContext.constraints.length > 0
          ? `\nConstraints:\n${recoveryContext.constraints.map((c) => `- ${c}`).join('\n')}`
          : ''
      }
</recovery_context>`
    : '';

  return `You are a task execution assistant. Your job is to complete the following task using the available tools.

Task: ${task}

Available tools:
${toolsDesc}

Guidelines:
- Break down complex tasks into steps
- Use read to inspect files (supports offset/limit for large files)
- Use write to create or overwrite files (workspace only)
- Use list/glob to discover workspace structure
- Use grep to find content across files
- Use patch for precise edits (prefer over full file rewrites)
- Use fetch for HTTP requests (preferred over bash+curl — handles credentials, domain checks, HTML→markdown)
- Use bash for runtime execution (node scripts, npm install, python, pip) and text processing with pipes
- Be concise and direct in your responses
- Report what you did and the result
- If something is blocked, denied, or fails repeatedly (2+ times), call ask_user to report the problem and ask for guidance. Do NOT silently work around blockers by guessing or fabricating content.
- When downloading files from a repository, always fetch the actual source content. Do NOT reconstruct or rewrite file contents from previews, summaries, or truncated output — download the raw file or copy from the saved .motor-output/ file instead.
- File paths: use RELATIVE paths for workspace files (e.g. "output.txt", "SKILL.md"). Skill files are at workspace root and can be modified directly.
- Credentials are environment variables. Use process.env.NAME in Node scripts, os.environ["NAME"] in Python, $NAME in bash commands and fetch headers. The system resolves $NAME in all tool arguments automatically.
- Large tool outputs are automatically truncated and saved to .motor-output/. When you see "Output truncated", use read to view sections or bash cp to copy the file (e.g. bash({"command":"cp .motor-output/fetch-abc123.txt references/doc.md"})). NEVER write file contents from memory — always read or copy from the saved file.
${
  domains && domains.length > 0
    ? `
Allowed network domains:
${domains.map((d) => `- ${d}`).join('\n')}
Requests to any other domain will be BLOCKED.
CRITICAL: When a domain is blocked, you MUST immediately call ask_user to request access. Do NOT try alternative URLs, do NOT try different domains, do NOT fabricate or guess content. Stop and ask_user FIRST.
Signs of a blocked domain: "fetch failed", "Could not resolve host", "EAI_AGAIN", "ENOTFOUND", empty curl output, or any DNS error. If you see ANY of these, the domain is likely not in the allowed list — call ask_user immediately instead of retrying.
Do NOT run npm install or pip install — registries are not reachable. Pre-installed packages (if any) are already available via require() or import.
For API calls, prefer the fetch tool. In bash/node scripts, use Node's built-in global fetch() (no import needed) or curl.`
    : `
Network access is disabled. All tasks must be completed using local tools only.
Do NOT run npm install or pip install — there is no network access. Pre-installed packages (if any) are already available via require() or import.`
}

Maximum iterations: ${String(maxIterations ?? 30)}

Begin by analyzing the task and planning your approach. Then execute step by step.${callerInstructions ? `\n\n${callerInstructions}` : ''}${recoverySection}`;
}
