import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	analyzeAtlasStructure,
	type AtlasStructuralAnalyzer,
	type StructuralFileOutline,
	type StructuralItem,
	type StructuralMember,
} from "./atlas-structure";
import {
	classifyRustRepositoryTestRanges,
	type AtlasTestRange,
} from "./atlas-test-classification";
import { classifyCFamilyTestRanges } from "./atlas-test-classification-c";
import { classifyConventionalTestRanges } from "./atlas-test-classification-conventions";
import { classifyJavaScriptTestRanges } from "./atlas-test-classification-js";

const execFileAsync = promisify(execFile);

export const ATLAS_SNAPSHOT_VERSION = 5;

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
	column: number;
	endLine: number;
	exported: boolean;
	complexity: number;
	isTest: boolean;
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
	version: typeof ATLAS_SNAPSHOT_VERSION;
	rootName: string;
	rootId: string;
	generatedAt: string;
	nodes: AtlasNode[];
	dependencies: AtlasDependency[];
	summary: AtlasSummary;
	analyzers: {
		structural: AtlasStructuralAnalyzer;
		semantic: {
			protocol: "lsp";
			providers: AtlasSemanticProviderCapability[];
		};
	};
}

export interface BuildAtlasOptions {
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
	semanticProviders?: AtlasSemanticProviderCapability[];
}

export interface AtlasSemanticProviderCapability {
	language: string;
	name: string;
	available: boolean;
	version?: string;
	source?: string;
	reason?: string;
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
	symbols: Omit<AtlasSymbol, "id" | "fileId" | "isTest">[];
	imports: ParsedImport[];
};

type AcceptedFile = {
	path: string;
	bytes: number;
	content: string | null;
	lines: number;
};

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_SCAN_BYTES = 64 * 1024 * 1024;

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
	{ language: "shell", extensions: [".sh"] },
];

const DISPLAY_LANGUAGE_BY_EXTENSION = new Map([
	[".css", "css"],
	[".htm", "html"],
	[".html", "html"],
	[".json", "json"],
	[".md", "markdown"],
	[".mdx", "markdown"],
	[".toml", "toml"],
	[".txt", "text"],
	[".xml", "xml"],
	[".yaml", "yaml"],
	[".yml", "yaml"],
]);

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
	".plannotator",
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

