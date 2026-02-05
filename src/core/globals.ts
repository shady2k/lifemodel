/**
 * Global state accessors for CORE components only.
 *
 * ⚠️  PLUGINS MUST NOT IMPORT THIS FILE.
 * Plugins receive recipientId through FilterContext.primaryRecipientId instead.
 *
 * This module provides global accessors for state that is:
 * 1. Set once during initialization
 * 2. Immutable after startup
 * 3. Needed by multiple unrelated core components (layers, providers)
 *
 * Using global accessors avoids threading values through every layer,
 * which is error-prone and verbose. This pattern is safe because:
 * - Values are set during container initialization (before any usage)
 * - Values never change after startup
 * - All accessors handle the "not yet initialized" case gracefully
 */

/**
 * Primary recipient ID - the main user the system interacts with.
 * Set during CoreLoop initialization from config.primaryUserChatId.
 */
let primaryRecipientId: string | undefined;

/**
 * Set the primary recipient ID.
 * Called by CoreLoop during initialization.
 */
export function setPrimaryRecipientId(recipientId: string | undefined): void {
  primaryRecipientId = recipientId;
}

/**
 * Get the primary recipient ID.
 * Returns undefined if not yet initialized or not configured.
 */
export function getPrimaryRecipientId(): string | undefined {
  return primaryRecipientId;
}

/**
 * Require the primary recipient ID.
 * Throws if not initialized - use when recipientId is mandatory.
 */
export function requirePrimaryRecipientId(): string {
  if (!primaryRecipientId) {
    throw new Error('Primary recipient ID not initialized');
  }
  return primaryRecipientId;
}
