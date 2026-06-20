export { CANARY_DEFECTS, generateCanaries } from "./canary.js";
export type {
  CanaryDefect,
  CanaryGroundTruth,
  CanarySpec,
  CanaryBaseline,
  GenerateCanariesOptions,
} from "./canary.js";
export {
  INJECTION_VECTORS,
  INJECTION_PAYLOADS,
  generateInjectionCanaries,
  injectionResisted,
} from "./injection-canary.js";
export type {
  InjectionVector,
  InjectionCanarySpec,
  GenerateInjectionCanariesOptions,
  CleanReview,
  ObservedReview,
} from "./injection-canary.js";
export {
  findingKey,
  isUsableForKappa,
  consensusFindings,
  raterGrades,
  parseGoldenSet,
} from "./golden-set.js";
export type { LabeledFinding, RaterLabel, GoldenCase, GoldenSet } from "./golden-set.js";
export {
  precisionRecall,
  perDimensionPR,
  blockerRecall,
  nitPrecision,
  GRADE_SCALE,
  quadraticWeightedKappa,
  bootstrapKappaCI,
} from "./metrics.js";
export type { PrecisionRecall, KappaCI, BootstrapOptions } from "./metrics.js";
export { canaryRecall, humanRegressionBeyondCI, regressionGate } from "./regression-gate.js";
export type {
  CanaryEvalInput,
  HumanMonitorInput,
  RegressionGateInput,
  RegressionGateResult,
} from "./regression-gate.js";
export { DEFAULT_QUALITY_BARS, qualityGate } from "./quality-gate.js";
export type { QualityBars, QualityGateInput, QualityGateResult } from "./quality-gate.js";
export { DEFAULT_SLO_TARGETS, evaluateSlos } from "./slo.js";
export type { SloTargets, SloCounts, SloResult } from "./slo.js";
export { ModelPromptRegistry } from "./registry.js";
export type { RegistryStatus, RegistryStamp, RegistryEntry } from "./registry.js";
