# Channels

Sensory organs - how the agent perceives the outside world.

## Role

Channels receive external input and convert it to signals:
- Telegram message → `user_message` signal
- Connection lost → `channel_disconnected` signal
- Error occurred → `channel_error` signal

## Available Channels

| Channel | Input |
|---------|-------|
| Telegram | User messages, commands |
| Discord | Server messages |

## Output

Channels also handle outbound messages when CoreLoop applies `SEND_MESSAGE` intents.

## Lifecycle

- `connect()` - Establish connection
- `disconnect()` - Clean shutdown
- Event handlers emit signals to brain

## Adding Channels

Implement the Channel interface:
- Register with core
- Emit signals for incoming events
- Handle outbound message intents
