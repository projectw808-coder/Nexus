export type { Result, Ok, Err } from './result.ts';
export { ok, err, isOk, isErr, unwrap, map, mapErr, attempt } from './result.ts';
export type { FailureClass, FailureBehaviour, FailureContext, FailureSpec } from './errors.ts';
export {
  FAILURE_CLASSES,
  FAILURE_TAXONOMY,
  NexusError,
  isRetryableHttpStatus,
  classifyHttpStatus,
} from './errors.ts';