function displayLanguageForPath(filePath: string): { language: string; extension: string } {
	const analyzed = languageForPath(filePath);
	if (analyzed) return analyzed;
	const extension = extname(filePath).toLowerCase();
	return {
		language: DISPLAY_LANGUAGE_BY_EXTENSION.get(extension) ?? "text",
		extension,
	};
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
			.filter((filePath) => !isExcludedPath(filePath))
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
			} else if (entry.isFile()) {
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

async function inspectTextMetadata(
	absolutePath: string,
	fileBytes: number,
): Promise<{ binary: boolean; lines: number }> {
	const chunks: Buffer[] = [];
	let sampledBytes = 0;
	let lineBreaks = 0;
	let previousWasCarriageReturn = false;
	let endsWithLineBreak = false;
	let scannedBytes = 0;

	for await (const value of createReadStream(absolutePath)) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		scannedBytes += chunk.length;
		if (sampledBytes < 8_192) {
			const sample = chunk.subarray(0, Math.min(chunk.length, 8_192 - sampledBytes));
			chunks.push(sample);
			sampledBytes += sample.length;
			if (sampledBytes >= Math.min(fileBytes, 8_192) && isProbablyBinary(Buffer.concat(chunks))) {
				return { binary: true, lines: 0 };
			}
		}
		if (scannedBytes > MAX_METADATA_SCAN_BYTES) {
			return { binary: false, lines: 0 };
		}
		for (const byte of chunk) {
			if (byte === 13) {
				lineBreaks += 1;
				previousWasCarriageReturn = true;
				endsWithLineBreak = true;
			} else if (byte === 10) {
				if (!previousWasCarriageReturn) lineBreaks += 1;
				previousWasCarriageReturn = false;
				endsWithLineBreak = true;
			} else {
				previousWasCarriageReturn = false;
				endsWithLineBreak = false;
			}
		}
	}

	const sample = Buffer.concat(chunks);
	if (isProbablyBinary(sample)) return { binary: true, lines: 0 };
	return {
		binary: false,
		lines: fileBytes === 0 ? 0 : lineBreaks + (endsWithLineBreak ? 0 : 1),
	};
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

function contentLinesWithEndings(content: string): string[] {
	return content.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function testMetrics(
	content: string,
	language: string,
	complexity: number,
	ranges: AtlasTestRange[],
): { bytes: number; lines: number; complexity: number } {
	if (ranges.length === 0) return { bytes: 0, lines: 0, complexity: 0 };
	const sourceLines = contentLinesWithEndings(content);
	const testSource: string[] = [];
	let bytes = 0;
	let lines = 0;
	for (const range of ranges) {
		const selected = sourceLines.slice(range.startLine - 1, range.endLine);
		bytes += Buffer.byteLength(selected.join(""));
		lines += selected.length;
		testSource.push(selected.join(""));
	}
	return {
		bytes,
		lines,
		complexity: Math.min(complexity, approximateComplexity(testSource.join("\n"), language)),
	};
}

function lineIsInRanges(line: number, ranges: AtlasTestRange[]): boolean {
	return ranges.some((range) => line >= range.startLine && line <= range.endLine);
}

function symbolKind(
	symbolType: string,
	astKind: string,
	language: string,
	member: boolean,
): AtlasSymbolKind {
	if (member && (symbolType === "method" || symbolType === "constructor")) return "method";
	if (astKind.includes("type_alias")) return "type";
	if (language === "rust" && astKind === "trait_item") return "trait";
	if (language === "typescript" && symbolType === "struct") return "type";
	switch (symbolType) {
		case "class":
		case "interface":
		case "enum":
		case "struct":
		case "trait":
		case "function":
		case "method":
		case "module":
			return symbolType;
		case "type":
			return "type";
		case "constant":
		case "field":
		case "variable":
			return "variable";
		default:
			return "other";
	}
}

function normalizeImportName(name: string): string {
	const trimmed = name.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith("`") && trimmed.endsWith("`"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function analyzeOutline(
	filePath: string,
	content: string,
	outline: StructuralFileOutline | undefined,
): FileAnalysis | null {
	const identified = languageForPath(filePath);
	if (!identified) {
		const display = displayLanguageForPath(filePath);
		return {
			...display,
			lines: countLines(content),
			complexity: 0,
			symbols: [],
			imports: [],
		};
	}
	const lines = content.split(/\r\n|\r|\n/);
	const symbols: FileAnalysis["symbols"] = [];
	const imports = new Map<string, number>();

	const symbolPosition = (
		entry: StructuralItem | StructuralMember,
		name: string,
	): { line: number; column: number } => {
		const startLine = entry.range.start.line;
		const endLine = Math.min(entry.range.end.line, startLine + 20);
		for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
			const sourceLine = lines[lineIndex] ?? "";
			let offset = sourceLine.indexOf(name);
			while (offset >= 0) {
				const before = sourceLine[offset - 1] ?? "";
				const after = sourceLine[offset + name.length] ?? "";
				if (!/[\p{L}\p{N}_$]/u.test(before) && !/[\p{L}\p{N}_$]/u.test(after)) {
					return { line: lineIndex + 1, column: offset + 1 };
				}
				offset = sourceLine.indexOf(name, offset + 1);
			}
		}
		return {
			line: entry.range.start.line + 1,
			column: entry.range.start.column + 1,
		};
	};

	const addSymbol = (
		entry: StructuralItem | StructuralMember,
		exported: boolean,
		member: boolean,
	): void => {
		const name = entry.name.trim();
		if (!name) return;
		const position = symbolPosition(entry, name);
		const line = position.line;
		const endLine = Math.max(line, entry.range.end.line + 1);
		symbols.push({
			name,
			kind: symbolKind(entry.symbolType, entry.astKind, identified.language, member),
			line,
			column: position.column,
			endLine,
			exported,
			complexity: approximateComplexity(
				lines.slice(line - 1, endLine).join("\n"),
				identified.language,
			),
		});
	};

	for (const item of outline?.items ?? []) {
		if (item.isImport) {
			const specifier = normalizeImportName(item.name);
			if (specifier) imports.set(specifier, (imports.get(specifier) ?? 0) + 1);
			continue;
		}
		if (identified.language === "rust" && item.astKind === "mod_item") {
			const specifier = normalizeImportName(item.name);
			if (specifier) imports.set(specifier, (imports.get(specifier) ?? 0) + 1);
		}
		addSymbol(item, item.isExported, false);
		for (const member of item.members ?? []) {
			addSymbol(member, item.isExported && member.isPublic !== false, true);
		}
	}

	symbols.sort((a, b) => a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
	return {
		...identified,
		lines: countLines(content),
		complexity: approximateComplexity(content, identified.language),
		symbols,
		imports: [...imports].map(([specifier, count]) => ({ specifier, count })),
	};
}

function rustCrateRoot(sourcePath: string): string {
	const segments = sourcePath.split("/");
	const sourceIndex = segments.lastIndexOf("src");
	return sourceIndex >= 0 ? segments.slice(0, sourceIndex + 1).join("/") : posix.dirname(sourcePath);
}

function rustCrateEntry(root: string, fileIdsByPath: Map<string, string>): string | null {
	for (const name of ["lib.rs", "main.rs", "mod.rs"]) {
		const candidate = posix.join(root, name);
		if (fileIdsByPath.has(candidate)) return candidate;
	}
	return null;
}

function resolveRustDependency(
	sourcePath: string,
	specifier: string,
	fileIdsByPath: Map<string, string>,
): { targetId: string; targetPath: string } | null {
	const sourceDirectory = posix.dirname(sourcePath);
	const sourceRoot = rustCrateRoot(sourcePath);
	const rawParts = specifier
		.replace(/\{[\s\S]*$/, "")
		.split("::")
		.map((part) => part.trim())
		.filter((part) => part && part !== "*");
	let base = sourceDirectory;

	if (rawParts[0] === "crate") {
		rawParts.shift();
		base = sourceRoot;
	} else if (rawParts[0] === "self") {
		rawParts.shift();
	} else if (rawParts[0] === "super") {
		let levels = 0;
		while (rawParts[0] === "super") {
			rawParts.shift();
			levels += 1;
		}
		base = sourceDirectory;
		for (let index = 1; index < levels; index += 1) base = posix.dirname(base);
		if (rawParts.length === 0) {
			const entry = rustCrateEntry(base, fileIdsByPath);
			if (entry) return { targetId: fileIdsByPath.get(entry)!, targetPath: entry };
		}
	} else if (rawParts.length > 0) {
		const crateName = rawParts[0]!.replaceAll("-", "_");
		const crateEntry = [...fileIdsByPath.keys()].find((candidate) => {
			if (!candidate.endsWith("/src/lib.rs")) return false;
			const crateDirectory = candidate.slice(0, -"/src/lib.rs".length).split("/").at(-1);
			return crateDirectory?.replaceAll("-", "_") === crateName;
		});
		if (crateEntry) {
			rawParts.shift();
			if (rawParts.length === 0) {
				return { targetId: fileIdsByPath.get(crateEntry)!, targetPath: crateEntry };
			}
			base = posix.dirname(crateEntry);
		}
	}

	for (let length = rawParts.length; length > 0; length -= 1) {
		const modulePath = posix.join(base, ...rawParts.slice(0, length));
		for (const candidate of [`${modulePath}.rs`, posix.join(modulePath, "mod.rs")]) {
			const targetId = fileIdsByPath.get(candidate);
			if (targetId) return { targetId, targetPath: candidate };
		}
	}
	return null;
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
	if (language === "rust") {
		const target = resolveRustDependency(sourcePath, specifier, fileIdsByPath);
		if (target) return target;
	}
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
		testBytes: 0,
		testLines: 0,
		testComplexity: 0,
		testRanges: [],
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
				testBytes: 0,
				testLines: 0,
				testComplexity: 0,
				testRanges: [],
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
				node.testBytes += child.testBytes;
				node.testLines += child.testLines;
				node.testComplexity += child.testComplexity;
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
	const acceptedFiles: AcceptedFile[] = [];
	let skippedFiles = 0;
	let totalReadBytes = 0;
	let truncated = truncatedByFileCount;

	for (const repositoryPath of candidatePaths) {
		const normalizedPath = normalizeRepositoryPath(repositoryPath);
		if (
			!normalizedPath ||
			normalizedPath.startsWith("../") ||
			isExcludedPath(normalizedPath)
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
		if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
			skippedFiles += 1;
			continue;
		}

		const canReadContent =
			fileStats.size <= maxFileBytes &&
			totalReadBytes + fileStats.size <= maxTotalBytes;
		if (!canReadContent) {
			truncated = true;
			let metadata;
			try {
				metadata = await inspectTextMetadata(absolutePath, fileStats.size);
			} catch {
				skippedFiles += 1;
				continue;
			}
			if (metadata.binary) {
				skippedFiles += 1;
				continue;
			}
			acceptedFiles.push({
				path: normalizedPath,
				bytes: fileStats.size,
				content: null,
				lines: metadata.lines,
			});
			continue;
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
		acceptedFiles.push({
			path: normalizedPath,
			bytes: bytes.length,
			content: looksGenerated(content) ? null : content,
			lines: countLines(content),
		});
	}

	const structure = await analyzeAtlasStructure(
		resolvedRoot,
		acceptedFiles
			.filter((file) => file.content !== null && languageForPath(file.path) !== null)
			.map((file) => file.path),
	);
	const testRangesByPath = classifyRustRepositoryTestRanges(
		acceptedFiles
			.filter((file): file is AcceptedFile & { content: string } =>
				file.content !== null && languageForPath(file.path)?.language === "rust")
			.map((file) => ({
				...file,
				outline: structure.files.get(file.path),
			})),
	);
	for (const file of acceptedFiles) {
		if (file.content === null) continue;
		const language = languageForPath(file.path)?.language;
		if (language === "typescript" || language === "javascript") {
			testRangesByPath.set(
				file.path,
				classifyJavaScriptTestRanges(
					file.path,
					file.content,
					structure.files.get(file.path),
				),
			);
			continue;
		}
		if (language === "c" || language === "cpp") {
			testRangesByPath.set(
				file.path,
				classifyCFamilyTestRanges(
					file.path,
					file.content,
					structure.files.get(file.path),
				),
			);
			continue;
		}
		if (
			language !== "python" &&
			language !== "go" &&
			language !== "java" &&
			language !== "ruby"
		) continue;
		testRangesByPath.set(
			file.path,
			classifyConventionalTestRanges(
				language,
				file.path,
				file.content,
				structure.files.get(file.path),
			),
		);
	}

	for (const accepted of acceptedFiles) {
		const analysis = accepted.content === null
			? {
				...displayLanguageForPath(accepted.path),
				lines: accepted.lines,
				complexity: 0,
				symbols: [],
				imports: [],
			}
			: analyzeOutline(
				accepted.path,
				accepted.content,
				structure.files.get(accepted.path),
			);
		if (!analysis) {
			skippedFiles += 1;
			continue;
		}

		const id = nodeId("file", accepted.path);
		const parentId = ensureDirectoryNodes(accepted.path, rootNode, nodesById);
		const testRanges = testRangesByPath.get(accepted.path) ?? [];
		const classifiedTestMetrics = accepted.content === null
			? { bytes: 0, lines: 0, complexity: 0 }
			: testMetrics(
				accepted.content,
				analysis.language,
				analysis.complexity,
				testRanges,
			);
		const symbols: AtlasSymbol[] = analysis.symbols.map((symbol) => ({
			...symbol,
			id: symbolId(id, symbol.kind, symbol.name, symbol.line),
			fileId: id,
			isTest: lineIsInRanges(symbol.line, testRanges),
		}));
		const fileNode: AtlasNode = {
			id,
			path: accepted.path,
			name: posix.basename(accepted.path),
			parentId,
			childIds: [],
			kind: "file",
			depth: accepted.path.split("/").length,
			language: analysis.language,
			extension: analysis.extension,
			bytes: accepted.bytes,
			lines: analysis.lines,
			complexity: analysis.complexity,
			testBytes: classifiedTestMetrics.bytes,
			testLines: classifiedTestMetrics.lines,
			testComplexity: classifiedTestMetrics.complexity,
			testRanges,
			symbols,
		};
		nodesById.set(id, fileNode);
		nodesById.get(parentId)!.childIds.push(id);
		importsByFile.set(accepted.path, analysis.imports);
		languageByFile.set(accepted.path, analysis.language);
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
		version: ATLAS_SNAPSHOT_VERSION,
		rootName: rootNode.name,
		rootId: rootNode.id,
		generatedAt: new Date().toISOString(),
		nodes,
		dependencies,
		analyzers: {
			structural: structure.analyzer,
			semantic: {
				protocol: "lsp",
				providers: options.semanticProviders ?? [],
			},
		},
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

export type { AtlasTestRange, AtlasTestRangeReason } from "./atlas-test-classification";

export {
	findAtlasDeclarations,
	readAtlasSource,
	resolveAtlasCallHierarchy,
	resolveAtlasReferences,
	resolveAtlasSourcePath,
	validateAtlasRelativePath,
} from "./atlas-source";
export type {
	AtlasReference,
	AtlasReferenceProvider,
	AtlasReferenceResponse,
	AtlasCallHierarchyLocation,
	AtlasCallHierarchyProvider,
	AtlasCallHierarchyResponse,
	AtlasCallHierarchyTarget,
	AtlasSourceFile,
	SearchAtlasReferencesOptions,
} from "./atlas-source";
