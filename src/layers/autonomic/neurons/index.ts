/**
 * Neuron exports for AUTONOMIC layer.
 */

export { SocialDebtNeuron, createSocialDebtNeuron } from './social-debt.js';
export type { SocialDebtNeuronConfig } from './social-debt.js';

export { EnergyNeuron, createEnergyNeuron } from './energy.js';
export type { EnergyNeuronConfig } from './energy.js';

export { ContactPressureNeuron, createContactPressureNeuron } from './contact-pressure.js';
export type { ContactPressureNeuronConfig } from './contact-pressure.js';

export { TimeNeuron, createTimeNeuron } from './time.js';
export type { TimeNeuronConfig, TimeOfDay } from './time.js';

export { AlertnessNeuron, createAlertnessNeuron } from './alertness.js';
export type { AlertnessNeuronConfig } from './alertness.js';
