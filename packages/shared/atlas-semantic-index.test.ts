import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasSnapshot } from "./atlas";
import {
	AtlasSemanticIndexService,
	AtlasSemanticRepositoryChangedError,
	type AtlasSemanticIndexProgress,
} from "./atlas-semantic-index";
import {
	AtlasRepositoryFingerprintCache,
	collectAtlasRepositoryFingerprint,
} from "./atlas-repository-fingerprint";
import type {
	AtlasSemanticCallHierarchy,
	AtlasSemanticCapability,
	AtlasSemanticLanguage,
	AtlasSemanticLocations,
	AtlasSemanticSession,
} from "./atlas-semantic";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixture(): {
	rootPath: string;
	indexPath: string;
	snapshot: AtlasSnapshot;
	verifyRepositoryFingerprint: () => Promise<void>;
} {
	const rootPath = mkdtempSync(join(tmpdir(), "atlas-semantic-index-"));
	directories.push(rootPath);
	mkdirSync(join(rootPath, "src"));
	writeFileSync(
		join(rootPath, "src", "main.ts"),
		[
			"export function run() {",
			"  return helper();",
			"}",
			"export const value = 1;",
			"",
		].join("\n"),
	);
	const snapshot: AtlasSnapshot = {
		version: 3,
		rootName: "fixture",
		rootId: "root",
		generatedAt: "2026-07-26T12:00:00.000Z",
		nodes: [{
			id: "file:src/main.ts",
			path: "src/main.ts",
			name: "main.ts",
			parentId: "root",
			childIds: [],
			kind: "file",
			depth: 1,
			language: "typescript",
			extension: ".ts",
			bytes: 80,
			lines: 5,
			complexity: 1,
			testBytes: 0,
			testLines: 0,
			testComplexity: 0,
			testRanges: [],
			symbols: [{
				id: "file:src/main.ts#function:run:1",
				fileId: "file:src/main.ts",
				name: "run",
				kind: "function",
				line: 1,
				column: 17,
				endLine: 3,
				exported: true,
				complexity: 1,
				isTest: false,
			}, {
				id: "file:src/main.ts#variable:value:4",
				fileId: "file:src/main.ts",
				name: "value",
				kind: "variable",
				line: 4,
				column: 14,
				endLine: 4,
				exported: true,
				complexity: 0,
				isTest: false,
			}],
		}],
		dependencies: [],
		summary: {
			files: 1,
			directories: 0,
			bytes: 80,
			lines: 5,
			complexity: 1,
			symbols: 2,
			dependencies: 0,
			internalDependencies: 0,
			languages: {
				typescript: { files: 1, lines: 5, bytes: 80 },
			},
			skippedFiles: 0,
			truncated: false,
		},
		analyzers: {
			structural: {
				name: "ast-grep",
				version: "0.45.0",
				source: "path",
				languages: ["typescript"],
			},
			semantic: {
				protocol: "lsp",
				// A cached structural snapshot must not decide current LSP availability.
				providers: [{
					language: "typescript",
					name: "typescript-language-server",
					available: false,
					reason: "not installed when the snapshot was built",
				}],
			},
		},
	};
	return {
		rootPath,
		indexPath: join(rootPath, ".plannotator", "atlas.sqlite3"),
		snapshot,
		verifyRepositoryFingerprint: async () => {},
	};
}

function capabilities(
	version = "typescript-language-server 4.3.4",
): Record<AtlasSemanticLanguage, AtlasSemanticCapability> {
	const languages: AtlasSemanticLanguage[] = [
		"rust",
		"typescript",
		"javascript",
		"python",
		"go",
		"c",
		"cpp",
		"java",
		"ruby",
	];
	return Object.fromEntries(languages.map((language) => [
		language,
		{
			language,
			serverId: language === "javascript" || language === "typescript"
				? "typescript-language-server"
				: language === "rust"
					? "rust-analyzer"
					: language === "python"
						? "pyright-langserver"
						: language === "go"
							? "gopls"
							: language === "c" || language === "cpp"
								? "clangd"
								: language === "java"
									? "jdtls"
									: "solargraph",
			available: language === "typescript",
			envVariable: `TEST_${language.toUpperCase()}`,
			...(language === "typescript" && {
				args: ["--stdio"],
				version,
				command: "/not-persisted/typescript-language-server",
			}),
			...(language !== "typescript" && { reason: "not configured" }),
		},
	])) as Record<AtlasSemanticLanguage, AtlasSemanticCapability>;
}

