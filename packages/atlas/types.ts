export type AtlasView = 'overview' | 'symbols' | 'source';
export type SizeMetric = 'lines' | 'bytes' | 'complexity';
export type ColorMetric = 'language' | 'complexity' | 'size';

export interface AtlasSymbol {
  id: string;
  fileId: string;
  name: string;
  kind: 'class' | 'interface' | 'type' | 'enum' | 'struct' | 'trait' | 'function' | 'method' | 'variable' | 'module' | 'other';
  line: number;
  endLine: number;
  complexity: number;
  exported: boolean;
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
  version: 1;
  rootPath: string;
  rootName: string;
  rootId: string;
  generatedAt: string;
  nodes: AtlasNode[];
  dependencies: AtlasDependency[];
  summary: AtlasSummary;
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
}
