/**
 * Telegram Group Fetcher (Private Groups)
 *
 * Fetches messages from private Telegram groups using a Docker-based
 * Playwright script with a pre-authenticated browser profile.
 *
 * Unlike the public channel fetcher (telegram.ts) which scrapes t.me/s/,
 * this uses ScriptRunnerPrimitive to run the browser in a container.
 */

import type { ScriptRunnerPrimitive, PluginScriptRunResult } from '../../../types/plugin.js';
import type { FetchedArticle } from '../types.js';

const SCRIPT_ID = 'news.telegram_group.fetch';

/**
 * Result from fetching a Telegram group.
 */
export interface TelegramGroupFetchResult {
  success: boolean;
  articles: FetchedArticle[];
  error?: string | undefined;
  /** Error code from script (e.g., NOT_AUTHENTICATED) */
  errorCode?: string | undefined;
  /** ID of the most recent message */
  latestId?: string | undefined;
}

/**
 * Message shape returned by the telegram-group-fetch.js script.
 */
interface ScriptMessage {
  id: string;
  text: string;
  date: string;
  from: string;
}

/**
 * Convert a script message to a FetchedArticle.
 */
function messageToArticle(
  msg: ScriptMessage,
  sourceId: string,
  sourceName: string
): FetchedArticle {
  const title = msg.text
    ? (msg.text
        .split(/[\n.]/)
        .find((l) => l.trim())
        ?.slice(0, 150) ?? msg.text.slice(0, 150))
    : `Message ${msg.id}`;

  const summary = msg.text && msg.text.length > 150 ? msg.text.slice(150, 650) : undefined;

  const publishedAt = msg.date ? new Date(msg.date) : undefined;

  return {
    id: `tg_group_${sourceId}_${msg.id}`,
    title: msg.from ? `[${msg.from}] ${title}` : title,
    summary,
    sourceId,
    sourceName,
    publishedAt: publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt : undefined,
  };
}

/**
 * Fetch messages from a private Telegram group via script runner.
 *
 * @param profile - Browser profile name (must be pre-authenticated)
 * @param groupUrl - Full Telegram Web URL for the group
 * @param sourceId - Source ID for article tagging
 * @param sourceName - Human-readable source name
 * @param lastSeenId - Last seen message ID for deduplication
 * @param scriptRunner - Plugin's scoped script runner
 * @returns Fetch result with articles or error
 */
export async function fetchTelegramGroup(
  profile: string,
  groupUrl: string,
  sourceId: string,
  sourceName: string,
  lastSeenId: string | undefined,
  scriptRunner: ScriptRunnerPrimitive
): Promise<TelegramGroupFetchResult> {
  let result: PluginScriptRunResult;
  try {
    result = await scriptRunner.runScript({
      scriptId: SCRIPT_ID,
      inputs: {
        profile,
        groupUrl,
        lastSeenId,
        maxMessages: 50,
      },
      timeoutMs: 120_000,
    });
  } catch (error) {
    return {
      success: false,
      articles: [],
      error: `Script execution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!result.ok) {
    const errorCode = result.error?.code;
    const errorMsg = result.error?.message ?? 'Unknown script error';

    return {
      success: false,
      articles: [],
      error: errorMsg,
      errorCode,
    };
  }

  // Parse script output
  const output = result.output as
    | {
        ok: boolean;
        messages: ScriptMessage[];
        latestId: string | null;
        error?: { code: string; message: string };
      }
    | undefined;

  if (!output) {
    return {
      success: false,
      articles: [],
      error: 'Script returned no output',
    };
  }

  if (!output.ok) {
    return {
      success: false,
      articles: [],
      error: output.error?.message ?? 'Script reported failure',
      errorCode: output.error?.code,
    };
  }

  const articles = (output.messages ?? []).map((msg) =>
    messageToArticle(msg, sourceId, sourceName)
  );

  return {
    success: true,
    articles,
    latestId: output.latestId ?? articles[0]?.id,
  };
}
