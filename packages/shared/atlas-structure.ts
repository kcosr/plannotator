import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join } from "node:path";
import { getPlannotatorDataDir } from "./data-dir";

export const ATLAS_AST_GREP_VERSION = "0.45.0";

const VERSION_TIMEOUT_MS = 3_000;
const OUTLINE_TIMEOUT_MS = 120_000;
const MAX_OUTLINE_OUTPUT_BYTES = 128 * 1024 * 1024;
const OUTLINE_BATCH_SIZE = 250;

export interface AtlasStructuralAnalyzer {
	name: "ast-grep";
	version: string;
	source: "env" | "managed" | "package" | "path";
	languages: string[];
}

export interface StructuralRange {
	start: { line: number; column: number };
	end: { line: number; column: number };
}

export interface StructuralMember {
	role: "member";
	symbolType: string;
	name: string;
	range: StructuralRange;
	signature: string;
	astKind: string;
	isPublic?: boolean;
}

export interface StructuralItem {
	role: "item";
	symbolType: string;
	name: string;
	range: StructuralRange;
	signature: string;
	astKind: string;
	isImport: boolean;
	isExported: boolean;
	members?: StructuralMember[];
}

export interface StructuralFileOutline {
	path: string;
	language: string;
	items: StructuralItem[];
}

export interface AtlasStructureResult {
	analyzer: AtlasStructuralAnalyzer;
	files: Map<string, StructuralFileOutline>;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	error?: string;
	timedOut?: boolean;
}

interface AstGrepCandidate {
	command: string;
	source: AtlasStructuralAnalyzer["source"];
	explicit: boolean;
}

export interface AtlasStructureRuntime {
	runCommand: (
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number },
	) => Promise<CommandResult>;
	fileExists: (path: string) => boolean;
	env: Record<string, string | undefined>;
	dataDir: string;
	moduleDir: string;
	pathDelimiter: string;
	platform: NodeJS.Platform;
}

function defaultRunCommand(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let proc: ReturnType<typeof spawn>;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let outputBytes = 0;

		const finish = (result: CommandResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolveResult(result);
		};

		try {
			proc = spawn(command, args, {
				cwd: options.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({
				stdout: "",
				stderr: "",
				exitCode: 1,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		const collect = (chunks: Buffer[], chunk: Buffer): void => {
			if (settled) return;
			outputBytes += chunk.length;
			if (outputBytes > (options.maxOutputBytes ?? MAX_OUTLINE_OUTPUT_BYTES)) {
				try {
					proc.kill();
				} catch {
					// The close/error event will settle if the process already exited.
				}
				finish({
					stdout: Buffer.concat(stdoutChunks).toString("utf8"),
					stderr: Buffer.concat(stderrChunks).toString("utf8"),
					exitCode: 1,
					error: "ast-grep output exceeded the Atlas limit",
				});
				return;
			}
			chunks.push(chunk);
		};

		proc.stdout?.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
		proc.stderr?.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));
		proc.on("error", (error) => {
			finish({
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				exitCode: 1,
				error: error.message,
			});
		});
		proc.on("close", (code) => {
			finish({
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				exitCode: code ?? 1,
			});
		});

		if (options.timeoutMs) {
			timer = setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// The close/error event will settle if the process already exited.
				}
				finish({
					stdout: Buffer.concat(stdoutChunks).toString("utf8"),
					stderr: Buffer.concat(stderrChunks).toString("utf8"),
					exitCode: 1,
					error: `ast-grep timed out after ${options.timeoutMs}ms`,
					timedOut: true,
				});
			}, options.timeoutMs);
		}
	});
}

export function createDefaultAtlasStructureRuntime(): AtlasStructureRuntime {
	return {
		runCommand: defaultRunCommand,
		fileExists: existsSync,
		env: process.env,
		dataDir: getPlannotatorDataDir(),
		moduleDir: dirname(fileURLToPath(import.meta.url)),
		pathDelimiter: delimiter,
		platform: process.platform,
	};
}

function binaryName(platform: NodeJS.Platform): string {
	return platform === "win32" ? "ast-grep.exe" : "ast-grep";
}

export function getManagedAstGrepBinaryPath(
	dataDir = getPlannotatorDataDir(),
	platform: NodeJS.Platform = process.platform,
): string {
	return join(dataDir, "vendor", "ast-grep", ATLAS_AST_GREP_VERSION, binaryName(platform));
}

function pathCandidates(runtime: AtlasStructureRuntime): AstGrepCandidate[] {
	const executable = binaryName(runtime.platform);
	if (runtime.platform === "win32") {
		for (const directory of (runtime.env.PATH ?? "").split(runtime.pathDelimiter)) {
			if (!directory) continue;
			const candidate = join(directory, executable);
			if (runtime.fileExists(candidate)) {
				return [{ command: candidate, source: "path", explicit: false }];
			}
		}
		return [];
	}
	return [{ command: executable, source: "path", explicit: false }];
}

function astGrepCandidates(runtime: AtlasStructureRuntime): AstGrepCandidate[] {
	const explicit = runtime.env.PLANNOTATOR_AST_GREP_PATH?.trim();
	if (explicit) return [{ command: explicit, source: "env", explicit: true }];

	const candidates: AstGrepCandidate[] = [];
	const managed = getManagedAstGrepBinaryPath(runtime.dataDir, runtime.platform);
	if (runtime.fileExists(managed)) {
		candidates.push({ command: managed, source: "managed", explicit: false });
	}

	const executable = binaryName(runtime.platform);
	for (const packagePath of [
		join(runtime.moduleDir, "..", "..", "node_modules", ".bin", executable),
		join(runtime.moduleDir, "..", "node_modules", ".bin", executable),
	]) {
		if (runtime.fileExists(packagePath)) {
			candidates.push({ command: packagePath, source: "package", explicit: false });
		}
	}
	candidates.push(...pathCandidates(runtime));
	return candidates;
}

