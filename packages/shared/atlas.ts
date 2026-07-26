import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AtlasNodeKind = "root" | "directory" | "file";

export type AtlasSymbolKind =
	| "class"
	| "interface"
	| "type"
	| "enum"
	| "struct"
	| "trait"
	| "function"
	| "method"
	| "module"
	| "variable"
	| "other";

export interface AtlasSymbol {
	id: string;
	fileId: string;
	name: string;
	kind: AtlasSymbolKind;
	line: number;
	endLine: number;
	exported: boolean;
	complexity: number;
}

export interface AtlasNode {
	id: string;
	path: string;
	name: string;
	parentId: string | null;
	childIds: string[];
	kind: AtlasNodeKind;
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
	kind: "import";
	count: number;
}

export interface AtlasSummary {
	files: number;
	directories: number;
	bytes: number;
	lines: number;
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

export interface BuildAtlasOptions {
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

type LanguageDefinition = {
	language: string;
	extensions: string[];
};

type ParsedImport = {
	specifier: string;
	count: number;
};

type FileAnalysis = {
	language: string;
	extension: string;
	lines: number;
	complexity: number;
	symbols: Omit<AtlasSymbol, "id" | "fileId">[];
	imports: ParsedImport[];
};

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
	{ language: "typescript", extensions: [".ts", ".tsx", ".mts", ".cts"] },
	{ language: "javascript", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
	{ language: "python", extensions: [".py", ".pyi"] },
	{ language: "go", extensions: [".go"] },
	{ language: "rust", extensions: [".rs"] },
	{ language: "java", extensions: [".java"] },
	{ language: "cpp", extensions: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"] },
	{ language: "c", extensions: [".c", ".h"] },
	{ language: "ruby", extensions: [".rb", ".rake"] },
];

const EXTENSION_TO_LANGUAGE = new Map(
	LANGUAGE_DEFINITIONS.flatMap(({ language, extensions }) =>
		extensions.map((extension) => [extension, language] as const),
	),
);

const RESOLVABLE_EXTENSIONS = [
	...new Set(LANGUAGE_DEFINITIONS.flatMap(({ extensions }) => extensions)),
	".json",
];

const EXCLUDED_DIRECTORY_NAMES = new Set([
	".git",
	".hg",
	".svn",
	".cache",
	".next",
	".nuxt",
	".parcel-cache",
	".pytest_cache",
	".turbo",
	".venv",
	"__pycache__",
	"bower_components",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
	"vendor",
	"vendors",
]);

const EXCLUDED_FILE_PATTERNS = [
	/(?:^|\/)(?:package-lock|npm-shrinkwrap|yarn|pnpm-lock|bun)\.lock$/i,
	/(?:^|\/)(?:composer\.lock|cargo\.lock|go\.sum)$/i,
	/\.min\.(?:js|css)$/i,
	/\.map$/i,
	/\.generated\.[^/]+$/i,
	/(?:^|\/)generated(?:\/|$)/i,
	/(?:^|\/)__generated__(?:\/|$)/i,
];

const GENERATED_MARKERS = [
	"@generated",
	"code generated",
	"automatically generated",
	"auto-generated",
	"do not edit",
];

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function normalizeRepositoryPath(filePath: string): string {
	return filePath.split(sep).join("/").replace(/^\.\/+/, "");
}

function nodeId(kind: AtlasNodeKind, path: string): string {
	if (kind === "root") return "root";
	return `${kind === "file" ? "file" : "dir"}:${path}`;
}

function symbolId(fileId: string, kind: AtlasSymbolKind, name: string, line: number): string {
	return `${fileId}#${kind}:${encodeURIComponent(name)}:${line}`;
}

function dependencyId(sourceId: string, specifier: string, targetId: string | null): string {
	return `${sourceId}->${targetId ?? "external"}:${encodeURIComponent(specifier)}`;
}

function isExcludedPath(filePath: string): boolean {
	const normalized = normalizeRepositoryPath(filePath);
	const segments = normalized.split("/");
	return (
		segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment)) ||
		EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
	);
}

function languageForPath(filePath: string): { language: string; extension: string } | null {
	const extension = extname(filePath).toLowerCase();
	const language = EXTENSION_TO_LANGUAGE.get(extension);
	return language ? { language, extension } : null;
}

async function listGitFiles(rootPath: string, maxFiles: number): Promise<string[] | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			[
				"-C",
				rootPath,
				"ls-files",
				"--cached",
				"--others",
				"--exclude-standard",
				"-z",
			],
			{
				encoding: "buffer",
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				timeout: 15_000,
			},
		);
		return stdout
			.toString("utf8")
			.split("\0")
			.filter(Boolean)
			.map(normalizeRepositoryPath)
			.filter((filePath) => !isExcludedPath(filePath) && languageForPath(filePath) !== null)
			.slice(0, maxFiles);
	} catch {
		return null;
	}
}

