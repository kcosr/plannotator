import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	AtlasSemanticSession,
	AtlasSemanticTimeoutError,
	probeAtlasSemanticCapability,
} from "./atlas-semantic";

const temporaryDirectories: string[] = [];
const sessions = new Set<AtlasSemanticSession>();

afterEach(async () => {
	await Promise.all([...sessions].map((session) => session.dispose()));
	sessions.clear();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content, "utf8");
	chmodSync(path, 0o755);
}

function environmentWithPath(binPath: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: [binPath, process.env.PATH].filter(Boolean).join(delimiter),
	};
}

const MOCK_LSP_SOURCE = String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";

if (process.argv.includes("--version")) {
	process.stdout.write("typescript-language-server mock 1.0.0\n");
	process.exit(0);
}

let buffer = Buffer.alloc(0);
let nextServerRequest = 900;

function record(message) {
	if (process.env.MOCK_LSP_EVENTS) {
		appendFileSync(process.env.MOCK_LSP_EVENTS, JSON.stringify(message) + "\n");
	}
}

function send(message) {
	const body = Buffer.from(JSON.stringify(message));
	process.stdout.write("Content-Length: " + body.length + "\r\n\r\n");
	process.stdout.write(body);
}

function location(uri, line, character) {
	return {
		uri,
		range: {
			start: { line, character },
			end: { line, character: character + 4 },
		},
	};
}

function handle(message) {
	record(message);
	if (message.method === "initialize" && message.id !== undefined) {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				capabilities: {
					definitionProvider: true,
					referencesProvider: true,
				},
			},
		});
		return;
	}
	if (message.method === "initialized") {
		send({
			jsonrpc: "2.0",
			id: nextServerRequest++,
			method: "workspace/configuration",
			params: { items: [{ section: "typescript" }] },
		});
		send({
			jsonrpc: "2.0",
			id: nextServerRequest++,
			method: "client/registerCapability",
			params: { registrations: [] },
		});
		return;
	}
	if (message.method === "textDocument/definition" && message.id !== undefined) {
		if (process.env.MOCK_LSP_HANG_LOOKUP === "1") return;
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: [{
				targetUri: process.env.MOCK_DEFINITION_URI,
				targetRange: {
					start: { line: 0, character: 0 },
					end: { line: 2, character: 1 },
				},
				targetSelectionRange: {
					start: { line: 1, character: 7 },
					end: { line: 1, character: 13 },
				},
			}],
		});
		return;
	}
	if (message.method === "textDocument/references" && message.id !== undefined) {
		if (process.env.MOCK_LSP_HANG_LOOKUP === "1") return;
		const result = location(process.env.MOCK_REFERENCE_URI, 3, 2);
		send({ jsonrpc: "2.0", id: message.id, result: [result, result] });
		return;
	}
	if (message.method === "shutdown" && message.id !== undefined) {
		send({ jsonrpc: "2.0", id: message.id, result: null });
		return;
	}
	if (message.method === "exit") {
		process.exit(0);
	}
}