function addIndexedTypeScriptFile(
	data: ReturnType<typeof fixture>,
	filePath: string,
	content: string,
): void {
	const source = data.snapshot.nodes[0]!;
	writeFileSync(join(data.rootPath, ...filePath.split("/")), content);
	data.snapshot.nodes.push({
		...source,
		id: `file:${filePath}`,
		path: filePath,
		name: filePath.split("/").at(-1)!,
		bytes: Buffer.byteLength(content),
		lines: content.split(/\r?\n/).length,
		symbols: [],
	});
}

class FakeSession {
	locationCalls = 0;
	callHierarchyCalls = 0;
	locationError: Error | null = null;
	onFindLocations: (() => void | Promise<void>) | null = null;
	locations: AtlasSemanticLocations = {
		definitions: [{
			filePath: "src/main.ts",
			range: {
				start: { line: 1, column: 17 },
				end: { line: 1, column: 20 },
			},
			external: false,
		}],
		references: [{
			filePath: "src/main.ts",
			range: {
				start: { line: 2, column: 10 },
				end: { line: 2, column: 13 },
			},
			external: false,
		}],
	};
	hierarchy: AtlasSemanticCallHierarchy = {
		supported: true,
		root: {
			name: "run",
			kind: 12,
			location: {
				filePath: "src/main.ts",
				range: {
					start: { line: 1, column: 1 },
					end: { line: 3, column: 2 },
				},
				external: false,
			},
			selectionRange: {
				start: { line: 1, column: 17 },
				end: { line: 1, column: 20 },
			},
		},
		incoming: [],
		outgoing: [],
	};

	async findLocations(): Promise<AtlasSemanticLocations> {
		this.locationCalls += 1;
		await this.onFindLocations?.();
		if (this.locationError) throw this.locationError;
		return this.locations;
	}

	async findCallHierarchy(): Promise<AtlasSemanticCallHierarchy> {
		this.callHierarchyCalls += 1;
		return this.hierarchy;
	}
}

function asSession(session: FakeSession): AtlasSemanticSession {
	return session as unknown as AtlasSemanticSession;
}

