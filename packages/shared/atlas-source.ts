import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AtlasSnapshot } from "./atlas";
import {
	AtlasSemanticSession,
	AtlasSemanticUnavailableError,
	type AtlasSemanticLanguage,
	type AtlasSemanticLocation,
} from "./atlas-semantic";

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

export interface AtlasReferenceProvider {
	kind: "lsp" | "syntax";
	name: string;
	status: "ready" | "unavailable";
	message?: string;
}

export interface AtlasReferenceResponse {
	definitions: AtlasReference[];
	references: AtlasReference[];
	provider: AtlasReferenceProvider;
}

export interface SearchAtlasReferencesOptions {
	maxResults?: number;
	maxFileBytes?: number;
}

const DEFAULT_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_REFERENCE_RESULTS = 200;
const SEMANTIC_COLD_START_DELAYS_MS = [350, 700, 1_400];

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

export async function findAtlasDeclarations(
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
			const column = declaration.column;
			const locationKey = `${node.id}:${declaration.line}:${column}`;
			if (definitionLocations.has(locationKey)) continue;
			definitionLocations.add(locationKey);
			references.push({
				kind: "definition",
				fileId: node.id,
				filePath: node.path,
				line: declaration.line,
				column,
				snippet: line.length > 240 ? `${line.slice(0, 239)}…` : line,
			});
		}
	}

	return references;
}

function semanticLanguage(value: string | null): AtlasSemanticLanguage | null {
	switch (value) {
		case "rust":
		case "typescript":
		case "javascript":
		case "python":
		case "go":
		case "c":
		case "cpp":
		case "java":
		case "ruby":
			return value;
		default:
			return null;
	}
}

async function referenceFromSemanticLocation(
	snapshot: AtlasSnapshot,
	location: AtlasSemanticLocation,
	kind: AtlasReference["kind"],
): Promise<AtlasReference | null> {
	if (location.external) return null;
	const node = snapshot.nodes.find(
		(candidate) => candidate.kind === "file" && candidate.path === location.filePath,
	);
	if (!node) return null;
	let snippet = "";
	try {
		const source = await readAtlasSource(snapshot.rootPath, node.path);
		const line = source.content.split(/\r\n|\r|\n/)[location.range.start.line - 1] ?? "";
		snippet = line.length > 240 ? `${line.slice(0, 239)}…` : line;
	} catch {
		// The semantic location remains useful even if the file changed after indexing.
	}
	return {
		kind,
		fileId: node.id,
		filePath: node.path,
		line: location.range.start.line,
		column: location.range.start.column,
		snippet,
	};
}

async function convertSemanticLocations(
	snapshot: AtlasSnapshot,
	locations: AtlasSemanticLocation[],
	kind: AtlasReference["kind"],
): Promise<AtlasReference[]> {
	const converted = await Promise.all(
		locations.map((location) => referenceFromSemanticLocation(snapshot, location, kind)),
	);
	return converted
		.filter((location): location is AtlasReference => location !== null)
		.slice(0, DEFAULT_REFERENCE_RESULTS);
}

export async function resolveAtlasReferences(
	session: AtlasSemanticSession,
	snapshot: AtlasSnapshot,
	symbol: string,
	filePath: string,
	line: number,
	column: number,
): Promise<AtlasReferenceResponse> {
	const normalizedPath = validateAtlasRelativePath(filePath);
	const node = snapshot.nodes.find(
		(candidate) => candidate.kind === "file" && candidate.path === normalizedPath,
	);
	if (!node) throw new Error("Atlas source file is not indexed");
	const language = semanticLanguage(node.language);
	const indexedDeclarations = await findAtlasDeclarations(snapshot, symbol, normalizedPath);
	const capability = snapshot.analyzers.semantic.providers.find(
		(provider) => provider.language === node.language,
	);

	if (!language || capability?.available === false) {
		const name = capability?.name ?? node.language ?? "language server";
		const reason = capability?.reason ?? `No language server is configured for ${node.language ?? "this file"}`;
		const detail = reason.replace(/[.\s]+$/, "");
		return {
			definitions: indexedDeclarations,
			references: [],
			provider: {
				kind: "syntax",
				name: snapshot.analyzers.structural.name,
				status: "unavailable",
				message: `${name} is unavailable: ${detail}. Showing indexed declarations only.`,
			},
		};
	}

	try {
		let locations = await session.findLocations(
			snapshot.rootPath,
			normalizedPath,
			line,
			column,
			language,
		);
		for (const delayMs of SEMANTIC_COLD_START_DELAYS_MS) {
			if (
				indexedDeclarations.length === 0 ||
				locations.definitions.length > 0 ||
				locations.references.length > 0
			) break;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
			locations = await session.findLocations(
				snapshot.rootPath,
				normalizedPath,
				line,
				column,
				language,
			);
		}
		return {
			definitions: await convertSemanticLocations(snapshot, locations.definitions, "definition"),
			references: await convertSemanticLocations(snapshot, locations.references, "reference"),
			provider: {
				kind: "lsp",
				name: capability?.name ?? language,
				status: "ready",
			},
		};
	} catch (error) {
		const name = error instanceof AtlasSemanticUnavailableError
			? error.capability.serverId
			: capability?.name ?? language;
		const message = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, "");
		return {
			definitions: indexedDeclarations,
			references: [],
			provider: {
				kind: "syntax",
				name: snapshot.analyzers.structural.name,
				status: "unavailable",
				message: `${name} could not provide semantic navigation: ${message}. Showing indexed declarations only.`,
			},
		};
	}
}