export function parseAstGrepVersion(stdout: string): string | null {
	return stdout.trim().match(/^ast-grep\s+(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/)?.[1] ?? null;
}

function supportsOutline(version: string): boolean {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major > 0 || minor >= 44;
}

async function resolveAstGrep(
	runtime: AtlasStructureRuntime,
): Promise<{ command: string; analyzer: Omit<AtlasStructuralAnalyzer, "languages"> }> {
	for (const candidate of astGrepCandidates(runtime)) {
		if (candidate.explicit && !runtime.fileExists(candidate.command)) {
			throw new Error(
				`PLANNOTATOR_AST_GREP_PATH points to a missing file: ${candidate.command}`,
			);
		}
		const versionResult = await runtime.runCommand(candidate.command, ["--version"], {
			timeoutMs: VERSION_TIMEOUT_MS,
			maxOutputBytes: 16 * 1024,
		});
		const version = parseAstGrepVersion(versionResult.stdout);
		if (versionResult.exitCode === 0 && version && supportsOutline(version)) {
			return {
				command: candidate.command,
				analyzer: { name: "ast-grep", version, source: candidate.source },
			};
		}
		if (candidate.explicit) {
			throw new Error(
				"PLANNOTATOR_AST_GREP_PATH must point to ast-grep 0.44.0 or newer",
			);
		}
	}
	throw new Error(
		"Atlas requires ast-grep 0.44.0 or newer. Reinstall Plannotator or set PLANNOTATOR_AST_GREP_PATH.",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPosition(value: unknown): value is { line: number; column: number } {
	return isRecord(value) &&
		typeof value.line === "number" &&
		Number.isInteger(value.line) &&
		value.line >= 0 &&
		typeof value.column === "number" &&
		Number.isInteger(value.column) &&
		value.column >= 0;
}

function isRange(value: unknown): value is StructuralRange {
	return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function parseMember(value: unknown): StructuralMember | null {
	if (
		!isRecord(value) ||
		value.role !== "member" ||
		typeof value.symbolType !== "string" ||
		typeof value.name !== "string" ||
		!isRange(value.range) ||
		typeof value.signature !== "string" ||
		typeof value.astKind !== "string"
	) return null;
	return {
		role: "member",
		symbolType: value.symbolType,
		name: value.name,
		range: value.range,
		signature: value.signature,
		astKind: value.astKind,
		...(typeof value.isPublic === "boolean" && { isPublic: value.isPublic }),
	};
}

function parseItem(value: unknown): StructuralItem | null {
	if (
		!isRecord(value) ||
		value.role !== "item" ||
		typeof value.symbolType !== "string" ||
		typeof value.name !== "string" ||
		!isRange(value.range) ||
		typeof value.signature !== "string" ||
		typeof value.astKind !== "string" ||
		typeof value.isImport !== "boolean" ||
		typeof value.isExported !== "boolean"
	) return null;
	const parsedMembers = Array.isArray(value.members)
		? value.members.map(parseMember)
		: undefined;
	if (parsedMembers?.some((member) => member === null)) return null;
	const members = parsedMembers as StructuralMember[] | undefined;
	return {
		role: "item",
		symbolType: value.symbolType,
		name: value.name,
		range: value.range,
		signature: value.signature,
		astKind: value.astKind,
		isImport: value.isImport,
		isExported: value.isExported,
		...(members && { members }),
	};
}

export function parseOutlineStream(stdout: string): StructuralFileOutline[] {
	const files: StructuralFileOutline[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error("ast-grep returned malformed outline JSON");
		}
		if (
			!isRecord(value) ||
			typeof value.path !== "string" ||
			typeof value.language !== "string" ||
			!Array.isArray(value.items)
		) {
			throw new Error("ast-grep returned an unsupported outline schema");
		}
		const parsedItems = value.items.map(parseItem);
		if (parsedItems.some((item) => item === null)) {
			throw new Error("ast-grep returned an unsupported outline schema");
		}
		files.push({
			path: value.path.replace(/\\/g, "/").replace(/^\.\//, ""),
			language: value.language,
			items: parsedItems as StructuralItem[],
		});
	}
	return files;
}

export async function analyzeAtlasStructure(
	rootPath: string,
	filePaths: string[],
	runtime: AtlasStructureRuntime = createDefaultAtlasStructureRuntime(),
): Promise<AtlasStructureResult> {
	const resolved = await resolveAstGrep(runtime);
	const files = new Map<string, StructuralFileOutline>();

	for (let offset = 0; offset < filePaths.length; offset += OUTLINE_BATCH_SIZE) {
		const batch = filePaths.slice(offset, offset + OUTLINE_BATCH_SIZE);
		const result = await runtime.runCommand(
			resolved.command,
			[
				"outline",
				"--items",
				"all",
				"--view",
				"expanded",
				"--json=stream",
				"--",
				...batch,
			],
			{
				cwd: rootPath,
				timeoutMs: OUTLINE_TIMEOUT_MS,
				maxOutputBytes: MAX_OUTLINE_OUTPUT_BYTES,
			},
		);
		if (result.exitCode !== 0) {
			const detail = result.error ?? (result.stderr.trim() || `exit code ${result.exitCode}`);
			throw new Error(`ast-grep could not build the repository outline: ${detail}`);
		}
		for (const outline of parseOutlineStream(result.stdout)) {
			files.set(outline.path, outline);
		}
	}

	const languages = [...new Set([...files.values()].map((file) => file.language))].sort();
	return {
		analyzer: { ...resolved.analyzer, languages },
		files,
	};
}
