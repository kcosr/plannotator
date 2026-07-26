import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AtlasSnapshot } from "./atlas";
import {
	AtlasSemanticSession,
	AtlasSemanticUnavailableError,
	type AtlasSemanticCallHierarchyCall,
	type AtlasSemanticCallHierarchyItem,
	type AtlasSemanticLanguage,
	type AtlasSemanticLocation,
	type AtlasSemanticRange,
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

export interface AtlasCallHierarchyLocation {
	fileId: string;
	filePath: string;
	line: number;
	column: number;
	snippet: string;
}

export interface AtlasCallHierarchyTarget {
	name: string;
	kind: number;
	detail?: string;
	declaration: AtlasCallHierarchyLocation;
	callSites: AtlasCallHierarchyLocation[];
}

export interface AtlasCallHierarchyProvider {
	kind: "lsp";
	name: string;
	status: "ready" | "unsupported" | "unavailable";
	message?: string;
}

export interface AtlasCallHierarchyResponse {
	root: AtlasCallHierarchyTarget | null;
	callers: AtlasCallHierarchyTarget[];
	callees: AtlasCallHierarchyTarget[];
	truncated: boolean;
	provider: AtlasCallHierarchyProvider;
}

export interface SearchAtlasReferencesOptions {
	maxResults?: number;
	maxFileBytes?: number;
}

export type AtlasSemanticResolutionOutcome<T> =
	| {
			cacheability: "complete" | "unsupported";
			response: T;
	  }
	| {
			cacheability: "transient" | "fallback";
			response: T;
	  };

const DEFAULT_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_REFERENCE_RESULTS = 200;
const DEFAULT_CALL_HIERARCHY_TARGETS = 200;
const DEFAULT_CALL_HIERARCHY_CALL_SITES = 2_000;
const SEMANTIC_COLD_START_DELAYS_MS = [350, 700, 1_400];

function waitForSemanticRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
	signal.throwIfAborted();
	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolvePromise();
		}, delayMs);
		const abort = () => {
			clearTimeout(timeout);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

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
	rootPath: string,
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
			const source = await readAtlasSource(rootPath, node.path, maxFileBytes);
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
	rootPath: string,
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
		const source = await readAtlasSource(rootPath, node.path);
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
	rootPath: string,
	snapshot: AtlasSnapshot,
	locations: AtlasSemanticLocation[],
	kind: AtlasReference["kind"],
): Promise<AtlasReference[]> {
	const converted = await Promise.all(
		locations.map((location) =>
			referenceFromSemanticLocation(rootPath, snapshot, location, kind)
		),
	);
	return converted
		.filter((location): location is AtlasReference => location !== null)
		.slice(0, DEFAULT_REFERENCE_RESULTS);
}

async function callHierarchyLocation(
	rootPath: string,
	filePath: string,
	range: AtlasSemanticRange,
	nodesByPath: ReadonlyMap<string, AtlasSnapshot["nodes"][number]>,
	sourceLines: Map<string, Promise<string[] | null>>,
): Promise<AtlasCallHierarchyLocation | null> {
	const node = nodesByPath.get(filePath);
	if (!node) return null;
	let snippet = "";
	let pendingLines = sourceLines.get(node.path);
	if (!pendingLines) {
		pendingLines = readAtlasSource(rootPath, node.path)
			.then((source) => source.content.split(/\r\n|\r|\n/))
			.catch(() => null);
		sourceLines.set(node.path, pendingLines);
	}
	const lines = await pendingLines;
	if (lines) {
		const line = lines[range.start.line - 1] ?? "";
		snippet = line.length > 240 ? `${line.slice(0, 239)}…` : line;
	}
	return {
		fileId: node.id,
		filePath: node.path,
		line: range.start.line,
		column: range.start.column,
		snippet,
	};
}