function parse() {
	while (true) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString("ascii");
		const match = header.match(/Content-Length:\s*(\d+)/i);
		if (!match) process.exit(2);
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) return;
		const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
		buffer = buffer.subarray(bodyStart + length);
		handle(JSON.parse(body));
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	parse();
});
`;

describe("Atlas semantic capability probing", () => {
	test("resolves and validates a language server from PATH", async () => {
		const bin = temporaryDirectory("atlas-semantic-bin-");
		const executable = join(bin, "typescript-language-server");
		writeExecutable(executable, MOCK_LSP_SOURCE);

		const capability = await probeAtlasSemanticCapability("typescript", {
			env: environmentWithPath(bin),
			timeoutMs: 1_000,
		});

		expect(capability).toMatchObject({
			language: "typescript",
			serverId: "typescript-language-server",
			available: true,
			command: executable,
			args: ["--stdio"],
		});
		expect(capability.version).toContain("mock 1.0.0");
	});

	test("rejects an executable rustup shim whose version command fails", async () => {
		const bin = temporaryDirectory("atlas-semantic-rust-");
		const executable = join(bin, "rust-analyzer");
		writeExecutable(
			executable,
			'#!/usr/bin/env bash\necho "error: unknown proxy name: rust-analyzer" >&2\nexit 1\n',
		);

		const capability = await probeAtlasSemanticCapability("rust", {
			env: environmentWithPath(bin),
			timeoutMs: 1_000,
		});

		expect(capability.available).toBe(false);
		expect(capability.command).toBe(executable);
		expect(capability.reason).toContain("unknown proxy name");
	});

	test("uses an explicit executable override instead of a PATH candidate", async () => {
		const bin = temporaryDirectory("atlas-semantic-override-");
		const pathExecutable = join(bin, "typescript-language-server");
		const overrideExecutable = join(bin, "custom-typescript-server");
		writeExecutable(pathExecutable, MOCK_LSP_SOURCE);
		writeExecutable(overrideExecutable, MOCK_LSP_SOURCE);
		const env = environmentWithPath(bin);
		env.PLANNOTATOR_LSP_TYPESCRIPT_LANGUAGE_SERVER = overrideExecutable;

		const capability = await probeAtlasSemanticCapability("javascript", {
			env,
			timeoutMs: 1_000,
		});

		expect(capability.available).toBe(true);
		expect(capability.command).toBe(overrideExecutable);
	});

	test("enables clangd's project background index for C and C++", async () => {
		const bin = temporaryDirectory("atlas-semantic-clangd-");
		const executable = join(bin, "clangd");
		writeExecutable(executable, MOCK_LSP_SOURCE);

		const capability = await probeAtlasSemanticCapability("cpp", {
			env: environmentWithPath(bin),
			timeoutMs: 1_000,
		});

		expect(capability).toMatchObject({
			language: "cpp",
			serverId: "clangd",
			available: true,
			command: executable,
			args: ["--background-index"],
		});
	});
});

describe("Atlas semantic session", () => {
	test("returns normalized definitions and references from an on-demand LSP", async () => {
		const bin = temporaryDirectory("atlas-semantic-session-bin-");
		const root = temporaryDirectory("atlas-semantic-repo-");
		const eventsPath = join(root, "events.ndjson");
		const executable = join(bin, "typescript-language-server");
		const sourcePath = join(root, "src", "use.tsx");
		const definitionPath = join(root, "src", "target.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(sourcePath, "import { target } from './target';\ntarget();\n");
		writeFileSync(definitionPath, "export function target() {}\n");
		writeExecutable(executable, MOCK_LSP_SOURCE);
		const env = environmentWithPath(bin);
		env.MOCK_LSP_EVENTS = eventsPath;
		env.MOCK_DEFINITION_URI = pathToFileURL(definitionPath).href;
		env.MOCK_REFERENCE_URI = pathToFileURL(sourcePath).href;

		const session = new AtlasSemanticSession({
			env,
			timeoutMs: 1_000,
			initializeTimeoutMs: 2_000,
			requestTimeoutMs: 2_000,
		});
		sessions.add(session);

		const locations = await session.findLocations(
			root,
			"src/use.tsx",
			2,
			3,
			"typescript",
		);

		expect(locations).toEqual({
			definitions: [
				{
					filePath: "src/target.ts",
					range: {
						start: { line: 2, column: 8 },
						end: { line: 2, column: 14 },
					},
					external: false,
				},
			],
			references: [
				{
					filePath: "src/use.tsx",
					range: {
						start: { line: 4, column: 3 },
						end: { line: 4, column: 7 },
					},
					external: false,
				},
			],
		});

		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (readFileSync(eventsPath, "utf8").includes("textDocument/didClose")) break;
			await Bun.sleep(10);
		}
		const messages = readFileSync(eventsPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as {
				id?: number;
				method?: string;
				params?: {
					position?: { line: number; character: number };
					textDocument?: { languageId?: string };
				};
				result?: unknown;
			});
		expect(messages).toContainEqual({ jsonrpc: "2.0", id: 900, result: [null] });
		expect(messages).toContainEqual({ jsonrpc: "2.0", id: 901, result: null });
		expect(
			messages.find((message) => message.method === "textDocument/definition")
				?.params?.position,
		).toEqual({ line: 1, character: 2 });
		expect(messages.some((message) => message.method === "textDocument/didOpen")).toBe(true);
		expect(
			messages.find((message) => message.method === "textDocument/didOpen")
				?.params?.textDocument?.languageId,
		).toBe("typescriptreact");
		expect(messages.some((message) => message.method === "textDocument/didClose")).toBe(true);
	});

	test("uses clangd for C++ files and sends the C++ language identifier", async () => {
		const bin = temporaryDirectory("atlas-semantic-cpp-bin-");
		const root = temporaryDirectory("atlas-semantic-cpp-repo-");
		const eventsPath = join(root, "events.ndjson");
		const executable = join(bin, "clangd");
		const sourcePath = join(root, "src", "use.cpp");
		const definitionPath = join(root, "include", "target.hpp");
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(root, "include"), { recursive: true });
		writeFileSync(sourcePath, '#include "target.hpp"\nint value = target();\n');
		writeFileSync(definitionPath, "int target();\n");
		writeExecutable(executable, MOCK_LSP_SOURCE);
		const env = environmentWithPath(bin);
		env.MOCK_LSP_EVENTS = eventsPath;
		env.MOCK_DEFINITION_URI = pathToFileURL(definitionPath).href;
		env.MOCK_REFERENCE_URI = pathToFileURL(sourcePath).href;

		const session = new AtlasSemanticSession({
			env,
			timeoutMs: 1_000,
			initializeTimeoutMs: 2_000,
			requestTimeoutMs: 2_000,
		});
		sessions.add(session);

		await session.findLocations(root, "src/use.cpp", 2, 13, "cpp");

		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (readFileSync(eventsPath, "utf8").includes("textDocument/didClose")) break;
			await Bun.sleep(10);
		}
		const messages = readFileSync(eventsPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as {
				method?: string;
				params?: { textDocument?: { languageId?: string } };
			});
		expect(
			messages.find((message) => message.method === "textDocument/didOpen")
				?.params?.textDocument?.languageId,
		).toBe("cpp");
	});

	test("times out a language server that does not answer location requests", async () => {
		const bin = temporaryDirectory("atlas-semantic-timeout-bin-");
		const root = temporaryDirectory("atlas-semantic-timeout-repo-");
		const executable = join(bin, "typescript-language-server");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "use.ts"), "const value = 1;\n");
		writeExecutable(executable, MOCK_LSP_SOURCE);
		const env = environmentWithPath(bin);
		env.MOCK_LSP_HANG_LOOKUP = "1";

		const session = new AtlasSemanticSession({
			env,
			timeoutMs: 1_000,
			initializeTimeoutMs: 2_000,
			requestTimeoutMs: 50,
		});
		sessions.add(session);

		await expect(
			session.findLocations(root, "src/use.ts", 1, 1, "typescript"),
		).rejects.toBeInstanceOf(AtlasSemanticTimeoutError);
	});
});
