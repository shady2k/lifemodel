export type { Channel, CircuitStats, SendOptions } from './channel.js';

// Telegram channel (from plugins)
export {
  TelegramChannel,
  createTelegramChannel,
  TelegramError,
  type TelegramConfig,
  type TelegramMessagePayload,
} from '../plugins/channels/telegram.js';