async function listFilesystemFiles(rootPath: string, maxFiles: number): Promise<string[]> {
	const results: string[] = [];
	const pending = [rootPath];

	while (pending.length > 0 && results.length < maxFiles) {
		const directory = pending.pop()!;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}

		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index]!;
			const absolutePath = join(directory, entry.name);
			const repositoryPath = normalizeRepositoryPath(relative(rootPath, absolutePath));
			if (isExcludedPath(repositoryPath) || entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				pending.push(absolutePath);
			} else if (entry.isFile() && languageForPath(repositoryPath) !== null) {
				results.push(repositoryPath);
				if (results.length >= maxFiles) break;
			}
		}
	}

	return results.sort();
}

function isProbablyBinary(bytes: Buffer): boolean {
	const sampleLength = Math.min(bytes.length, 8_192);
	if (bytes.subarray(0, sampleLength).includes(0)) return true;

	let suspicious = 0;
	for (let index = 0; index < sampleLength; index += 1) {
		const byte = bytes[index]!;
		if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
	}
	return sampleLength > 0 && suspicious / sampleLength > 0.1;
}

function looksGenerated(content: string): boolean {
	const header = content.slice(0, 2_048).toLowerCase();
	return GENERATED_MARKERS.some((marker) => header.includes(marker));
}

function countLines(content: string): number {
	if (content.length === 0) return 0;
	const newlines = content.match(/\r\n|\r|\n/g)?.length ?? 0;
	return newlines + (/(?:\r\n|\r|\n)$/.test(content) ? 0 : 1);
}

