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
 * - acquaintancePressure: Pressure to learn user's name (weight: 0.3)
 */
const contactPressureNeuronBase = createNeuron({
  socialDebt: 0.4,
  taskPressure: 0.2,
  curiosity: 0.1,
  acquaintancePressure: 0.3,
});

export function contactPressureNeuron(values: Record<string, number>): NeuronResult {
  if (values['acquaintancePressure'] === undefined && values['userAvailability'] !== undefined) {
    return contactPressureNeuronBase({
      ...values,
      acquaintancePressure: values['userAvailability'],
    });
  }
  return contactPressureNeuronBase(values);
}

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

/**
 * Weight bounds for learning.
 */
export interface WeightBounds {
  /** Minimum weight value (default: 0.01) */
  min: number;
  /** Maximum weight value (default: 1.0) */
  max: number;
}

const DEFAULT_WEIGHT_BOUNDS: WeightBounds = {
  min: 0.01,
  max: 1.0,
};

/**
 * ConfigurableNeuron - a neuron with mutable weights for learning.
 *
 * Unlike the fixed createNeuron factory, this class allows weights
 * to be updated at runtime based on feedback, enabling self-learning.
 *
 * @example
 * const neuron = new ConfigurableNeuron({
 *   socialDebt: 0.4,
 *   taskPressure: 0.2,
 * });
 *
 * // Evaluate
 * const result = neuron.evaluate({ socialDebt: 0.8, taskPressure: 0.3 });
 *
 * // Learn from feedback
 * neuron.updateWeight('socialDebt', 0.05); // Increase weight
 * neuron.updateWeight('taskPressure', -0.02); // Decrease weight
 */
export class ConfigurableNeuron {
  private weights: Record<string, number>;
  private readonly bounds: WeightBounds;
  private readonly name: string;

  constructor(
    initialWeights: Record<string, number>,
    options?: { name?: string; bounds?: Partial<WeightBounds> }
  ) {
    this.weights = { ...initialWeights };
    this.name = options?.name ?? 'unnamed';
    this.bounds = { ...DEFAULT_WEIGHT_BOUNDS, ...options?.bounds };

    // Clamp initial weights to bounds
    for (const key of Object.keys(this.weights)) {
      const weight = this.weights[key];
      if (weight !== undefined) {
        this.weights[key] = this.clampWeight(weight);
      }
    }
  }

  /**
   * Get the neuron's name.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Evaluate the neuron with given input values.
   */
  evaluate(values: Record<string, number>): NeuronResult {
    const inputs: NeuronInput[] = Object.entries(this.weights).map(([name, weight]) => ({
      name,
      value: values[name] ?? 0,
      weight,
    }));
    return neuron(inputs);
  }

  /**
   * Update a single weight by a delta amount.
   *
   * @param inputName The name of the input to update
   * @param delta The amount to add (positive) or subtract (negative)
   * @returns The new weight value, or null if inputName doesn't exist
   */
  updateWeight(inputName: string, delta: number): number | null {
    const oldWeight = this.weights[inputName];
    if (oldWeight === undefined) {
      return null;
    }

    const newWeight = this.clampWeight(oldWeight + delta);
    this.weights[inputName] = newWeight;

    return newWeight;
  }

  /**
   * Set a weight to an absolute value.
   *
   * @param inputName The name of the input to set
   * @param value The new weight value
   * @returns The clamped weight value, or null if inputName doesn't exist
   */
  setWeight(inputName: string, value: number): number | null {
    if (!(inputName in this.weights)) {
      return null;
    }

    const newWeight = this.clampWeight(value);
    this.weights[inputName] = newWeight;

    return newWeight;
  }

  /**
   * Get a single weight value.
   */
  getWeight(inputName: string): number | undefined {
    return this.weights[inputName];
  }

  /**
   * Get all current weights (readonly copy).
   */
  getWeights(): Readonly<Record<string, number>> {
    return { ...this.weights };
  }

  /**
   * Set all weights at once (for restoring from persistence).
   */
  setWeights(weights: Record<string, number>): void {
    for (const [key, value] of Object.entries(weights)) {
      if (key in this.weights) {
        this.weights[key] = this.clampWeight(value);
      }
    }
  }

  /**
   * Get the weight bounds.
   */
  getBounds(): Readonly<WeightBounds> {
    return { ...this.bounds };
  }

  /**
   * Check if the neuron has a specific input.
   */
  hasInput(inputName: string): boolean {
    return inputName in this.weights;
  }

  /**
   * Get all input names.
   */
  getInputNames(): string[] {
    return Object.keys(this.weights);
  }

  /**
   * Clamp weight to bounds.
   */
  private clampWeight(value: number): number {
    return Math.max(this.bounds.min, Math.min(this.bounds.max, value));
  }
}

/**
 * Create a configurable neuron for contact pressure calculation.
 */
export function createConfigurableContactPressureNeuron(): ConfigurableNeuron {
  return new ConfigurableNeuron(
    {
      socialDebt: 0.4,
      taskPressure: 0.2,
      curiosity: 0.1,
      acquaintancePressure: 0.3,
    },
    { name: 'contactPressure' }
  );
}

/**
 * Create a configurable neuron for alertness calculation.
 */
export function createConfigurableAlertnessNeuron(): ConfigurableNeuron {
  return new ConfigurableNeuron(
    {
      energy: 0.4,
      recentActivity: 0.3,
      timeOfDay: 0.3,
    },
    { name: 'alertness' }
  );
}
