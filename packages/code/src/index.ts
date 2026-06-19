// packages/code/src/index.ts

// Types
export type {
  SupportedLanguage,
  SymbolKind,
  SymbolNode,
  SymbolRelationType,
  SymbolRelation,
  ParsedFile,
  ImportInfo,
  IndexResult,
  CodeSearchResult,
  CodeContext,
  SparseVector,
} from './types.js';
export { LANGUAGE_EXTENSIONS } from './types.js';

// Parser
export { parseFile } from './parser.js';

// Vectors
export {
  splitIdentifier,
  tokenizeForVectors,
  generateLexicalVector,
  generateMiniVector,
  generateSparseVector,
} from './vectors.js';

// Stores
export { SymbolStore } from './symbol-store.js';

// Services
export { CodeIndexer, computeComponentModuleLinks } from './indexer.js';
export type { ComponentModuleLink, KnownModule } from './indexer.js';
export { ImportResolver } from './resolver.js';
export { CodeSearch } from './search.js';
export { structuralSearch } from './structural-search.js';
export type {
  StructuralSearchCapture,
  StructuralSearchLanguage,
  StructuralSearchMatch,
  StructuralSearchOptions,
  StructuralSearchResult,
} from './structural-search.js';

// Schema
export { initCodeSchema } from './schema.js';

// Project-tag normalization (canonical project:<slug> scoping for symbols)
export { canonicalProjectTag, resolveProjectTag } from './project-tag.js';

// Watcher
export { CodeWatcher, extractFilePaths, confineReindexPath, getReindexBaseDir } from './watcher.js';
export type { CodeWatcherOptions, IFileIndexer, ISymbolDeleter } from './watcher.js';

// MCP tools
export { registerCodeTools, setCodeServiceInstances, createCodeContainer, CODE_TOOL_NAMES } from './tools.js';
export type { ICodeIndexer, ICodeSearch, ISymbolStore, CodeServiceContainer } from './tools.js';
