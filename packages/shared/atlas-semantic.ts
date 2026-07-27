import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import {
	delimiter,
	extname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CancellationTokenSource,
	createMessageConnection,
	ResponseError,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from "vscode-jsonrpc/node";

export type AtlasSemanticLanguage =
	| "rust"
	| "typescript"
	| "javascript"
	| "python"
	| "go"
	| "c"
	| "cpp"
	| "java"
	| "ruby";

export type AtlasSemanticServerId =
	| "rust-analyzer"
	| "typescript-language-server"
	| "pyright-langserver"
	| "gopls"
	| "clangd"
	| "jdtls"
	| "solargraph";

export interface AtlasSemanticCapability {
	language: AtlasSemanticLanguage;
	serverId: AtlasSemanticServerId;
	available: boolean;
	envVariable: string;
	command?: string;
	args?: string[];
	version?: string;
	reason?: string;
}

export interface AtlasSemanticPosition {
	line: number;
	column: number;
}

export interface AtlasSemanticRange {
	start: AtlasSemanticPosition;
	end: AtlasSemanticPosition;
}

export interface AtlasSemanticLocation {
	filePath: string;
	range: AtlasSemanticRange;
	external: boolean;
}

export interface AtlasSemanticLocations {
	definitions: AtlasSemanticLocation[];
	references: AtlasSemanticLocation[];
}

export interface AtlasSemanticCallHierarchyItem {
	name: string;
	kind: number;
	detail?: string;
	location: AtlasSemanticLocation;
	selectionRange: AtlasSemanticRange;
}

export interface AtlasSemanticCallHierarchyCall {
	item: AtlasSemanticCallHierarchyItem;
	fromRanges: AtlasSemanticRange[];
}

export interface AtlasSemanticCallHierarchy {
	supported: boolean;
	root: AtlasSemanticCallHierarchyItem | null;
	incoming: AtlasSemanticCallHierarchyCall[];
	outgoing: AtlasSemanticCallHierarchyCall[];
}

export interface AtlasSemanticProbeOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface AtlasSemanticSessionOptions extends AtlasSemanticProbeOptions {
	initializeTimeoutMs?: number;
	requestTimeoutMs?: number;
	shutdownTimeoutMs?: number;
}

type ServerDefinition = {
	id: AtlasSemanticServerId;
	languages: AtlasSemanticLanguage[];
	executable: string;
	args: string[];
	versionArgs: string[];
	envVariable: string;
};

type LspPosition = {
	line: number;
	character: number;
};

type LspRange = {
	start: LspPosition;
	end: LspPosition;
};

type LspLocation = {
	uri: string;
	range: LspRange;
};

type LspLocationLink = {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange?: LspRange;
};

type LspCallHierarchyItem = {
	name: string;
	kind: number;
	detail?: string;
	uri: string;
	range: LspRange;
	selectionRange: LspRange;
	data?: unknown;
};

type LspCallHierarchyIncomingCall = {
	from: LspCallHierarchyItem;
	fromRanges: LspRange[];
};

type LspCallHierarchyOutgoingCall = {
	to: LspCallHierarchyItem;
	fromRanges: LspRange[];
};

type ActiveClient = {
	key: string;
	definition: ServerDefinition;
	rootPath: string;
	process: ChildProcessWithoutNullStreams;
	connection: MessageConnection;
	processFailure: Promise<Error>;
	initialized: boolean;
	callHierarchySupported: boolean;
	stopping: boolean;
	stderr: string;
	queue: Promise<void>;
};

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const LSP_CONTENT_MODIFIED = -32801;
const CONTENT_MODIFIED_RETRY_DELAYS_MS = [75, 150, 300];

function isContentModifiedError(error: unknown): boolean {
	return error instanceof ResponseError && error.code === LSP_CONTENT_MODIFIED;
}

async function retryContentModified<T>(request: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await request();
		} catch (error) {
			if (
				!isContentModifiedError(error) ||
				attempt >= CONTENT_MODIFIED_RETRY_DELAYS_MS.length
			) {
				throw error;
			}
			await new Promise((resolvePromise) =>
				setTimeout(resolvePromise, CONTENT_MODIFIED_RETRY_DELAYS_MS[attempt]),
			);
		}
	}
}

