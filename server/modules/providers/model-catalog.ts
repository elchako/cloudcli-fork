// GOLDJAXE fork (реестр §13.3, §4.16-тер): лёгкая публичная граница каталога.
// Не импортировать общий index.ts из фоновой политики/инструментов: тот создаёт
// registry/runtime, который сам зависит от этих инструментов (ESM-цикл).
export { claudeApiModelCatalog, decodeCliProxyModelId } from './list/claude/claude-api-models.js';
export { findClaudeModelOption, withGatewayEffortSuffix } from './list/claude/claude-models.provider.js';
export { knownGatewayModelReasoning } from './list/claude/claude-model-reasoning.js';