describe("AtlasSemanticIndexService", () => {
	test("reopens complete references from SQLite without another LSP request", async () => {
		const data = fixture();
		const firstSession = new FakeSession();
		const first = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(firstSession),
			capabilities: capabilities(),
		});
		const input = {
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:repository-a",
			symbol: "run",
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		};
		const live = await first.resolveReferences(input);
		expect(live.source).toBe("live");
		expect(live.response.references).toHaveLength(1);
		expect(firstSession.locationCalls).toBe(1);
		await first.dispose();

		const secondSession = new FakeSession();
		secondSession.locationError = new Error("must not be called");
		const second = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(secondSession),
			capabilities: capabilities(),
		});
		const cached = await second.resolveReferences(input);
		expect(cached.source).toBe("cache");
		expect(cached.response).toEqual(live.response);
		expect(secondSession.locationCalls).toBe(0);
		await second.dispose();
	});

	test("rejects cached results after another repository file changes", async () => {
		const data = fixture();
		writeFileSync(join(data.rootPath, "src", "dependency.ts"), "export const value = 1;\n");
		const initialFingerprint = (
			await collectAtlasRepositoryFingerprint(data.rootPath, {
				excludedPaths: [data.indexPath],
			})
		).fingerprint;
		const fingerprintCache = new AtlasRepositoryFingerprintCache();
		const session = new FakeSession();
		const service = await AtlasSemanticIndexService.open({
			rootPath: data.rootPath,
			indexPath: data.indexPath,
			session: asSession(session),
			capabilities: capabilities(),
			verifyRepositoryFingerprint: async (expectedFingerprint, signal) => {
				const current = await collectAtlasRepositoryFingerprint(data.rootPath, {
					excludedPaths: [data.indexPath],
					contentCache: fingerprintCache,
					signal,
				});
				if (current.fingerprint !== expectedFingerprint) {
					throw new AtlasSemanticRepositoryChangedError();
				}
			},
		});
		const input = {
			snapshot: data.snapshot,
			repositoryFingerprint: initialFingerprint,
			symbol: "run",
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		};

		expect((await service.resolveReferences(input)).source).toBe("live");
		writeFileSync(join(data.rootPath, "src", "dependency.ts"), "export const value = 2;\n");
		await expect(service.resolveReferences(input)).rejects.toThrow(
			"Repository changed during semantic lookup",
		);

		const changedFingerprint = (
			await collectAtlasRepositoryFingerprint(data.rootPath, {
				excludedPaths: [data.indexPath],
			})
		).fingerprint;
		expect((await service.resolveReferences({
			...input,
			repositoryFingerprint: changedFingerprint,
		})).source).toBe("live");
		expect(session.locationCalls).toBe(2);
		await service.dispose();
	});

	test("reuses declaration reference results from indexed use-site coordinates", async () => {
		const data = fixture();
		addIndexedTypeScriptFile(
			data,
			"src/dependency.ts",
			"export function caller() {\n  return run();\n}\n",
		);
		const session = new FakeSession();
		session.locations = {
			...session.locations,
			references: [{
				filePath: "src/dependency.ts",
				range: {
					start: { line: 2, column: 10 },
					end: { line: 2, column: 13 },
				},
				external: false,
			}],
		};
		const service = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(session),
			capabilities: capabilities(),
		});
		const generation = {
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:reference-alias",
			symbol: "run",
		};
		expect((await service.resolveReferences({
			...generation,
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		})).source).toBe("live");
		expect((await service.resolveReferences({
			...generation,
			filePath: "src/dependency.ts",
			line: 2,
			column: 10,
		})).source).toBe("cache");
		expect(session.locationCalls).toBe(1);
		await service.dispose();
	});

	test("reuses indexed call hierarchy from a returned call-site coordinate", async () => {
		const data = fixture();
		addIndexedTypeScriptFile(
			data,
			"src/dependency.ts",
			"export function caller() {\n  return run();\n}\n",
		);
		const session = new FakeSession();
		session.hierarchy = {
			...session.hierarchy,
			incoming: [{
				item: {
					name: "caller",
					kind: 12,
					location: {
						filePath: "src/dependency.ts",
						range: {
							start: { line: 1, column: 1 },
							end: { line: 3, column: 2 },
						},
						external: false,
					},
					selectionRange: {
						start: { line: 1, column: 17 },
						end: { line: 1, column: 20 },
					},
				},
				fromRanges: [{
					start: { line: 2, column: 10 },
					end: { line: 2, column: 13 },
				}],
			}],
		};
		const service = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(session),
			capabilities: capabilities(),
		});
		const generation = {
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:call-alias",
		};
		const live = await service.resolveCalls({
			...generation,
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		});
		expect(live.source).toBe("live");
		expect(live.response.callers[0]?.callSites).toEqual([expect.objectContaining({
			filePath: "src/dependency.ts",
			line: 2,
			column: 10,
		})]);
		expect((await service.resolveCalls({
			...generation,
			filePath: "src/dependency.ts",
			line: 2,
			column: 10,
		})).source).toBe("cache");
		expect(session.callHierarchyCalls).toBe(1);
		await service.dispose();
	});

	test("persists valid empty results", async () => {
		const data = fixture();
		const session = new FakeSession();
		session.locations = { definitions: [], references: [] };
		const service = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(session),
			capabilities: capabilities(),
		});
		const input = {
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:empty",
			symbol: "missing",
			filePath: "src/main.ts",
			line: 2,
			column: 3,
		};
		expect((await service.resolveReferences(input)).response).toMatchObject({
			definitions: [],
			references: [],
		});
		expect((await service.resolveReferences(input)).source).toBe("cache");
		expect(session.locationCalls).toBe(1);
		await service.dispose();
	});

	test("persists provider-level unsupported call hierarchy", async () => {
		const data = fixture();
		const session = new FakeSession();
		session.hierarchy = {
			supported: false,
			root: null,
			incoming: [],
			outgoing: [],
		};
		const service = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(session),
			capabilities: capabilities(),
		});
		const input = {
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:unsupported",
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		};
		const live = await service.resolveCalls(input);
		expect(live.cacheability).toBe("unsupported");
		expect(live.response.provider.status).toBe("unsupported");
		const cached = await service.resolveCalls(input);
		expect(cached.source).toBe("cache");
		expect(cached.response.provider.status).toBe("unsupported");
		expect(session.callHierarchyCalls).toBe(1);
		await service.dispose();
	});

	test("does not persist transient semantic failures", async () => {
		const data = fixture();
		const session = new FakeSession();
		session.locationError = new Error("content modified");
		const service = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(session),
			capabilities: capabilities(),
		});
		const input = {
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:transient",
			symbol: "run",
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		};
		expect((await service.resolveReferences(input)).cacheability).toBe("transient");
		expect((await service.resolveReferences(input)).source).toBe("live");
		expect(session.locationCalls).toBe(2);
		await service.dispose();
	});

	test("does not serve or persist results when source changes during lookup", async () => {
		const data = fixture();
		const session = new FakeSession();
		session.onFindLocations = () => {
			writeFileSync(
				join(data.rootPath, "src", "main.ts"),
				[
					"export function run() {",
					"  return changed();",
					"}",
					"export const value = 2;",
					"",
				].join("\n"),
			);
			session.onFindLocations = null;
		};
		const service = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(session),
			capabilities: capabilities(),
		});
		const input = {
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:changing-source",
			symbol: "run",
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		};

		await expect(service.resolveReferences(input)).rejects.toThrow(
			"Atlas source changed during semantic lookup",
		);
		expect((await service.resolveReferences(input)).source).toBe("live");
		expect(session.locationCalls).toBe(2);
		await service.dispose();
	});

	test("does not persist a cancelled reference request", async () => {
		const data = fixture();
		const session = new FakeSession();
		const service = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(session),
			capabilities: capabilities(),
		});
		const input = {
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:cancelled",
			symbol: "run",
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		};
		const cancellation = new AbortController();
		cancellation.abort(new Error("cancelled"));
		await expect(
			service.resolveReferences({ ...input, signal: cancellation.signal }),
		).rejects.toThrow("cancelled");
		expect(session.locationCalls).toBe(0);
		expect((await service.resolveReferences(input)).source).toBe("live");
		expect(session.locationCalls).toBe(1);
		await service.dispose();
	});

	test("invalidates by repository fingerprint and live provider version", async () => {
		const data = fixture();
		const session = new FakeSession();
		const first = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(session),
			capabilities: capabilities("v1"),
		});
		const base = {
			snapshot: data.snapshot,
			symbol: "run",
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		};
		await first.resolveReferences({
			...base,
			repositoryFingerprint: "sha256:first",
		});
		await first.resolveReferences({
			...base,
			repositoryFingerprint: "sha256:second",
		});
		expect(session.locationCalls).toBe(2);
		await first.dispose();

		const upgradedSession = new FakeSession();
		const upgraded = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(upgradedSession),
			capabilities: capabilities("v2"),
		});
		expect((await upgraded.resolveReferences({
			...base,
			repositoryFingerprint: "sha256:first",
		})).source).toBe("live");
		expect(upgradedSession.locationCalls).toBe(1);
		await upgraded.dispose();
	});

	test("resumes indexAll from persisted successful work", async () => {
		const data = fixture();
		const firstSession = new FakeSession();
		firstSession.locationError = new Error("temporary failure");
		const first = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(firstSession),
			capabilities: capabilities(),
		});
		const firstProgress = await first.indexAll({
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:resume",
		});
		expect(firstProgress).toMatchObject({
			total: 3,
			completed: 3,
			resolved: 1,
			failed: 2,
		});
		await first.dispose();

		const progressEvents: AtlasSemanticIndexProgress[] = [];
		const secondSession = new FakeSession();
		const second = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(secondSession),
			capabilities: capabilities(),
		});
		const resumed = await second.indexAll({
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:resume",
			onProgress: (progress) => progressEvents.push(progress),
		});
		expect(resumed).toMatchObject({
			total: 3,
			completed: 3,
			cached: 1,
			resolved: 2,
			failed: 0,
		});
		expect(secondSession.locationCalls).toBe(2);
		expect(secondSession.callHierarchyCalls).toBe(0);
		expect(progressEvents.at(-1)?.current).toBeUndefined();
		await second.dispose();
	});

	test("verifies the repository only before and after an indexAll sweep", async () => {
		const data = fixture();
		const session = new FakeSession();
		let verificationCalls = 0;
		const service = await AtlasSemanticIndexService.open({
			...data,
			verifyRepositoryFingerprint: async () => {
				verificationCalls += 1;
			},
			session: asSession(session),
			capabilities: capabilities(),
		});

		await service.indexAll({
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:sweep",
		});
		expect(verificationCalls).toBe(2);
		await service.dispose();
	});

	test("removes a semantic generation when the repository changes during indexAll", async () => {
		const data = fixture();
		const session = new FakeSession();
		let verificationCalls = 0;
		const service = await AtlasSemanticIndexService.open({
			...data,
			verifyRepositoryFingerprint: async () => {
				verificationCalls += 1;
				if (verificationCalls === 2) {
					throw new AtlasSemanticRepositoryChangedError();
				}
			},
			session: asSession(session),
			capabilities: capabilities(),
		});

		await expect(service.indexAll({
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:unstable-sweep",
		})).rejects.toThrow("Repository changed during semantic lookup");
		await service.dispose();

		const database = new Database(data.indexPath, { readonly: true });
		const row = database.query(
			"SELECT COUNT(*) AS count FROM atlas_semantic_queries",
		).get() as { count: number };
		expect(row.count).toBe(0);
		database.close();
	});

	test("stores repository-relative paths and never stores the absolute root", async () => {
		const data = fixture();
		const session = new FakeSession();
		const service = await AtlasSemanticIndexService.open({
			...data,
			session: asSession(session),
			capabilities: capabilities(),
		});
		await service.resolveReferences({
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:portable",
			symbol: "run",
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		});
		await service.resolveCalls({
			snapshot: data.snapshot,
			repositoryFingerprint: "sha256:portable",
			filePath: "src/main.ts",
			line: 1,
			column: 17,
		});
		await service.dispose();

		const database = new Database(data.indexPath, { readonly: true });
		const queryPaths = database.query(
			"SELECT file_path FROM atlas_semantic_queries",
		).all() as Array<{ file_path: string }>;
		const referencePaths = database.query(
			"SELECT file_path FROM atlas_semantic_references",
		).all() as Array<{ file_path: string }>;
		const targetPaths = database.query(
			"SELECT file_path FROM atlas_semantic_call_targets",
		).all() as Array<{ file_path: string }>;
		expect([...queryPaths, ...referencePaths, ...targetPaths]).not.toHaveLength(0);
		for (const row of [...queryPaths, ...referencePaths, ...targetPaths]) {
			expect(row.file_path).toBe("src/main.ts");
			expect(row.file_path).not.toContain(data.rootPath);
		}
		const serialized = database.serialize().toString("utf8");
		expect(serialized).not.toContain(data.rootPath);
		database.close();
	});
});