async function callHierarchyTarget(
	rootPath: string,
	snapshot: AtlasSnapshot,
	item: AtlasSemanticCallHierarchyItem,
	callSitePath: string | null,
	fromRanges: AtlasSemanticRange[],
	nodesByPath: ReadonlyMap<string, AtlasSnapshot["nodes"][number]>,
	sourceLines: Map<string, Promise<string[] | null>>,
): Promise<AtlasCallHierarchyTarget | null> {
	if (item.location.external) return null;
	const declaration = await callHierarchyLocation(
		rootPath,
		item.location.filePath,
		item.selectionRange,
		nodesByPath,
		sourceLines,
	);
	if (!declaration) return null;
	const callSites = callSitePath === null
		? []
		: (
				await Promise.all(
					fromRanges.map((range) =>
						callHierarchyLocation(
							rootPath,
							callSitePath,
							range,
							nodesByPath,
							sourceLines,
						),
					),
				)
		).filter((location): location is AtlasCallHierarchyLocation => location !== null);
	return {
		name: item.name,
		kind: item.kind,
		...(item.detail ? { detail: item.detail } : {}),
		declaration,
		callSites,
	};
}

async function convertCallHierarchyCalls(
	rootPath: string,
	snapshot: AtlasSnapshot,
	calls: AtlasSemanticCallHierarchyCall[],
	callSitePath: (call: AtlasSemanticCallHierarchyCall) => string | null,
	nodesByPath: ReadonlyMap<string, AtlasSnapshot["nodes"][number]>,
	sourceLines: Map<string, Promise<string[] | null>>,
): Promise<{ targets: AtlasCallHierarchyTarget[]; truncated: boolean }> {
	const groupedCalls = new Map<string, AtlasSemanticCallHierarchyCall>();
	for (const call of calls) {
		const key = [
			call.item.location.filePath,
			call.item.selectionRange.start.line,
			call.item.selectionRange.start.column,
		].join(":");
		const existing = groupedCalls.get(key);
		if (!existing) {
			groupedCalls.set(key, { ...call, fromRanges: [...call.fromRanges] });
			continue;
		}
		const seen = new Set(
			existing.fromRanges.map(
				(range) =>
					`${range.start.line}:${range.start.column}:${range.end.line}:${range.end.column}`,
			),
		);
		for (const range of call.fromRanges) {
			const rangeKey =
				`${range.start.line}:${range.start.column}:${range.end.line}:${range.end.column}`;
			if (!seen.has(rangeKey)) {
				seen.add(rangeKey);
				existing.fromRanges.push(range);
			}
		}
	}
	const allCalls = [...groupedCalls.values()];
	let truncated = allCalls.length > DEFAULT_CALL_HIERARCHY_TARGETS;
	let remainingCallSites = DEFAULT_CALL_HIERARCHY_CALL_SITES;
	const boundedCalls = allCalls
		.slice(0, DEFAULT_CALL_HIERARCHY_TARGETS)
		.map((call) => {
			const fromRanges = call.fromRanges.slice(0, remainingCallSites);
			if (fromRanges.length < call.fromRanges.length) truncated = true;
			remainingCallSites -= fromRanges.length;
			return { ...call, fromRanges };
		});
	const converted = await Promise.all(
		boundedCalls.map((call) =>
			callHierarchyTarget(
				rootPath,
				snapshot,
				call.item,
				callSitePath(call),
				call.fromRanges,
				nodesByPath,
				sourceLines,
			),
		),
	);
	const grouped = new Map<string, AtlasCallHierarchyTarget>();
	for (const target of converted) {
		if (!target) continue;
		const key = [
			target.declaration.fileId,
			target.declaration.line,
			target.declaration.column,
		].join(":");
		const existing = grouped.get(key);
		if (!existing) {
			grouped.set(key, target);
			continue;
		}
		const seen = new Set(
			existing.callSites.map(
				(site) => `${site.fileId}:${site.line}:${site.column}`,
			),
		);
		for (const site of target.callSites) {
			const siteKey = `${site.fileId}:${site.line}:${site.column}`;
			if (!seen.has(siteKey)) {
				seen.add(siteKey);
				existing.callSites.push(site);
			}
		}
	}
	return { targets: [...grouped.values()], truncated };
}

