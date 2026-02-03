/**
 * Web Fetch Tool
 *
 * Tool definition for fetching web pages and converting to markdown.
 */

import type { PluginPrimitives, PluginTool, PluginToolContext } from '../../types/plugin.js';
import type { WebFetchInput, WebFetchResponse } from '../web-shared/types.js';
import { fetchPage } from './fetcher.js';

/**
 * JSON Schema for the fetch tool parameters.
 * Uses OpenAI strict mode compatible format.
 */
const FETCH_RAW_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'The URL to fetch (must be http or https)',
    },
    timeoutMs: {
      type: ['number', 'null'],
      description: 'Timeout in milliseconds (default: 30000, max: 30000)',
    },
    maxBytes: {
      type: ['number', 'null'],
      description: 'Maximum bytes to read (default: 1000000, max: 1000000)',
    },
    maxMarkdownBytes: {
      type: ['number', 'null'],
      description: 'Maximum markdown output size (default: 64000, max: 64000)',
    },
    respectRobots: {
      type: ['boolean', 'null'],
      description: 'Whether to respect robots.txt (default: true)',
    },
  },
  required: ['url'],
  additionalProperties: false,
};

/**
 * Create the web fetch tool.
 */
export function createFetchTool(primitives: PluginPrimitives): PluginTool {
  const { logger } = primitives;

  return {
    name: 'fetch',
    description: `Fetch a web page and convert its content to markdown.

Returns the page content as sanitized markdown, along with metadata like final URL (after redirects), content type, and charset.

**Safety:**
- Only http/https URLs allowed
- Private/internal IPs blocked (SSRF protection)
- Respects robots.txt by default
- Content is marked as untrusted

**Supported content types:**
- text/html (converted to markdown)
- text/plain (returned as-is)
- application/json (formatted)
- application/xhtml+xml`,

    tags: ['fetch', 'http', 'web', 'markdown', 'html'],

    rawParameterSchema: FETCH_RAW_SCHEMA,

    parameters: [
      {
        name: 'url',
        type: 'string',
        description: 'The URL to fetch (must be http or https)',
        required: true,
      },
      {
        name: 'timeoutMs',
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000, max: 30000)',
        required: false,
        default: 30000,
      },
      {
        name: 'maxBytes',
        type: 'number',
        description: 'Maximum bytes to read (default: 1000000, max: 1000000)',
        required: false,
        default: 1000000,
      },
      {
        name: 'maxMarkdownBytes',
        type: 'number',
        description: 'Maximum markdown output size (default: 64000, max: 64000)',
        required: false,
        default: 64000,
      },
      {
        name: 'respectRobots',
        type: 'boolean',
        description: 'Whether to respect robots.txt (default: true)',
        required: false,
        default: true,
      },
    ],

    validate: (args) => {
      const a = args as Record<string, unknown>;

      // URL is required
      if (!a['url'] || typeof a['url'] !== 'string') {
        return { success: false, error: 'url: required string parameter' };
      }

      // Basic URL format check
      const url = a['url'];
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { success: false, error: 'url: must start with http:// or https://' };
      }

      // Validate optional parameters
      if (a['timeoutMs'] !== undefined && a['timeoutMs'] !== null) {
        if (typeof a['timeoutMs'] !== 'number' || a['timeoutMs'] <= 0) {
          return { success: false, error: 'timeoutMs: must be a positive number' };
        }
      }

      if (a['maxBytes'] !== undefined && a['maxBytes'] !== null) {
        if (typeof a['maxBytes'] !== 'number' || a['maxBytes'] <= 0) {
          return { success: false, error: 'maxBytes: must be a positive number' };
        }
      }

      if (a['maxMarkdownBytes'] !== undefined && a['maxMarkdownBytes'] !== null) {
        if (typeof a['maxMarkdownBytes'] !== 'number' || a['maxMarkdownBytes'] <= 0) {
          return { success: false, error: 'maxMarkdownBytes: must be a positive number' };
        }
      }

      if (a['respectRobots'] !== undefined && a['respectRobots'] !== null) {
        if (typeof a['respectRobots'] !== 'boolean') {
          return { success: false, error: 'respectRobots: must be a boolean' };
        }
      }

      return { success: true, data: a };
    },

    execute: async (args, _context?: PluginToolContext): Promise<WebFetchResponse> => {
      const input: WebFetchInput = {
        url: args['url'] as string,
        timeoutMs: args['timeoutMs'] as number | undefined,
        maxBytes: args['maxBytes'] as number | undefined,
        maxMarkdownBytes: args['maxMarkdownBytes'] as number | undefined,
        respectRobots: args['respectRobots'] as boolean | undefined,
      };

      return fetchPage(input, logger);
    },
  };
}
