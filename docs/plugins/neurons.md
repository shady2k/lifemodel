# Neurons

Monitor state and emit signals on meaningful change. Part of AUTONOMIC layer.

## How Neurons Work

1. Neuron observes some state (energy, time, social debt, etc.)
2. On each tick, checks if state changed meaningfully
3. If change exceeds threshold → emit signal
4. AUTONOMIC passes signal up to AGGREGATION

## Weber-Fechner Law

Neurons use relative thresholds, not absolute:
- Change = `log(new / old)`
- 1000→1001 (0.1% change) less significant than 1→2 (100% change)

This prevents:
- Noise in high-value states
- Missing subtle changes in low-value states

## Built-in Neurons

| Neuron | Monitors | Emits |
|--------|----------|-------|
| EnergyNeuron | Energy level | `energy` signal |
| AlertnessNeuron | Alertness state | `alertness` signal |
| TimeNeuron | Time boundaries | `hour_changed`, `time_of_day` |
| SocialDebtNeuron | Contact debt | `social_debt` signal |
| ContactPressureNeuron | Combined urgency | `contact_pressure` signal |
| ThoughtsNeuron | Thought pressure | `thought_pressure` signal |

## Custom Neurons

Plugins can register neurons via manifest. They receive state each tick and return signals to emit.
