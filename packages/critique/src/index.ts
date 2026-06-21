export type {
  ModelBackend,
  ModelImage,
  ModelMessage,
  ModelRequest,
  ModelUsage,
  ModelResponse,
  ModelClient,
  ModelCallOptions,
} from "./model.js";
export { DashScopeModelClient, createOpenAICompatibleCreate } from "./dashscope.js";
export type {
  ChatChunk,
  ChatCreateParams,
  ChatCompletionsCreate,
  ImageUrlResolver,
  DashScopeOptions,
  OpenAILikeClient,
} from "./dashscope.js";
export {
  DEFAULT_PASS_MODELS,
  resolvePassModel,
} from "./registry.js";
export type { PassModelConfig, PassModelOverrides, ModelClientFactory } from "./registry.js";
export { MockModelClient, defaultModelFactory } from "./mock-model.js";
export { critique, ENGINE_VERSION, PROMPT_VERSION } from "./critique.js";
export type { CritiqueDeps } from "./critique.js";
export { buildResultMetadata, assertVersionStamped, versionSpanAttributes } from "./version-stamp.js";
export type { VersionStampInput } from "./version-stamp.js";
export {
  SYSTEM_PROMPT_VERSION,
  RUBRIC_ORDER,
  activeDimensions,
  buildSystemPrompt,
  UNTRUSTED_CONTENT_TAG,
  UNTRUSTED_CONTENT_RULE,
  wrapUntrustedPageContent,
} from "./prompt.js";
export type { SystemPromptOptions } from "./prompt.js";
export {
  FindingSchema,
  CritiqueOutputSchema,
  parseCritiqueOutput,
  schemaInstruction,
  critiqueJsonSchema,
} from "./schema.js";
export type { CritiqueOutput, ModelFinding, ParseResult } from "./schema.js";
export { hallucinationGate } from "./hallucination-gate.js";
export type { HallucinationGateInput, HallucinationGateResult } from "./hallucination-gate.js";
export { postFilter } from "./post-filter.js";
export type { PostFilterOptions } from "./post-filter.js";
export { applyConfidenceCeiling } from "./confidence-ceiling.js";
export {
  critiqueRouteTwoStep,
  critiqueRouteSingleCall,
  runDeepPass,
  mapWithConcurrency,
  renderBuildFacts,
  renderGenomeRules,
  MAX_BUILD_FACTS,
} from "./deep-pass.js";
export type { DeepPassRoute, DeepPassDeps, DeepPassRouteResult } from "./deep-pass.js";
export { assembleCritique } from "./assemble.js";
export type { AssembleCritiqueDeps } from "./assemble.js";
export { reconcileGrade, gradeFromFindings, worstGrade } from "./grade.js";
export { cachePrefix, cachedInputTokens, isCacheHit } from "./cache.js";
export { FREE_TIER_PASS_MODELS, passModelsForTier } from "./tier.js";
export type { BillingTier } from "./tier.js";
export {
  DEFAULT_MODEL_GENERATION,
  MODEL_GENERATIONS,
  passModelsForGeneration,
} from "./generations.js";
export type { ModelGeneration, GenerationConfig } from "./generations.js";
export { TriageOutputSchema, allUnchanged, runTriage } from "./triage.js";
export type { TriageOutput, TriageRoute, TriageDeps, TriageResult } from "./triage.js";
export { toEngineReviewResult, deriveTitle, wireFindingId } from "./wire-projection.js";
export type { WireProjectionOptions } from "./wire-projection.js";