const SERVER_DEFINITIONS: ServerDefinition[] = [
	{
		id: "rust-analyzer",
		languages: ["rust"],
		executable: "rust-analyzer",
		args: [],
		versionArgs: ["--version"],
		envVariable: "PLANNOTATOR_LSP_RUST_ANALYZER",
	},
	{
		id: "typescript-language-server",
		languages: ["typescript", "javascript"],
		executable: "typescript-language-server",
		args: ["--stdio"],
		versionArgs: ["--version"],
		envVariable: "PLANNOTATOR_LSP_TYPESCRIPT_LANGUAGE_SERVER",
	},
	{
		id: "pyright-langserver",
		languages: ["python"],
		executable: "pyright-langserver",
		args: ["--stdio"],
		versionArgs: ["--version"],
		envVariable: "PLANNOTATOR_LSP_PYRIGHT",
	},
	{
		id: "gopls",
		languages: ["go"],
		executable: "gopls",
		args: ["serve"],
		versionArgs: ["version"],
		envVariable: "PLANNOTATOR_LSP_GOPLS",
	},
	{
		id: "clangd",
		languages: ["c", "cpp"],
		executable: "clangd",
		args: ["--background-index"],
		versionArgs: ["--version"],
		envVariable: "PLANNOTATOR_LSP_CLANGD",
	},
	{
		id: "jdtls",
		languages: ["java"],
		executable: "jdtls",
		args: [],
		versionArgs: ["--version"],
		envVariable: "PLANNOTATOR_LSP_JDTLS",
	},
	{
		id: "solargraph",
		languages: ["ruby"],
		executable: "solargraph",
		args: ["stdio"],
		versionArgs: ["--version"],
		envVariable: "PLANNOTATOR_LSP_SOLARGRAPH",
	},
];

const DEFINITION_BY_LANGUAGE = new Map<AtlasSemanticLanguage, ServerDefinition>(
	SERVER_DEFINITIONS.flatMap((definition) =>
		definition.languages.map((language) => [language, definition] as const),
	),
);

export class AtlasSemanticUnavailableError extends Error {
	readonly capability: AtlasSemanticCapability;

	constructor(capability: AtlasSemanticCapability) {
		super(
			capability.reason ??
				`No validated ${capability.serverId} executable is available for ${capability.language}`,
		);
		this.name = "AtlasSemanticUnavailableError";
		this.capability = capability;
	}
}

export class AtlasSemanticTimeoutError extends Error {
	readonly operation: string;
	readonly timeoutMs: number;

	constructor(operation: string, timeoutMs: number) {
		super(`LSP ${operation} timed out after ${timeoutMs}ms`);
		this.name = "AtlasSemanticTimeoutError";
		this.operation = operation;
		this.timeoutMs = timeoutMs;
	}
}

export class AtlasSemanticProcessError extends Error {
	readonly serverId: AtlasSemanticServerId;

	constructor(serverId: AtlasSemanticServerId, message: string) {
		super(message);
		this.name = "AtlasSemanticProcessError";
		this.serverId = serverId;
	}
}

