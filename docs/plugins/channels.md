# Gateway and channel boundary

The core does not configure a delivery channel. External gateways append user
messages to the Valkey `inbound` stream. The core commits answers to the
Valkey `outbound` stream and message rows to Postgres. A gateway can consume
outbound events with its own delivery cursor.

The shared `Channel` interface remains for channel adapters. No channel
adapter is registered by the core in this stage. An outbound event without a
registered adapter remains committed for the future gateway; the core logs it
once and advances only its own delivery cursor.
