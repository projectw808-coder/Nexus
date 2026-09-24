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

// ── Phase 2: the object graph ────────────────────────────────────────────────
export {
  ATTRIBUTE_TYPES,
  COMPUTED_TYPES,
  INDEXABLE_TYPES,
  CONFIG_SCHEMAS,
  FILTER_OPS,
  indexColumnKind,
  optionSchema,
  locationSchema,
  aiResearchValueSchema,
  parseAttributeConfig,
  valueSchema,
  validateRecordValues,
  coerceCell,
  filterOpsFor,
  filterSchema,
  sortSchema,
  recordQuerySchema,
} from './attributes.ts';
export type {
  AttributeType,
  AttributeDef,
  Option,
  FieldError,
  ValidatedValues,
  FilterOp,
  Filter,
  Sort,
  RecordQuery,
} from './attributes.ts';
export {
  positionBetween,
  needsRebalance,
  rebalancedPositions,
  POSITION_STEP,
  MIN_GAP,
} from './fractional-index.ts';
export { parseCsv, detectDelimiter, toCsv } from './csv.ts';
export type { CsvTable } from './csv.ts';