function positiveTimeout(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function isExecutable(filePath: string): boolean {
	try {
		const stats = statSync(filePath);
		if (!stats.isFile()) return false;
		accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32") return [""];
	return (env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
		.split(";")
		.filter(Boolean)
		.flatMap((extension) => [extension, extension.toLowerCase()]);
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
	const trimmed = command.trim();
	if (!trimmed) return null;
	if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
		const candidate = resolve(trimmed);
		return isExecutable(candidate) ? candidate : null;
	}

	const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		for (const extension of pathExtensions(env)) {
			const candidate = resolve(directory, `${trimmed}${extension}`);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return null;
}

function runVersionProbe(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, {
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			signal,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		const finish = (
			result: { ok: true; version: string } | { ok: false; reason: string },
		): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(result);
		};
		const append = (chunks: Buffer[], chunk: Buffer): void => {
			const currentBytes = chunks.reduce((sum, item) => sum + item.length, 0);
			if (currentBytes < MAX_DIAGNOSTIC_BYTES) {
				chunks.push(chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - currentBytes));
			}
		};
		child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
		child.once("error", (error) => {
			finish({ ok: false, reason: `Failed to execute ${command}: ${error.message}` });
		});
		child.once("close", (code, signal) => {
			const output = Buffer.concat([...stdout, ...stderr]).toString("utf8").trim();
			if (code === 0) {
				finish({ ok: true, version: output || "version command succeeded" });
				return;
			}
			const detail = output ? `: ${output}` : signal ? ` (${signal})` : "";
			finish({
				ok: false,
				reason: `${command} version check exited with code ${code ?? "unknown"}${detail}`,
			});
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, reason: `${command} version check timed out after ${timeoutMs}ms` });
		}, timeoutMs);
	});
}

function definitionForLanguage(language: AtlasSemanticLanguage): ServerDefinition {
	const definition = DEFINITION_BY_LANGUAGE.get(language);
	if (!definition) {
		throw new Error(`Unsupported Atlas semantic language: ${String(language)}`);
	}
	return definition;
}

export async function probeAtlasSemanticCapability(
	language: AtlasSemanticLanguage,
	options: AtlasSemanticProbeOptions = {},
): Promise<AtlasSemanticCapability> {
	options.signal?.throwIfAborted();
	const definition = definitionForLanguage(language);
	const env = options.env ?? process.env;
	const override = env[definition.envVariable]?.trim();
	const requestedCommand = override || definition.executable;
	const command = resolveExecutable(requestedCommand, env);
	const base: AtlasSemanticCapability = {
		language,
		serverId: definition.id,
		available: false,
		envVariable: definition.envVariable,
	};

	if (!command) {
		return {
			...base,
			reason: override
				? `${definition.envVariable} does not point to an executable file: ${requestedCommand}`
				: `${definition.executable} is not available on PATH`,
		};
	}

	const result = await runVersionProbe(
		command,
		definition.versionArgs,
		env,
		positiveTimeout(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
		options.signal,
	);
	options.signal?.throwIfAborted();
	if (!result.ok) {
		return { ...base, command, reason: result.reason };
	}

	return {
		...base,
		available: true,
		command,
		args: [...definition.args],
		version: result.version,
	};
}

export async function probeAtlasSemanticCapabilities(
	options: AtlasSemanticProbeOptions = {},
): Promise<Record<AtlasSemanticLanguage, AtlasSemanticCapability>> {
	const probedServers = await Promise.all(
		SERVER_DEFINITIONS.map(async (definition) => ({
			definition,
			capability: await probeAtlasSemanticCapability(definition.languages[0]!, options),
		})),
	);
	const capabilities = probedServers.flatMap(({ definition, capability }) =>
		definition.languages.map((language) => ({ ...capability, language })),
	);
	return Object.fromEntries(
		capabilities.map((capability) => [capability.language, capability]),
	) as Record<AtlasSemanticLanguage, AtlasSemanticCapability>;
}

function withinRoot(candidate: string, rootPath: string): boolean {
	const fromRoot = relative(rootPath, candidate);
	return (
		fromRoot === "" ||
		(fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
	);
}

function resolveSourcePath(rootPath: string, filePath: string): {
	rootPath: string;
	sourcePath: string;
	relativePath: string;
} {
	const realRoot = realpathSync(resolve(rootPath));
	if (!statSync(realRoot).isDirectory()) {
		throw new Error(`Atlas semantic root is not a directory: ${rootPath}`);
	}
	if (!filePath || isAbsolute(filePath)) {
		throw new Error("Atlas semantic source path must be repository-relative");
	}
	const sourcePath = realpathSync(resolve(realRoot, filePath));
	if (!withinRoot(sourcePath, realRoot) || !statSync(sourcePath).isFile()) {
		throw new Error(`Atlas semantic source file is outside the repository: ${filePath}`);
	}
	return {
		rootPath: realRoot,
		sourcePath,
		relativePath: relative(realRoot, sourcePath).split(sep).join("/"),
	};
}

function languageIdForPath(
	language: AtlasSemanticLanguage,
	filePath: string,
): string {
	const extension = extname(filePath).toLowerCase();
	if (language === "typescript" && extension === ".tsx") return "typescriptreact";
	if (language === "javascript" && extension === ".jsx") return "javascriptreact";
	return language;
}

function withTimeout<T>(
	promise: Promise<T>,
	operation: string,
	timeoutMs: number,
): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(
			() => rejectPromise(new AtlasSemanticTimeoutError(operation, timeoutMs)),
			timeoutMs,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolvePromise(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				rejectPromise(error);
			},
		);
	});
}