export async function resolveAtlasCallHierarchyOutcome(
	session: AtlasSemanticSession,
	rootPath: string,
	snapshot: AtlasSnapshot,
	filePath: string,
	line: number,
	column: number,
	signal?: AbortSignal,
): Promise<AtlasSemanticResolutionOutcome<AtlasCallHierarchyResponse>> {
	signal?.throwIfAborted();
	const normalizedPath = validateAtlasRelativePath(filePath);
	const node = snapshot.nodes.find(
		(candidate) => candidate.kind === "file" && candidate.path === normalizedPath,
	);
	if (!node) throw new Error("Atlas source file is not indexed");
	const language = semanticLanguage(node.language);
	const capability = snapshot.analyzers.semantic.providers.find(
		(provider) => provider.language === node.language,
	);
	const providerName = capability?.name ?? node.language ?? "language server";

	if (!language) {
		const reason =
			capability?.reason ??
			`No language server is configured for ${node.language ?? "this file"}`;
		return {
			cacheability: "fallback",
			response: {
				root: null,
				callers: [],
				callees: [],
				truncated: false,
				provider: {
					kind: "lsp",
					name: providerName,
					status: "unavailable",
					message: reason.replace(/[.\s]+$/, ""),
				},
			},
		};
	}

	try {
		let hierarchy = await session.findCallHierarchy(
			rootPath,
			normalizedPath,
			line,
			column,
			language,
			signal,
		);
		for (const delayMs of SEMANTIC_COLD_START_DELAYS_MS) {
			if (!hierarchy.supported || hierarchy.root !== null) break;
			await waitForSemanticRetry(delayMs, signal);
			hierarchy = await session.findCallHierarchy(
				rootPath,
				normalizedPath,
				line,
				column,
				language,
				signal,
			);
		}
		if (!hierarchy.supported) {
			return {
				cacheability: "unsupported",
				response: {
					root: null,
					callers: [],
					callees: [],
					truncated: false,
					provider: {
						kind: "lsp",
						name: providerName,
						status: "unsupported",
						message: `${providerName} does not advertise LSP call hierarchy support`,
					},
				},
			};
		}

		const nodesByPath = new Map(
			snapshot.nodes
				.filter((candidate) => candidate.kind === "file")
				.map((candidate) => [candidate.path, candidate]),
		);
		const sourceLines = new Map<string, Promise<string[] | null>>();
		const root = hierarchy.root === null
			? null
			: await callHierarchyTarget(
				rootPath,
				snapshot,
				hierarchy.root,
				null,
				[],
				nodesByPath,
				sourceLines,
			);
		const callers = await convertCallHierarchyCalls(
			rootPath,
			snapshot,
			hierarchy.incoming,
			(call) => call.item.location.external ? null : call.item.location.filePath,
			nodesByPath,
			sourceLines,
		);
		const rootFilePath = hierarchy.root?.location.external === false
			? hierarchy.root.location.filePath
			: normalizedPath;
		const callees = await convertCallHierarchyCalls(
			rootPath,
			snapshot,
			hierarchy.outgoing,
			() => rootFilePath,
			nodesByPath,
			sourceLines,
		);
		return {
			cacheability: "complete",
			response: {
				root,
				callers: callers.targets,
				callees: callees.targets,
				truncated: callers.truncated || callees.truncated,
				provider: {
					kind: "lsp",
					name: providerName,
					status: "ready",
				},
			},
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		const name = error instanceof AtlasSemanticUnavailableError
			? error.capability.serverId
			: providerName;
		const message = (error instanceof Error ? error.message : String(error))
			.replace(/[.\s]+$/, "");
		return {
			cacheability: "transient",
			response: {
				root: null,
				callers: [],
				callees: [],
				truncated: false,
				provider: {
					kind: "lsp",
					name,
					status: "unavailable",
					message: `${name} could not provide call hierarchy: ${message}`,
				},
			},
		};
	}
}

export async function resolveAtlasCallHierarchy(
	session: AtlasSemanticSession,
	rootPath: string,
	snapshot: AtlasSnapshot,
	filePath: string,
	line: number,
	column: number,
	signal?: AbortSignal,
): Promise<AtlasCallHierarchyResponse> {
	return (
		await resolveAtlasCallHierarchyOutcome(
			session,
			rootPath,
			snapshot,
			filePath,
			line,
			column,
			signal,
		)
	).response;
}

export async function resolveAtlasReferencesOutcome(
	session: AtlasSemanticSession,
	rootPath: string,
	snapshot: AtlasSnapshot,
	symbol: string,
	filePath: string,
	line: number,
	column: number,
	signal?: AbortSignal,
): Promise<AtlasSemanticResolutionOutcome<AtlasReferenceResponse>> {
	signal?.throwIfAborted();
	const normalizedPath = validateAtlasRelativePath(filePath);
	const node = snapshot.nodes.find(
		(candidate) => candidate.kind === "file" && candidate.path === normalizedPath,
	);
	if (!node) throw new Error("Atlas source file is not indexed");
	const language = semanticLanguage(node.language);
	const indexedDeclarations = await findAtlasDeclarations(
		rootPath,
		snapshot,
		symbol,
		normalizedPath,
	);
	const capability = snapshot.analyzers.semantic.providers.find(
		(provider) => provider.language === node.language,
	);

	if (!language) {
		const name = capability?.name ?? node.language ?? "language server";
		const reason = capability?.reason ?? `No language server is configured for ${node.language ?? "this file"}`;
		const detail = reason.replace(/[.\s]+$/, "");
		return {
			cacheability: "fallback",
			response: {
				definitions: indexedDeclarations,
				references: [],
				provider: {
					kind: "syntax",
					name: snapshot.analyzers.structural.name,
					status: "unavailable",
					message: `${name} is unavailable: ${detail}. Showing indexed declarations only.`,
				},
			},
		};
	}

	try {
		let locations = await session.findLocations(
			rootPath,
			normalizedPath,
			line,
			column,
			language,
			signal,
		);
		for (const delayMs of SEMANTIC_COLD_START_DELAYS_MS) {
			if (
				indexedDeclarations.length === 0 ||
				locations.definitions.length > 0 ||
				locations.references.length > 0
			) break;
			await waitForSemanticRetry(delayMs, signal);
			locations = await session.findLocations(
				rootPath,
				normalizedPath,
				line,
				column,
				language,
				signal,
			);
		}
		return {
			cacheability: "complete",
			response: {
				definitions: await convertSemanticLocations(
					rootPath,
					snapshot,
					locations.definitions,
					"definition",
				),
				references: await convertSemanticLocations(
					rootPath,
					snapshot,
					locations.references,
					"reference",
				),
				provider: {
					kind: "lsp",
					name: capability?.name ?? language,
					status: "ready",
				},
			},
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		const name = error instanceof AtlasSemanticUnavailableError
			? error.capability.serverId
			: capability?.name ?? language;
		const message = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, "");
		return {
			cacheability: "transient",
			response: {
				definitions: indexedDeclarations,
				references: [],
				provider: {
					kind: "syntax",
					name: snapshot.analyzers.structural.name,
					status: "unavailable",
					message: `${name} could not provide semantic navigation: ${message}. Showing indexed declarations only.`,
				},
			},
		};
	}
}

export async function resolveAtlasReferences(
	session: AtlasSemanticSession,
	rootPath: string,
	snapshot: AtlasSnapshot,
	symbol: string,
	filePath: string,
	line: number,
	column: number,
	signal?: AbortSignal,
): Promise<AtlasReferenceResponse> {
	return (
		await resolveAtlasReferencesOutcome(
			session,
			rootPath,
			snapshot,
			symbol,
			filePath,
			line,
			column,
			signal,
		)
	).response;
}
