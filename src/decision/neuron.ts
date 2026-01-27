/**
 * Neuron-like weighted function for decision making.
 *
 * Instead of if/else chains, key decisions use weighted functions.
 * This provides:
 * - Explainability: Can trace exactly why agent acted
 * - Tunability: Weights are adjustable, not buried in code
 * - Learning-ready: Weights can be updated based on feedback
 */

/**
 * Input to a neuron: a value (0-1) and its weight.
 */
export interface NeuronInput {
  /** Name of this input (for tracing) */
  name: string;
  /** Current value (0-1) */
  value: number;
  /** Weight/importance (0-1) */
  weight: number;
}

/**
 * Result from neuron evaluation with full trace.
 */
export interface NeuronResult {
  /** Final output value (0-1) */
  output: number;
  /** Individual contributions from each input */
  contributions: {
    name: string;
    value: number;
    weight: number;
    contribution: number;
  }[];
  /** Sum of all weights (for normalization check) */
  totalWeight: number;
}

/**
 * Evaluate a neuron-like weighted function.
 *
 * Takes multiple inputs with weights and produces a single output.
 * Output is normalized to 0-1 range.
 *
 * @example
 * const result = neuron([
 *   { name: 'socialDebt', value: 0.8, weight: 0.7 },
 *   { name: 'taskPressure', value: 0.3, weight: 0.3 },
 *   { name: 'userAvailable', value: 0.9, weight: 0.5 },
 * ]);
 * // result.output = weighted average
 * // result.contributions = breakdown of each input's effect
 */
export function neuron(inputs: NeuronInput[]): NeuronResult {
  if (inputs.length === 0) {
    return {
      output: 0,
      contributions: [],
      totalWeight: 0,
    };
  }

  const contributions = inputs.map((input) => ({
    name: input.name,
    value: clamp(input.value),
    weight: clamp(input.weight),
    contribution: clamp(input.value) * clamp(input.weight),
  }));

  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  const weightedSum = contributions.reduce((sum, c) => sum + c.contribution, 0);

  // Normalize by total weight (weighted average)
  const output = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    output: clamp(output),
    contributions,
    totalWeight,
  };
}

/**
 * Clamp value to 0-1 range.
 */
function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Create a neuron with fixed weights (factory pattern).
 *
 * @example
 * const contactPressure = createNeuron({
 *   socialDebt: 0.7,
 *   taskPressure: 0.3,
 *   userAvailable: 0.5,
 * });
 *
 * // Later:
 * const result = contactPressure({
 *   socialDebt: 0.8,
 *   taskPressure: 0.2,
 *   userAvailable: 0.9,
 * });
 */
export function createNeuron(
  weights: Record<string, number>
): (values: Record<string, number>) => NeuronResult {
  return (values: Record<string, number>) => {
    const inputs: NeuronInput[] = Object.entries(weights).map(([name, weight]) => ({
      name,
      value: values[name] ?? 0,
      weight,
    }));
    return neuron(inputs);
  };
}

/**
 * Pre-configured neuron for contact pressure calculation.
 *
 * Factors:
 * - socialDebt: How long since last interaction (weight: 0.4)
 * - taskPressure: Pending things to discuss (weight: 0.2)
 * - curiosity: Agent's desire to engage (weight: 0.1)
 * - userAvailability: Belief about user being free (weight: 0.3)
 */
export const contactPressureNeuron = createNeuron({
  socialDebt: 0.4,
  taskPressure: 0.2,
  curiosity: 0.1,
  userAvailability: 0.3,
});

/**
 * Pre-configured neuron for determining agent's alertness.
 *
 * Factors:
 * - energy: Agent's current energy (weight: 0.4)
 * - recentActivity: How active things have been (weight: 0.3)
 * - timeOfDay: Circadian factor (weight: 0.3)
 */
export const alertnessNeuron = createNeuron({
  energy: 0.4,
  recentActivity: 0.3,
  timeOfDay: 0.3,
});
