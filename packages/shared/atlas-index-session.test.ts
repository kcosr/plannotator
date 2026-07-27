import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ATLAS_SNAPSHOT_VERSION,
	type AtlasSnapshot,
} from "./atlas";
import {
	AtlasIndexSession,
	isAtlasSnapshot,
} from "./atlas-index-session";
import { openAtlasSnapshotCache } from "./atlas-snapshot-cache";

const temporaryDirectories: string[] = [];
const sessions: AtlasIndexSession[] = [];

function temporaryRepository(): { root: string; databasePath: string } {
	const directory = mkdtempSync(join(tmpdir(), "plannotator-atlas-session-"));
	temporaryDirectories.push(directory);
	const root = join(directory, "repository");
	mkdirSync(root);
	return { root, databasePath: join(directory, "cache.sqlite3") };
}

function snapshot(_rootPath: string, generatedAt: string): AtlasSnapshot {
	return {
		version: ATLAS_SNAPSHOT_VERSION,
		rootName: "repository",
		rootId: "root",
		generatedAt,
		nodes: [],
		dependencies: [],
		summary: {
			files: 0,
			directories: 0,
			bytes: 0,
			lines: 0,
			complexity: 0,
			symbols: 0,
			dependencies: 0,
			internalDependencies: 0,
			languages: {},
			skippedFiles: 0,
			truncated: false,
		},
		analyzers: {
			structural: {
				name: "ast-grep",
				version: "0.45.0",
				source: "path",
				languages: [],
			},
			semantic: { protocol: "lsp", providers: [] },
		},
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (reason: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function seedCache(
	root: string,
	databasePath: string,
	fingerprint: string,
	value: AtlasSnapshot,
): Promise<void> {
	const cache = await openAtlasSnapshotCache({ rootPath: root, indexPath: databasePath });
	expect(cache.set({
		repositoryFingerprint: fingerprint,
		snapshotVersion: ATLAS_SNAPSHOT_VERSION,
	}, value)).toBe(true);
	cache.close();
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("AtlasIndexSession", () => {
	test("hydrates a matching cached snapshot after verifying its fingerprint", async () => {
		const { root, databasePath } = temporaryRepository();
		const cached = snapshot(root, "2026-07-26T10:00:00.000Z");
		cached.rootName = "different-checkout-name";
		await seedCache(root, databasePath, "fingerprint-a", cached);
		let builds = 0;
		const session = await AtlasIndexSession.open({
			rootPath: root,
			cacheOptions: { indexPath: databasePath },
			collectFingerprint: async () => "fingerprint-a",
			buildSnapshot: async () => {
				builds += 1;
				return snapshot(root, "2026-07-26T11:00:00.000Z");
			},
		});
		sessions.push(session);

		expect(session.getSnapshot()).toBeUndefined();
		expect(session.getSnapshotGeneration()).toBeUndefined();
		expect(session.getStatus()).toEqual({
			status: "indexing",
			phase: "checking",
			hasSnapshot: false,
			revision: 0,
			refreshing: false,
			persistent: true,
		});
		session.start();
		expect(session.getStatus().refreshing).toBe(true);
		await session.waitUntilIdle();
		expect(builds).toBe(0);
		expect(session.getSnapshot()).toEqual({
			...cached,
			rootName: "repository",
		});
		expect(session.getSnapshotGeneration()).toEqual({
			snapshot: {
				...cached,
				rootName: "repository",
			},
			repositoryFingerprint: "fingerprint-a",
		});
		expect(session.getStatus()).toEqual({
			status: "ready",
			phase: "ready",
			hasSnapshot: true,
			revision: 1,
			source: "cache",
			refreshing: false,
			persistent: true,
		});
	});

	test("atomically replaces a stale cached snapshot and persists the fresh one", async () => {
		const { root, databasePath } = temporaryRepository();
		const cached = snapshot(root, "2026-07-26T10:00:00.000Z");
		const fresh = snapshot(root, "2026-07-26T11:00:00.000Z");
		await seedCache(root, databasePath, "fingerprint-old", cached);
		const buildStarted = deferred<void>();
		const releaseBuild = deferred<void>();
		const session = await AtlasIndexSession.open({
			rootPath: root,
			cacheOptions: { indexPath: databasePath },
			collectFingerprint: async () => "fingerprint-new",
			buildSnapshot: async () => {
				buildStarted.resolve();
				await releaseBuild.promise;
				return fresh;
			},
		});
		sessions.push(session);
		session.start();
		await buildStarted.promise;

		expect(session.getSnapshot()).toBeUndefined();
		expect(session.getStatus()).toMatchObject({
			status: "indexing",
			phase: "indexing",
			hasSnapshot: false,
			refreshing: true,
			persistent: true,
		});
		releaseBuild.resolve();
		await session.waitUntilIdle();
		expect(session.getSnapshot()).toEqual(fresh);
		expect(session.getSnapshotGeneration()).toEqual({
			snapshot: fresh,
			repositoryFingerprint: "fingerprint-new",
		});
		expect(session.getStatus()).toEqual({
			status: "ready",
			phase: "ready",
			hasSnapshot: true,
			revision: 1,
			source: "fresh",
			refreshing: false,
			persistent: true,
		});

		await session.dispose();
		const cache = await openAtlasSnapshotCache({ rootPath: root, indexPath: databasePath });
			expect(cache.get({
				repositoryFingerprint: "fingerprint-new",
				snapshotVersion: ATLAS_SNAPSHOT_VERSION,
			}, isAtlasSnapshot))
			.toMatchObject({
				snapshot: fresh,
				repositoryFingerprint: "fingerprint-new",
			});
		cache.close();
	});

	test("does not expose an unrelated cached snapshot when indexing fails", async () => {
		const { root, databasePath } = temporaryRepository();
		const cached = snapshot(root, "2026-07-26T10:00:00.000Z");
		await seedCache(root, databasePath, "fingerprint-old", cached);
		const session = await AtlasIndexSession.open({
			rootPath: root,
			cacheOptions: { indexPath: databasePath },
			collectFingerprint: async () => "fingerprint-new",
			buildSnapshot: async () => {
				throw new Error("index failed");
			},
		});
		sessions.push(session);
		session.start();
		await session.waitUntilIdle();

		expect(session.getSnapshot()).toBeUndefined();
		expect(session.getStatus()).toEqual({
			status: "error",
			phase: "error",
			hasSnapshot: false,
			revision: 0,
			refreshing: false,
			persistent: true,
			error: "index failed",
		});
	});

	test("reports a fatal error when no cached snapshot exists", async () => {
		const { root, databasePath } = temporaryRepository();
		const session = await AtlasIndexSession.open({
			rootPath: root,
			cacheOptions: { indexPath: databasePath },
			collectFingerprint: async () => {
				throw new Error("fingerprint failed");
			},
			buildSnapshot: async () => snapshot(root, "never"),
		});
		sessions.push(session);
		session.start();
		await session.waitUntilIdle();

		expect(session.getSnapshot()).toBeUndefined();
		expect(session.getSnapshotGeneration()).toBeUndefined();
		expect(session.getStatus()).toEqual({
			status: "error",
			phase: "error",
			hasSnapshot: false,
			revision: 0,
			refreshing: false,
			persistent: true,
			error: "fingerprint failed",
		});
	});

	test("coalesces manual requests during active work into one forced rerun", async () => {
		const { root, databasePath } = temporaryRepository();
		const builds = [deferred<AtlasSnapshot>(), deferred<AtlasSnapshot>()];
		let buildCalls = 0;
		let fingerprintCalls = 0;
		const session = await AtlasIndexSession.open({
			rootPath: root,
			cacheOptions: { indexPath: databasePath },
			collectFingerprint: async () => {
				fingerprintCalls += 1;
				return "fingerprint-a";
			},
			buildSnapshot: async () => builds[buildCalls++]!.promise,
		});
		sessions.push(session);
		session.start();
		while (buildCalls < 1) await Promise.resolve();

		const firstManual = session.reindex();
		const secondManual = session.reindex();
		expect(firstManual).toBe(secondManual);
		builds[0]!.resolve(snapshot(root, "2026-07-26T10:00:00.000Z"));
		while (buildCalls < 2) await Promise.resolve();
		builds[1]!.resolve(snapshot(root, "2026-07-26T11:00:00.000Z"));
		await firstManual;

		expect(buildCalls).toBe(2);
		expect(fingerprintCalls).toBe(4);
		expect(session.getSnapshot()?.generatedAt).toBe("2026-07-26T11:00:00.000Z");
		expect(session.getStatus().revision).toBe(2);
	});

	test("rebuilds before caching when source changes during indexing", async () => {
		const { root, databasePath } = temporaryRepository();
		const fingerprints = ["fingerprint-a", "fingerprint-b", "fingerprint-b"];
		let builds = 0;
		const stable = snapshot(root, "fingerprint-b");
		const session = await AtlasIndexSession.open({
			rootPath: root,
			cacheOptions: { indexPath: databasePath },
			collectFingerprint: async () => fingerprints.shift() ?? "fingerprint-b",
			buildSnapshot: async ({ repositoryFingerprint }) => {
				builds += 1;
				return snapshot(root, repositoryFingerprint);
			},
		});
		sessions.push(session);

		session.start();
		await session.waitUntilIdle();
		expect(builds).toBe(2);
		expect(session.getSnapshot()?.generatedAt).toBe("fingerprint-b");

		await session.dispose();
		const cache = await openAtlasSnapshotCache({ rootPath: root, indexPath: databasePath });
			expect(cache.get({
				repositoryFingerprint: "fingerprint-b",
				snapshotVersion: ATLAS_SNAPSHOT_VERSION,
			}, isAtlasSnapshot))
			.toMatchObject({
				snapshot: stable,
				repositoryFingerprint: "fingerprint-b",
			});
		cache.close();
	});

	test("a forced reindex rebuilds even when the fingerprint is unchanged", async () => {
		const { root, databasePath } = temporaryRepository();
		const cached = snapshot(root, "2026-07-26T10:00:00.000Z");
		const fresh = snapshot(root, "2026-07-26T11:00:00.000Z");
		await seedCache(root, databasePath, "fingerprint-a", cached);
		let builds = 0;
		const session = await AtlasIndexSession.open({
			rootPath: root,
			cacheOptions: { indexPath: databasePath },
			collectFingerprint: async () => "fingerprint-a",
			buildSnapshot: async ({ forced }) => {
				expect(forced).toBe(true);
				builds += 1;
				return fresh;
			},
		});
		sessions.push(session);

		await session.reindex();
		expect(builds).toBe(1);
		expect(session.getSnapshot()).toEqual(fresh);
	});

	test("dispose waits for active work and prevents a late snapshot swap", async () => {
		const { root, databasePath } = temporaryRepository();
		const build = deferred<AtlasSnapshot>();
		let buildStarted = false;
		const session = await AtlasIndexSession.open({
			rootPath: root,
			cacheOptions: { indexPath: databasePath },
			collectFingerprint: async () => "fingerprint-a",
			buildSnapshot: async () => {
				buildStarted = true;
				return build.promise;
			},
		});
		sessions.push(session);
		session.start();
		while (!buildStarted) await Promise.resolve();

		let disposed = false;
		const disposal = session.dispose().then(() => {
			disposed = true;
		});
		await Promise.resolve();
		expect(disposed).toBe(false);
		build.resolve(snapshot(root, "2026-07-26T10:00:00.000Z"));
		await disposal;
		expect(disposed).toBe(true);
		expect(session.getSnapshot()).toBeUndefined();
	});
});
