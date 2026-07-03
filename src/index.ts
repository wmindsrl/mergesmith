// Public API of @wmind/mergesmith — for consumers and provider authors.
export * from './config.js';
export * from './lib.js';
export * from './providers/types.js';
export { getImplementer, getVerifier } from './providers/registry.js';
export { dispatchSpec } from './orchestrator/dispatch.js';
export { tickRepo, tickAll, type TickOptions } from './orchestrator/tick.js';
export { applyVerdict } from './orchestrator/act.js';
export {
  loadState,
  saveState,
  knownBranches,
  refForBranch,
  loadReviewed,
  markReviewed,
  type RunRecord,
  type StateFile,
} from './orchestrator/state.js';
export { postSlack } from './slack.js';
