import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AtlasSnapshot } from "./atlas";

export interface AtlasSourceFile {
	path: string;
	content: string;
	bytes: number;
	language: string;
}

export interface AtlasReference {
	kind: "definition" | "reference";
	fileId: string;
	filePath: string;
	line: number;
	column: number;
	snippet: string;
}

export interface SearchAtlasReferencesOptions {
	maxResults?: number;
	maxFileBytes?: number;
}

const DEFAULT_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_REFERENCE_RESULTS = 200;

const SOURCE_LANGUAGES: Record<string, string> = {
	".c": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cts": "typescript",
	".cxx": "cpp",
	".go": "go",
	".h": "c",
	".hh": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".java": "java",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".mts": "typescript",
	".py": "python",
	".pyi": "python",
	".rake": "ruby",
	".rb": "ruby",
	".rs": "rust",
	".ts": "typescript",
	".tsx": "typescript",
};

function normalizedRelativePath(filePath: string): string {
	return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function validateAtlasRelativePath(filePath: string): string {
	const normalized = normalizedRelativePath(filePath);
	if (
		!normalized ||
		isAbsolute(filePath) ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		normalized.includes("\0")
	) {
		throw new Error("Invalid Atlas file path");
	}
	return normalized;
}

export async function resolveAtlasSourcePath(
	rootPath: string,
	filePath: string,
): Promise<string> {
	const root = await realpath(resolve(rootPath));
	const normalized = validateAtlasRelativePath(filePath);
	const candidate = await realpath(resolve(root, ...normalized.split("/")));
	const fromRoot = relative(root, candidate);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new Error("Atlas file path escapes the repository root");
	}
	const fileStats = await stat(candidate);
	if (!fileStats.isFile()) throw new Error("Atlas source path must be a file");
	return candidate;
}

export async function readAtlasSource(
	rootPath: string,
	filePath: string,
	maxBytes = DEFAULT_SOURCE_MAX_BYTES,
): Promise<AtlasSourceFile> {
	const resolved = await resolveAtlasSourcePath(rootPath, filePath);
	const fileStats = await stat(resolved);
	if (fileStats.size > maxBytes) throw new Error("Atlas source file is too large");
	const bytes = await readFile(resolved);
	if (bytes.includes(0)) throw new Error("Atlas source file is binary");
	return {
		path: validateAtlasRelativePath(filePath),
		content: bytes.toString("utf8"),
		bytes: bytes.length,
		language: SOURCE_LANGUAGES[extname(resolved).toLowerCase()] ?? "text",
	};
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function findAtlasReferences(
	snapshot: AtlasSnapshot,
	symbol: string,
	filePath?: string,
	options: SearchAtlasReferencesOptions = {},
): Promise<AtlasReference[]> {
	if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(symbol)) {
		throw new Error("Invalid Atlas symbol");
	}
	const maxResults =
		Number.isFinite(options.maxResults) && options.maxResults! > 0
			? Math.floor(options.maxResults!)
			: DEFAULT_REFERENCE_RESULTS;
	const maxFileBytes =
		Number.isFinite(options.maxFileBytes) && options.maxFileBytes! > 0
			? Math.floor(options.maxFileBytes!)
			: DEFAULT_SOURCE_MAX_BYTES;
	const expression = new RegExp(
		`(?<![\\p{L}\\p{N}_$])${escapeRegex(symbol)}(?![\\p{L}\\p{N}_$])`,
		"gu",
	);
	const references: AtlasReference[] = [];
	const contextPath = filePath === undefined
		? null
		: validateAtlasRelativePath(filePath);
	const eligibleNodes = snapshot.nodes
		.filter((node) => node.kind === "file")
		.sort((a, b) => {
			if (a.path === contextPath) return -1;
			if (b.path === contextPath) return 1;
			return a.path.localeCompare(b.path);
		});
	const sourceByFileId = new Map<string, AtlasSourceFile>();

	const getSource = async (node: (typeof eligibleNodes)[number]): Promise<AtlasSourceFile | null> => {
		const cached = sourceByFileId.get(node.id);
		if (cached) return cached;
		try {
			const source = await readAtlasSource(snapshot.rootPath, node.path, maxFileBytes);
			sourceByFileId.set(node.id, source);
			return source;
		} catch {
			return null;
		}
	};

	// Definitions are emitted first so a result cap cannot hide the navigation target.
	const definitionLocations = new Set<string>();
	for (const node of eligibleNodes) {
		if (references.length >= maxResults) break;
		const declarations = node.symbols.filter((candidate) => candidate.name === symbol);
		if (declarations.length === 0) continue;
		const source = await getSource(node);
		if (!source) continue;
		const lines = source.content.split(/\r\n|\r|\n/);
		for (const declaration of declarations) {
			if (references.length >= maxResults) break;
			const line = lines[declaration.line - 1] ?? "";
			const column = line.indexOf(symbol);
			const locationKey = `${node.id}:${declaration.line}:${Math.max(0, column)}`;
			if (definitionLocations.has(locationKey)) continue;
			definitionLocations.add(locationKey);
			references.push({
				kind: "definition",
				fileId: node.id,
				filePath: node.path,
				line: declaration.line,
				column: Math.max(0, column) + 1,
				snippet: line.length > 240 ? `${line.slice(0, 239)}…` : line,
			});
		}
	}

	for (const node of eligibleNodes) {
		if (references.length >= maxResults) break;
		const source = await getSource(node);
		if (!source) continue;
		const lines = source.content.split(/\r\n|\r|\n/);
		for (let index = 0; index < lines.length && references.length < maxResults; index += 1) {
			const line = lines[index]!;
			expression.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = expression.exec(line)) !== null && references.length < maxResults) {
				if (definitionLocations.has(`${node.id}:${index + 1}:${match.index}`)) continue;
				references.push({
					kind: "reference",
					fileId: node.id,
					filePath: node.path,
					line: index + 1,
					column: match.index + 1,
					snippet: line.length > 240 ? `${line.slice(0, 239)}…` : line,
				});
			}
		}
	}

	return references;
}
