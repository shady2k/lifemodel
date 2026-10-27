export const configureAgent = ({configFile, workDirectory}) => ({SCRIPTED_CONFIG: configFile, SCRIPTED_SCENARIO_FILE: workDirectory + '/scenario'});
export const toolOutputFailed = output => output?.customFailure === true;
export { admit, observeInsertion, reconcileEndTurn } from '../../loader/src/task-opencode.js';