function guardProcess<T>(client: ActiveClient, promise: Promise<T>): Promise<T> {
	return Promise.race([
		promise,
		client.processFailure.then((error) => Promise.reject(error)),
	]);
}

function diagnosticMessage(client: ActiveClient, fallback: string): string {
	const detail = client.stderr.trim();
	return detail ? `${fallback}: ${detail}` : fallback;
}

function createActiveClient(
	key: string,
	definition: ServerDefinition,
	capability: AtlasSemanticCapability,
	rootPath: string,
	env: NodeJS.ProcessEnv,
): ActiveClient {
	const command = capability.command!;
	const child = spawn(command, capability.args ?? definition.args, {
		cwd: rootPath,
		env,
		stdio: "pipe",
		windowsHide: true,
	});
	let resolveProcessFailure!: (error: Error) => void;
	const processFailure = new Promise<Error>((resolvePromise) => {
		resolveProcessFailure = resolvePromise;
	});
	const connection = createMessageConnection(
		new StreamMessageReader(child.stdout),
		new StreamMessageWriter(child.stdin),
	);
	const client: ActiveClient = {
		key,
		definition,
		rootPath,
		process: child,
		connection,
		processFailure,
		initialized: false,
		callHierarchySupported: false,
		stopping: false,
		stderr: "",
		queue: Promise.resolve(),
	};

	child.stderr.on("data", (chunk: Buffer) => {
		if (client.stderr.length >= MAX_DIAGNOSTIC_BYTES) return;
		client.stderr += chunk.toString("utf8").slice(
			0,
			MAX_DIAGNOSTIC_BYTES - client.stderr.length,
		);
	});
	child.once("error", (error) => {
		resolveProcessFailure(
			new AtlasSemanticProcessError(
				definition.id,
				diagnosticMessage(client, `Failed to start ${definition.id}: ${error.message}`),
			),
		);
	});
	child.once("exit", (code, signal) => {
		if (client.stopping) return;
		resolveProcessFailure(
			new AtlasSemanticProcessError(
				definition.id,
				diagnosticMessage(
					client,
					`${definition.id} exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
				),
			),
		);
	});

	connection.onRequest("workspace/configuration", (params: unknown) => {
		const items = (params as { items?: unknown[] } | null)?.items;
		return Array.isArray(items) ? items.map(() => null) : [];
	});
	connection.onRequest("client/registerCapability", (params: unknown) => {
		const registrations = (params as {
			registrations?: Array<{ method?: string }>;
		} | null)?.registrations;
		if (
			Array.isArray(registrations) &&
			registrations.some(
				(registration) => registration.method === "textDocument/prepareCallHierarchy",
			)
		) {
			client.callHierarchySupported = true;
		}
		return null;
	});
	connection.onRequest("client/unregisterCapability", (params: unknown) => {
		const unregisterations = (params as {
			unregisterations?: Array<{ method?: string }>;
		} | null)?.unregisterations;
		if (
			Array.isArray(unregisterations) &&
			unregisterations.some(
				(registration) => registration.method === "textDocument/prepareCallHierarchy",
			)
		) {
			client.callHierarchySupported = false;
		}
		return null;
	});
	connection.onRequest("workspace/workspaceFolders", () => [
		{ uri: pathToFileURL(rootPath).href, name: rootPath.split(sep).at(-1) || rootPath },
	]);
	connection.onRequest("window/workDoneProgress/create", () => null);
	connection.onRequest("workspace/applyEdit", () => ({
		applied: false,
		failureReason: "Codebase Atlas is read-only",
	}));
	connection.onRequest("window/showMessageRequest", () => null);
	connection.onNotification("window/logMessage", () => {});
	connection.onNotification("window/showMessage", () => {});
	connection.onNotification("telemetry/event", () => {});
	connection.listen();
	return client;
}

function initializeClient(
	client: ActiveClient,
	timeoutMs: number,
): Promise<void> {
	const rootUri = pathToFileURL(client.rootPath).href;
	const initialization = client.connection.sendRequest<{
		capabilities?: { callHierarchyProvider?: boolean | object };
	}>("initialize", {
		processId: process.pid,
		clientInfo: { name: "Plannotator Codebase Atlas" },
		rootPath: client.rootPath,
		rootUri,
		workspaceFolders: [
			{ uri: rootUri, name: client.rootPath.split(sep).at(-1) || client.rootPath },
		],
		capabilities: {
			workspace: {
				configuration: true,
				workspaceFolders: true,
			},
			textDocument: {
				definition: { dynamicRegistration: true, linkSupport: true },
				references: { dynamicRegistration: true },
				callHierarchy: { dynamicRegistration: true },
			},
			window: { workDoneProgress: true },
		},
	});
	return withTimeout<{
		capabilities?: { callHierarchyProvider?: boolean | object };
	}>(
		guardProcess(client, initialization),
		`${client.definition.id} initialize`,
		timeoutMs,
	).then((result) => {
		client.initialized = true;
		client.callHierarchySupported = Boolean(result?.capabilities?.callHierarchyProvider);
		client.connection.sendNotification("initialized", {});
	});
}

function locationFromLsp(
	value: LspLocation | LspLocationLink,
	rootPath: string,
): AtlasSemanticLocation | null {
	const isLink = "targetUri" in value;
	const uri = isLink ? value.targetUri : value.uri;
	const range = isLink ? value.targetSelectionRange ?? value.targetRange : value.range;
	if (!uri.startsWith("file:")) return null;

	let absolutePath: string;
	try {
		absolutePath = fileURLToPath(uri);
	} catch {
		return null;
	}
	const external = !withinRoot(absolutePath, rootPath);
	return {
		filePath: external
			? absolutePath
			: relative(rootPath, absolutePath).split(sep).join("/"),
		range: {
			start: {
				line: range.start.line + 1,
				column: range.start.character + 1,
			},
			end: {
				line: range.end.line + 1,
				column: range.end.character + 1,
			},
		},
		external,
	};
}

function normalizeLocations(
	value: LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null,
	rootPath: string,
): AtlasSemanticLocation[] {
	const values = value === null ? [] : Array.isArray(value) ? value : [value];
	const seen = new Set<string>();
	const locations: AtlasSemanticLocation[] = [];
	for (const item of values) {
		const location = locationFromLsp(item, rootPath);
		if (!location) continue;
		const key = [
			location.filePath,
			location.range.start.line,
			location.range.start.column,
			location.range.end.line,
			location.range.end.column,
		].join(":");
		if (seen.has(key)) continue;
		seen.add(key);
		locations.push(location);
	}
	return locations.sort(
		(a, b) =>
			a.filePath.localeCompare(b.filePath) ||
			a.range.start.line - b.range.start.line ||
			a.range.start.column - b.range.start.column,
	);
}

function rangeFromLsp(range: LspRange): AtlasSemanticRange {
	return {
		start: {
			line: range.start.line + 1,
			column: range.start.character + 1,
		},
		end: {
			line: range.end.line + 1,
			column: range.end.character + 1,
		},
	};
}

function callHierarchyItemFromLsp(
	item: LspCallHierarchyItem,
	rootPath: string,
): AtlasSemanticCallHierarchyItem | null {
	const location = locationFromLsp(
		{ uri: item.uri, range: item.range },
		rootPath,
	);
	if (!location) return null;
	return {
		name: item.name,
		kind: item.kind,
		...(item.detail ? { detail: item.detail } : {}),
		location,
		selectionRange: rangeFromLsp(item.selectionRange),
	};
}

function normalizeCallHierarchyCalls(
	value: Array<LspCallHierarchyIncomingCall | LspCallHierarchyOutgoingCall> | null,
	direction: "incoming" | "outgoing",
	rootPath: string,
): AtlasSemanticCallHierarchyCall[] {
	const seen = new Set<string>();
	const calls: AtlasSemanticCallHierarchyCall[] = [];
	for (const call of value ?? []) {
		const rawItem = direction === "incoming"
			? (call as LspCallHierarchyIncomingCall).from
			: (call as LspCallHierarchyOutgoingCall).to;
		const item = callHierarchyItemFromLsp(rawItem, rootPath);
		if (!item) continue;
		const fromRanges = call.fromRanges.map(rangeFromLsp);
		const key = [
			item.location.filePath,
			item.selectionRange.start.line,
			item.selectionRange.start.column,
			...fromRanges.flatMap((range) => [
				range.start.line,
				range.start.column,
				range.end.line,
				range.end.column,
			]),
		].join(":");
		if (seen.has(key)) continue;
		seen.add(key);
		calls.push({ item, fromRanges });
	}
	return calls.sort(
		(a, b) =>
			a.item.location.filePath.localeCompare(b.item.location.filePath) ||
			a.item.selectionRange.start.line - b.item.selectionRange.start.line ||
			a.item.selectionRange.start.column - b.item.selectionRange.start.column,
	);
}

async function stopClient(client: ActiveClient, timeoutMs: number): Promise<void> {
	if (client.stopping) return;
	client.stopping = true;
	try {
		if (client.initialized && client.process.exitCode === null) {
			await withTimeout(
				guardProcess(client, client.connection.sendRequest("shutdown")),
				`${client.definition.id} shutdown`,
				timeoutMs,
			).catch(() => {});
			client.connection.sendNotification("exit");
		}
	} finally {
		client.connection.dispose();
		client.process.stdin.end();
		if (!(await waitForProcessExit(client.process, Math.min(timeoutMs, 500)))) {
			client.process.kill("SIGTERM");
			if (!(await waitForProcessExit(client.process, 250))) {
				client.process.kill("SIGKILL");
			}
		}
	}
}

function waitForProcessExit(
	child: ChildProcessWithoutNullStreams,
	timeoutMs: number,
): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise((resolvePromise) => {
		let settled = false;
		const finish = (exited: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("exit", onExit);
			resolvePromise(exited);
		};
		const onExit = (): void => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
	});
}

export class AtlasSemanticSession {
	readonly #options: Required<
		Pick<
			AtlasSemanticSessionOptions,
			"initializeTimeoutMs" | "requestTimeoutMs" | "shutdownTimeoutMs"
		>
	> &
		AtlasSemanticProbeOptions;
	readonly #clients = new Map<string, Promise<ActiveClient>>();
	#disposed = false;

	constructor(options: AtlasSemanticSessionOptions = {}) {
		this.#options = {
			env: options.env ?? process.env,
			timeoutMs: positiveTimeout(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
			initializeTimeoutMs: positiveTimeout(
				options.initializeTimeoutMs,
				DEFAULT_INITIALIZE_TIMEOUT_MS,
			),
			requestTimeoutMs: positiveTimeout(
				options.requestTimeoutMs,
				DEFAULT_REQUEST_TIMEOUT_MS,
			),
			shutdownTimeoutMs: positiveTimeout(
				options.shutdownTimeoutMs,
				DEFAULT_SHUTDOWN_TIMEOUT_MS,
			),
		};
	}

	async #clientFor(
		rootPath: string,
		language: AtlasSemanticLanguage,
	): Promise<ActiveClient> {
		if (this.#disposed) throw new Error("Atlas semantic session has been disposed");
		const definition = definitionForLanguage(language);
		const key = `${rootPath}\0${definition.id}`;
		const existing = this.#clients.get(key);
		if (existing) return existing;

		const pending = (async () => {
			const capability = await probeAtlasSemanticCapability(language, this.#options);
			if (!capability.available) {
				throw new AtlasSemanticUnavailableError(capability);
			}
			const client = createActiveClient(
				key,
				definition,
				capability,
				rootPath,
				this.#options.env ?? process.env,
			);
			try {
				await initializeClient(client, this.#options.initializeTimeoutMs);
				return client;
			} catch (error) {
				await stopClient(client, this.#options.shutdownTimeoutMs);
				throw error;
			}
		})();
		this.#clients.set(key, pending);
		pending.catch(() => {
			if (this.#clients.get(key) === pending) this.#clients.delete(key);
		});
		return pending;
	}

	async warmLanguages(
		rootPath: string,
		languages: AtlasSemanticLanguage[],
	): Promise<void> {
		const normalizedRoot = realpathSync(resolve(rootPath));
		await Promise.allSettled(
			[...new Set(languages)].map((language) =>
				this.#clientFor(normalizedRoot, language),
			),
		);
	}

	async findLocations(
		rootPath: string,
		filePath: string,
		line: number,
		column: number,
		language: AtlasSemanticLanguage,
		signal?: AbortSignal,
	): Promise<AtlasSemanticLocations> {
		signal?.throwIfAborted();
		if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
			throw new Error("Atlas semantic line and column must be positive 1-based integers");
		}
		const source = resolveSourcePath(rootPath, filePath);
		const client = await this.#clientFor(source.rootPath, language);
		let result!: AtlasSemanticLocations;
		const operation = async (): Promise<void> => {
			signal?.throwIfAborted();
			const uri = pathToFileURL(source.sourcePath).href;
			client.connection.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdForPath(language, source.relativePath),
					version: 1,
					text: readFileSync(source.sourcePath, "utf8"),
				},
			});
			const cancellation = new CancellationTokenSource();
			const cancelRequest = () => cancellation.cancel();
			signal?.addEventListener("abort", cancelRequest, { once: true });
			try {
				signal?.throwIfAborted();
				const position = { line: line - 1, character: column - 1 };
				const textDocument = { uri };
				const [definitions, references] = await Promise.all([
					retryContentModified(() => {
						const request = client.connection.sendRequest<
							LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null
						>(
							"textDocument/definition",
							{ textDocument, position },
							cancellation.token,
						);
						return withTimeout(
							guardProcess(client, request),
							`${client.definition.id} definition lookup`,
							this.#options.requestTimeoutMs,
						);
					}),
					retryContentModified(() => {
						const request = client.connection.sendRequest<LspLocation[] | null>(
							"textDocument/references",
							{
								textDocument,
								position,
								context: { includeDeclaration: false },
							},
							cancellation.token,
						);
						return withTimeout(
							guardProcess(client, request),
							`${client.definition.id} reference lookup`,
							this.#options.requestTimeoutMs,
						);
					}),
				]);
				result = {
					definitions: normalizeLocations(definitions, source.rootPath),
					references: normalizeLocations(references, source.rootPath),
				};
			} finally {
				signal?.removeEventListener("abort", cancelRequest);
				cancellation.dispose();
				client.connection.sendNotification("textDocument/didClose", {
					textDocument: { uri },
				});
			}
		};

		const queued = client.queue.then(operation, operation);
		client.queue = queued.catch(() => {});
		try {
			await queued;
			return result;
		} catch (error) {
			if (signal?.aborted) throw error;
			if (!isContentModifiedError(error) && this.#clients.delete(client.key)) {
				await stopClient(client, this.#options.shutdownTimeoutMs);
			}
			throw error;
		}
	}

	async findCallHierarchy(
		rootPath: string,
		filePath: string,
		line: number,
		column: number,
		language: AtlasSemanticLanguage,
		signal?: AbortSignal,
	): Promise<AtlasSemanticCallHierarchy> {
		if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
			throw new Error("Atlas semantic line and column must be positive 1-based integers");
		}
		const source = resolveSourcePath(rootPath, filePath);
		const client = await this.#clientFor(source.rootPath, language);
		let result!: AtlasSemanticCallHierarchy;
		const operation = async (): Promise<void> => {
			signal?.throwIfAborted();
			if (!client.callHierarchySupported) {
				result = {
					supported: false,
					root: null,
					incoming: [],
					outgoing: [],
				};
				return;
			}

			const uri = pathToFileURL(source.sourcePath).href;
			client.connection.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdForPath(language, source.relativePath),
					version: 1,
					text: readFileSync(source.sourcePath, "utf8"),
				},
			});
			const cancellation = new CancellationTokenSource();
			const cancelRequest = () => cancellation.cancel();
			signal?.addEventListener("abort", cancelRequest, { once: true });
			try {
				result = await retryContentModified(async () => {
					signal?.throwIfAborted();
					const position = { line: line - 1, character: column - 1 };
					const textDocument = { uri };
					const prepared = await withTimeout(
						guardProcess(
							client,
							client.connection.sendRequest<LspCallHierarchyItem[] | null>(
								"textDocument/prepareCallHierarchy",
								{ textDocument, position },
								cancellation.token,
							),
						),
						`${client.definition.id} prepare call hierarchy`,
						this.#options.requestTimeoutMs,
					);
					const rawRoot = prepared?.[0];
					if (!rawRoot) {
						return {
							supported: true,
							root: null,
							incoming: [],
							outgoing: [],
						};
					}

					signal?.throwIfAborted();
					const [incoming, outgoing] = await withTimeout(
						guardProcess(
							client,
							Promise.all([
								client.connection.sendRequest<LspCallHierarchyIncomingCall[] | null>(
									"callHierarchy/incomingCalls",
									{ item: rawRoot },
									cancellation.token,
								),
								client.connection.sendRequest<LspCallHierarchyOutgoingCall[] | null>(
									"callHierarchy/outgoingCalls",
									{ item: rawRoot },
									cancellation.token,
								),
							]),
						),
						`${client.definition.id} call hierarchy lookup`,
						this.#options.requestTimeoutMs,
					);
					return {
						supported: true,
						root: callHierarchyItemFromLsp(rawRoot, source.rootPath),
						incoming: normalizeCallHierarchyCalls(incoming, "incoming", source.rootPath),
						outgoing: normalizeCallHierarchyCalls(outgoing, "outgoing", source.rootPath),
					};
				});
			} finally {
				signal?.removeEventListener("abort", cancelRequest);
				cancellation.dispose();
				client.connection.sendNotification("textDocument/didClose", {
					textDocument: { uri },
				});
			}
		};

		const queued = client.queue.then(operation, operation);
		client.queue = queued.catch(() => {});
		try {
			await queued;
			return result;
		} catch (error) {
			if (signal?.aborted) throw error;
			if (!isContentModifiedError(error) && this.#clients.delete(client.key)) {
				await stopClient(client, this.#options.shutdownTimeoutMs);
			}
			throw error;
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const clients = [...this.#clients.values()];
		this.#clients.clear();
		await Promise.all(
			clients.map(async (pending) => {
				try {
					await stopClient(await pending, this.#options.shutdownTimeoutMs);
				} catch {
					// A failed initialization already owns its process cleanup.
				}
			}),
		);
	}
}
