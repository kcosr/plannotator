export type AtlasView = 'overview' | 'symbols' | 'source';
export type SizeMetric = 'lines' | 'bytes' | 'complexity';
export type ColorMetric = 'language' | 'complexity' | 'size';
export type CodeFilter = 'all' | 'no-tests' | 'tests';

export interface AtlasTestRange {
  startLine: number;
  endLine: number;
  reason:
    | 'rust-test-attribute'
    | 'rust-cfg-test'
    | 'rust-integration-file'
    | 'python-test-file'
    | 'python-test-symbol'
    | 'go-test-file'
    | 'java-test-file'
    | 'java-test-annotation'
    | 'ruby-test-file'
    | 'ruby-test-symbol'
    | 'js-test-file'
    | 'js-test-call'
    | 'c-family-test-file'
    | 'c-family-test-macro'
    | 'c-family-test-function';
  confidence: 'semantic' | 'convention';
}

export interface AtlasSymbol {
  id: string;
  fileId: string;
  name: string;
  kind: 'class' | 'interface' | 'type' | 'enum' | 'struct' | 'trait' | 'function' | 'method' | 'variable' | 'module' | 'other';
  line: number;
  column: number;
  endLine: number;
  complexity: number;
  exported: boolean;
  isTest: boolean;
}

export interface AtlasNode {
  id: string;
  path: string;
  name: string;
  kind: 'root' | 'directory' | 'file';
  parentId: string | null;
  childIds: string[];
  depth: number;
  language: string | null;
  extension: string | null;
  bytes: number;
  lines: number;
  complexity: number;
  testBytes: number;
  testLines: number;
  testComplexity: number;
  testRanges: AtlasTestRange[];
  symbols: AtlasSymbol[];
}

export interface AtlasDependency {
  id: string;
  sourceId: string;
  sourcePath: string;
  targetId: string | null;
  targetPath: string | null;
  specifier: string;
  kind: 'import';
  count: number;
}

export interface AtlasSummary {
  files: number;
  directories: number;
  lines: number;
  bytes: number;
  complexity: number;
  symbols: number;
  dependencies: number;
  internalDependencies: number;
  languages: Record<string, { files: number; lines: number; bytes: number }>;
  skippedFiles: number;
  truncated: boolean;
}

export interface AtlasSnapshot {
  version: 3;
  rootPath: string;
  rootName: string;
  rootId: string;
  generatedAt: string;
  nodes: AtlasNode[];
  dependencies: AtlasDependency[];
  summary: AtlasSummary;
  analyzers: AtlasAnalyzers;
}

export interface AtlasAnalyzers {
  structural: {
    name: 'ast-grep';
    version: string;
    source: string;
    languages: string[];
  };
  semantic: {
    protocol: 'lsp';
    providers: SemanticProvider[];
  };
}

export interface SemanticProvider {
  language: string;
  name: string;
  available: boolean;
  source?: string;
  reason?: string;
}

export interface SourceFile {
  path: string;
  content: string;
  bytes: number;
  language: string;
}

export interface ReferenceLocation {
  kind: 'definition' | 'reference';
  fileId: string;
  filePath: string;
  line: number;
  column: number;
  snippet: string;
}

export interface ReferenceResponse {
  definitions: ReferenceLocation[];
  references: ReferenceLocation[];
  provider: {
    kind: 'lsp' | 'syntax';
    name: string;
    status: 'ready' | 'unavailable';
    message?: string;
  };
}

export interface CallHierarchyLocation {
  fileId: string;
  filePath: string;
  line: number;
  column: number;
  snippet: string;
}

export interface CallHierarchyTarget {
  name: string;
  kind: number;
  detail?: string;
  declaration: CallHierarchyLocation;
  callSites: CallHierarchyLocation[];
}

export interface CallHierarchyResponse {
  root: CallHierarchyTarget | null;
  callers: CallHierarchyTarget[];
  callees: CallHierarchyTarget[];
  truncated: boolean;
  provider: {
    kind: 'lsp';
    name: string;
    status: 'ready' | 'unsupported' | 'unavailable';
    message?: string;
  };
}