function stripComments(content: string, language: string): string {
	let result = content;
	const preserveLines = (match: string): string => match.replace(/[^\r\n]/g, " ");
	if (language === "python" || language === "ruby") {
		result = result.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, preserveLines);
		result = result.replace(/#.*$/gm, " ");
	} else {
		result = result.replace(/\/\*[\s\S]*?\*\//g, preserveLines);
		result = result.replace(/\/\/.*$/gm, " ");
	}
	return result;
}

function stripCommentsAndStrings(content: string, language: string): string {
	return stripComments(content, language)
		.replace(/`(?:\\.|[^`\\])*`/g, '""')
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function approximateComplexity(content: string, language: string): number {
	const source = stripCommentsAndStrings(content, language);
	const keywords =
		language === "python"
			? /\b(?:if|elif|for|while|except|case)\b|\band\b|\bor\b/g
			: language === "ruby"
				? /\b(?:if|unless|elsif|for|while|until|when|rescue)\b|&&|\|\|/g
				: /\b(?:if|else\s+if|for|while|case|catch|match)\b|&&|\|\||\?\?/g;
	return 1 + (source.match(keywords)?.length ?? 0);
}

function lineAt(content: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index += 1) {
		if (content.charCodeAt(index) === 10) line += 1;
	}
	return line;
}

type SymbolPattern = {
	regex: RegExp;
	kind: AtlasSymbolKind | ((match: RegExpExecArray) => AtlasSymbolKind);
	nameGroup: number;
	exported?: (match: RegExpExecArray) => boolean;
};

function symbolPatterns(language: string): SymbolPattern[] {
	switch (language) {
		case "typescript":
		case "javascript":
			return [
				{
					regex: /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
					kind: "class",
					nameGroup: 2,
					exported: (match) => Boolean(match[1]),
				},
				{
					regex: /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm,
					kind: "interface",
					nameGroup: 2,
					exported: (match) => Boolean(match[1]),
				},
				{
					regex: /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)(?:\s*<[^>\n]+>)?\s*=/gm,
					kind: "type",
					nameGroup: 2,
					exported: (match) => Boolean(match[1]),
				},
				{
					regex: /^\s*(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\s*\{/gm,
					kind: "enum",
					nameGroup: 2,
					exported: (match) => Boolean(match[1]),
				},
				{
					regex: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
					kind: "function",
					nameGroup: 2,
					exported: (match) => Boolean(match[1]),
				},
				{
					regex: /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm,
					kind: "function",
					nameGroup: 2,
					exported: (match) => Boolean(match[1]),
				},
				{
					regex: /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>{}]+>)?\s*\([^;{}]*\)\s*(?::[^={]+)?\{/gm,
					kind: "method",
					nameGroup: 1,
				},
				{
					regex: /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?(?:=|;)/gm,
					kind: "variable",
					nameGroup: 2,
					exported: (match) => Boolean(match[1]),
				},
			];
		case "python":
			return [
				{ regex: /^\s*class\s+([A-Za-z_]\w*)/gm, kind: "class", nameGroup: 1 },
				{ regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, kind: "function", nameGroup: 1 },
				{ regex: /^([A-Za-z_]\w*)\s*(?::[^=]+)?=/gm, kind: "variable", nameGroup: 1 },
			];
		case "go":
			return [
				{ regex: /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/gm, kind: (match) => match[2] as "struct" | "interface", nameGroup: 1 },
				{ regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, kind: "function", nameGroup: 1 },
				{ regex: /^\s*(?:var|const)\s+([A-Za-z_]\w*)\b/gm, kind: "variable", nameGroup: 1 },
			];
		case "rust":
			return [
				{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, kind: "function", nameGroup: 1, exported: (match) => /\bpub\b/.test(match[0]) },
				{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/gm, kind: (match) => match[1] === "mod" ? "module" : match[1] as AtlasSymbolKind, nameGroup: 2, exported: (match) => /\bpub\b/.test(match[0]) },
				{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)\b/gm, kind: "variable", nameGroup: 1, exported: (match) => /\bpub\b/.test(match[0]) },
			];
		case "java":
			return [
				{ regex: /^\s*(?:public\s+)?(?:abstract\s+)?(class|interface|enum)\s+([A-Za-z_$][\w$]*)/gm, kind: (match) => match[1] as AtlasSymbolKind, nameGroup: 2, exported: (match) => /\bpublic\b/.test(match[0]) },
				{ regex: /^\s*(?:public|protected|private|static|final|synchronized|abstract|native|\s)+[\w<>\[\],.?]+\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws[^{]+)?\{/gm, kind: "method", nameGroup: 1, exported: (match) => /\bpublic\b/.test(match[0]) },
			];
		case "c":
		case "cpp":
			return [
				{ regex: /^\s*(class|struct|enum)\s+([A-Za-z_]\w*)/gm, kind: (match) => match[1] as "class" | "struct" | "enum", nameGroup: 2 },
				{ regex: /^\s*(?:[\w:*&<>,[\]\s]+)\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/gm, kind: "function", nameGroup: 1 },
			];
		case "ruby":
			return [
				{ regex: /^\s*class\s+([A-Z]\w*(?:::[A-Z]\w*)*)/gm, kind: "class", nameGroup: 1 },
				{ regex: /^\s*module\s+([A-Z]\w*(?:::[A-Z]\w*)*)/gm, kind: "module", nameGroup: 1 },
				{ regex: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/gm, kind: "function", nameGroup: 1 },
				{ regex: /^([A-Z]\w*)\s*=/gm, kind: "variable", nameGroup: 1 },
			];
		default:
			return [];
	}
}

function extractSymbols(content: string, language: string): FileAnalysis["symbols"] {
	const symbols: FileAnalysis["symbols"] = [];
	const seen = new Set<string>();
	const reservedNames = new Set(["if", "for", "while", "switch", "catch", "match"]);
	const source = stripComments(content, language);
	for (const pattern of symbolPatterns(language)) {
		pattern.regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.regex.exec(source)) !== null) {
			const name = match[pattern.nameGroup];
			if (!name || reservedNames.has(name)) continue;
			const line = lineAt(content, match.index);
			const kind = typeof pattern.kind === "function" ? pattern.kind(match) : pattern.kind;
			const key = `${name}:${line}`;
			if (seen.has(key)) continue;
			seen.add(key);
			symbols.push({
				name,
				kind,
				line,
				endLine: line,
				exported: pattern.exported?.(match) ?? false,
				complexity: 1,
			});
		}
	}
	const sorted = symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
	const lines = content.split(/\r\n|\r|\n/);
	return sorted.map((symbol, index) => {
		const nextLine = sorted[index + 1]?.line;
		const endLine = Math.max(symbol.line, nextLine ? nextLine - 1 : lines.length);
		return {
			...symbol,
			endLine,
			complexity: approximateComplexity(
				lines.slice(symbol.line - 1, endLine).join("\n"),
				language,
			),
		};
	});
}

function collectImports(content: string, language: string): ParsedImport[] {
	const specifiers: string[] = [];
	const source = stripComments(content, language);
	const addMatches = (regex: RegExp, group = 1): void => {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(source)) !== null) {
			const specifier = match[group]?.trim();
			if (specifier) specifiers.push(specifier);
		}
	};

	switch (language) {
		case "typescript":
		case "javascript":
			addMatches(/\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g);
			addMatches(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g);
			break;
		case "python":
			addMatches(/^\s*from\s+([.\w]+)\s+import\b/gm);
			addMatches(/^\s*import\s+([.\w]+)/gm);
			break;
		case "go":
			addMatches(/^\s*import\s+(?:[._\w]+\s+)?["`]([^"`]+)["`]/gm);
			for (const block of source.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) {
				for (const entry of block[1]?.matchAll(/(?:^|\n)\s*(?:[._\w]+\s+)?["`]([^"`]+)["`]/gm) ?? []) {
					if (entry[1]) specifiers.push(entry[1]);
				}
			}
			break;
		case "rust":
			addMatches(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm);
			addMatches(/^\s*use\s+((?:crate|self|super)::[\w:]+)/gm);
			break;
		case "java":
			addMatches(/^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/gm);
			break;
		case "c":
		case "cpp":
			addMatches(/^\s*#\s*include\s*"([^"]+)"/gm);
			break;
		case "ruby":
			addMatches(/^\s*require_relative\s+["']([^"']+)["']/gm);
			addMatches(/^\s*require\s+["']([^"']+)["']/gm);
			break;
	}

	const counts = new Map<string, number>();
	for (const specifier of specifiers) {
		counts.set(specifier, (counts.get(specifier) ?? 0) + 1);
	}
	return [...counts].map(([specifier, count]) => ({ specifier, count }));
}

function analyzeFile(filePath: string, content: string): FileAnalysis | null {
	const identified = languageForPath(filePath);
	if (!identified) return null;
	return {
		...identified,
		lines: countLines(content),
		complexity: approximateComplexity(content, identified.language),
		symbols: extractSymbols(content, identified.language),
		imports: collectImports(content, identified.language),
	};
}

function buildResolutionCandidates(sourcePath: string, specifier: string, language: string): string[] {
	const sourceDirectory = posix.dirname(sourcePath);
	const candidates: string[] = [];
	const addFileCandidates = (base: string): void => {
		const normalized = posix.normalize(base);
		candidates.push(normalized);
		if (!posix.extname(normalized)) {
			for (const extension of RESOLVABLE_EXTENSIONS) {
				candidates.push(`${normalized}${extension}`);
				candidates.push(posix.join(normalized, `index${extension}`));
			}
		}
	};

	if (specifier.startsWith(".")) {
		if (language === "python") {
			const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
			let directory = sourceDirectory;
			for (let index = 1; index < leadingDots; index += 1) directory = posix.dirname(directory);
			addFileCandidates(posix.join(directory, specifier.slice(leadingDots).replaceAll(".", "/")));
		} else {
			addFileCandidates(posix.join(sourceDirectory, specifier));
		}
	} else if (language === "python") {
		addFileCandidates(specifier.replaceAll(".", "/"));
		addFileCandidates(posix.join(specifier.replaceAll(".", "/"), "__init__.py"));
	} else if (language === "java") {
		addFileCandidates(`${specifier.replaceAll(".", "/")}.java`);
	} else if (language === "rust" && /^(?:crate|self|super)::/.test(specifier)) {
		const parts = specifier.split("::");
		let directory = parts.shift() === "crate" ? "" : sourceDirectory;
		while (parts[0] === "super") {
			directory = posix.dirname(directory);
			parts.shift();
		}
		if (parts[0] === "self") parts.shift();
		addFileCandidates(posix.join(directory, parts.join("/")));
	} else if (language === "rust" && /^\w+$/.test(specifier)) {
		addFileCandidates(posix.join(sourceDirectory, specifier));
	} else if ((language === "c" || language === "cpp") && !specifier.startsWith("/")) {
		addFileCandidates(posix.join(sourceDirectory, specifier));
	} else if (language === "ruby") {
		addFileCandidates(posix.join(sourceDirectory, specifier));
		addFileCandidates(specifier);
	}

	return [...new Set(candidates.filter((candidate) => candidate !== ".." && !candidate.startsWith("../")))];
}

function resolveDependencyTarget(
	sourcePath: string,
	specifier: string,
	language: string,
	fileIdsByPath: Map<string, string>,
): { targetId: string; targetPath: string } | null {
	for (const candidate of buildResolutionCandidates(sourcePath, specifier, language)) {
		const targetId = fileIdsByPath.get(candidate);
		if (targetId) return { targetId, targetPath: candidate };
	}
	return null;
}

function createRootNode(rootPath: string): AtlasNode {
	return {
		id: "root",
		path: ".",
		name: basename(rootPath),
		parentId: null,
		childIds: [],
		kind: "root",
		depth: 0,
		language: null,
		extension: null,
		bytes: 0,
		lines: 0,
		complexity: 0,
		symbols: [],
	};
}

function ensureDirectoryNodes(
	filePath: string,
	rootNode: AtlasNode,
	nodesById: Map<string, AtlasNode>,
): string {
	const directoryPath = posix.dirname(filePath);
	if (directoryPath === ".") return rootNode.id;

	let parentId = rootNode.id;
	let currentPath = "";
	for (const segment of directoryPath.split("/")) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		const id = nodeId("directory", currentPath);
		if (!nodesById.has(id)) {
			const directoryNode: AtlasNode = {
				id,
				path: currentPath,
				name: segment,
				parentId,
				childIds: [],
				kind: "directory",
				depth: currentPath.split("/").length,
				language: null,
				extension: null,
				bytes: 0,
				lines: 0,
				complexity: 0,
				symbols: [],
			};
			nodesById.set(id, directoryNode);
			nodesById.get(parentId)!.childIds.push(id);
		}
		parentId = id;
	}
	return parentId;
}

function aggregateDirectoryMetrics(nodesById: Map<string, AtlasNode>): void {
	const depth = (node: AtlasNode): number =>
		node.kind === "root" ? 0 : node.path.split("/").length;
	const nodes = [...nodesById.values()].sort(
		(a, b) => depth(b) - depth(a),
	);
	for (const node of nodes) {
		if (node.kind !== "file" && node.childIds.length > 0) {
			for (const childId of node.childIds) {
				const child = nodesById.get(childId)!;
				node.bytes += child.bytes;
				node.lines += child.lines;
				node.complexity += child.complexity;
			}
		}
		node.childIds.sort((a, b) => {
			const first = nodesById.get(a)!;
			const second = nodesById.get(b)!;
			if (first.kind !== second.kind) return first.kind === "directory" ? -1 : 1;
			return first.name.localeCompare(second.name);
		});
	}
}

/**
 * Build a bounded, serializable repository index for the Atlas UI.
 *
 * Git repositories use `git ls-files` so ignored content is never traversed.
 * Non-Git folders use a symlink-free fallback walk with the same work budget.
 */
export async function buildAtlasSnapshot(
	rootPath: string,
	options: BuildAtlasOptions = {},
): Promise<AtlasSnapshot> {
	const resolvedRoot = await realpath(resolve(rootPath));
	const rootStats = await stat(resolvedRoot);
	if (!rootStats.isDirectory()) throw new Error("Atlas root must be a directory");

	const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
	const maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
	const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
	const gitFiles = await listGitFiles(resolvedRoot, maxFiles + 1);
	const discoveredFiles = gitFiles ?? await listFilesystemFiles(resolvedRoot, maxFiles + 1);
	const truncatedByFileCount = discoveredFiles.length > maxFiles;
	const candidatePaths = discoveredFiles.slice(0, maxFiles).sort();

	const rootNode = createRootNode(resolvedRoot);
	const nodesById = new Map<string, AtlasNode>([[rootNode.id, rootNode]]);
	const importsByFile = new Map<string, ParsedImport[]>();
	const languageByFile = new Map<string, string>();
	let skippedFiles = 0;
	let totalReadBytes = 0;
	let truncated = truncatedByFileCount;

	for (const repositoryPath of candidatePaths) {
		const normalizedPath = normalizeRepositoryPath(repositoryPath);
		if (
			!normalizedPath ||
			normalizedPath.startsWith("../") ||
			isExcludedPath(normalizedPath) ||
			!languageForPath(normalizedPath)
		) {
			skippedFiles += 1;
			continue;
		}

		const absolutePath = join(resolvedRoot, ...normalizedPath.split("/"));
		let fileStats;
		try {
			fileStats = await lstat(absolutePath);
		} catch {
			skippedFiles += 1;
			continue;
		}
		if (fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.size > maxFileBytes) {
			skippedFiles += 1;
			continue;
		}
		if (totalReadBytes + fileStats.size > maxTotalBytes) {
			truncated = true;
			break;
		}

		let bytes: Buffer;
		try {
			bytes = await readFile(absolutePath);
		} catch {
			skippedFiles += 1;
			continue;
		}
		totalReadBytes += bytes.length;
		if (isProbablyBinary(bytes)) {
			skippedFiles += 1;
			continue;
		}

		const content = bytes.toString("utf8");
		if (looksGenerated(content)) {
			skippedFiles += 1;
			continue;
		}
		const analysis = analyzeFile(normalizedPath, content);
		if (!analysis) {
			skippedFiles += 1;
			continue;
		}

		const id = nodeId("file", normalizedPath);
		const parentId = ensureDirectoryNodes(normalizedPath, rootNode, nodesById);
		const symbols: AtlasSymbol[] = analysis.symbols.map((symbol) => ({
			...symbol,
			id: symbolId(id, symbol.kind, symbol.name, symbol.line),
			fileId: id,
		}));
		const fileNode: AtlasNode = {
			id,
			path: normalizedPath,
			name: posix.basename(normalizedPath),
			parentId,
			childIds: [],
			kind: "file",
			depth: normalizedPath.split("/").length,
			language: analysis.language,
			extension: analysis.extension,
			bytes: bytes.length,
			lines: analysis.lines,
			complexity: analysis.complexity,
			symbols,
		};
		nodesById.set(id, fileNode);
		nodesById.get(parentId)!.childIds.push(id);
		importsByFile.set(normalizedPath, analysis.imports);
		languageByFile.set(normalizedPath, analysis.language);
	}

	aggregateDirectoryMetrics(nodesById);
	const fileIdsByPath = new Map(
		[...nodesById.values()]
			.filter((node) => node.kind === "file")
			.map((node) => [node.path, node.id]),
	);
	const dependencies: AtlasDependency[] = [];
	for (const [sourcePath, imports] of importsByFile) {
		const sourceId = fileIdsByPath.get(sourcePath)!;
		const language = languageByFile.get(sourcePath)!;
		for (const imported of imports) {
			const target = resolveDependencyTarget(
				sourcePath,
				imported.specifier,
				language,
				fileIdsByPath,
			);
			dependencies.push({
				id: dependencyId(sourceId, imported.specifier, target?.targetId ?? null),
				sourceId,
				sourcePath,
				targetId: target?.targetId ?? null,
				targetPath: target?.targetPath ?? null,
				specifier: imported.specifier,
				kind: "import",
				count: imported.count,
			});
		}
	}
	dependencies.sort(
		(a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.specifier.localeCompare(b.specifier),
	);

	const nodes = [...nodesById.values()];
	nodes.sort((a, b) => {
		if (a.kind === "root") return -1;
		if (b.kind === "root") return 1;
		return a.path.localeCompare(b.path);
	});
	const files = nodes.filter((node) => node.kind === "file");
	const languages: Record<string, { files: number; lines: number; bytes: number }> = {};
	for (const file of files) {
		const language = file.language!;
		const current = languages[language] ?? { files: 0, lines: 0, bytes: 0 };
		current.files += 1;
		current.lines += file.lines;
		current.bytes += file.bytes;
		languages[language] = current;
	}

	return {
		version: 1,
		rootPath: resolvedRoot,
		rootName: rootNode.name,
		rootId: rootNode.id,
		generatedAt: new Date().toISOString(),
		nodes,
		dependencies,
		summary: {
			files: files.length,
			directories: nodes.filter((node) => node.kind === "directory").length,
			bytes: rootNode.bytes,
			lines: rootNode.lines,
			complexity: rootNode.complexity,
			symbols: files.reduce((sum, file) => sum + file.symbols.length, 0),
			dependencies: dependencies.length,
			internalDependencies: dependencies.filter((dependency) => dependency.targetId !== null).length,
			languages,
			skippedFiles,
			truncated,
		},
	};
}

export {
	findAtlasReferences,
	readAtlasSource,
	resolveAtlasSourcePath,
	validateAtlasRelativePath,
} from "./atlas-source";
export type {
	AtlasReference,
	AtlasSourceFile,
	SearchAtlasReferencesOptions,
} from "./atlas-source";
