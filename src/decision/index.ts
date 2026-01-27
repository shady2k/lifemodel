export {
  neuron,
  createNeuron,
  contactPressureNeuron,
  alertnessNeuron,
  ConfigurableNeuron,
  createConfigurableContactPressureNeuron,
  createConfigurableAlertnessNeuron,
  type NeuronInput,
  type NeuronResult,
  type WeightBounds,
} from './neuron.js';

export {
  ContactDecider,
  createContactDecider,
  type ContactDeciderConfig,
  type ContactDecision,
} from './contact-decider.js';
