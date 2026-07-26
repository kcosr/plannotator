import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AtlasSnapshot } from "./atlas";
import {
	ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION,
	createAtlasRepositoryFingerprint,
	getDefaultAtlasIndexPath,
	openAtlasSnapshotCache,
	resolveAtlasIndexPath,
	type AtlasSnapshotCache,
} from "./atlas-snapshot-cache";

const temporaryDirectories: string[] = [];
const openCaches: AtlasSnapshotCache[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "plannotator-atlas-cache-"));
	temporaryDirectories.push(directory);
	return directory;
}

function snapshot(_rootPath: string): AtlasSnapshot {
	return {
		version: 4,
		rootName: "repository",
		rootId: "root",
		generatedAt: "2026-07-26T12:00:00.000Z",
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

function validateSnapshot(value: unknown): value is AtlasSnapshot {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { version?: unknown }).version === 4
	);
}

async function cacheAt(databasePath: string): Promise<AtlasSnapshotCache> {
	const cache = await openAtlasSnapshotCache({
		rootPath: temporaryDirectory(),
		indexPath: databasePath,
	});
	openCaches.push(cache);
	return cache;
}

afterEach(() => {
	for (const cache of openCaches.splice(0)) cache.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("AtlasSnapshotCache", () => {
	test("uses a stable order-independent repository fingerprint", () => {
		const first = createAtlasRepositoryFingerprint([
			{ path: "./src\\main.ts", contentFingerprint: "content-a" },
			{ path: "src/model.ts", contentFingerprint: "content-b" },
		]);
		const reordered = createAtlasRepositoryFingerprint([
			{ path: "src/model.ts", contentFingerprint: "content-b" },
			{ path: "src/main.ts", contentFingerprint: "content-a" },
		]);
		const changed = createAtlasRepositoryFingerprint([
			{ path: "src/main.ts", contentFingerprint: "content-a" },
			{ path: "src/model.ts", contentFingerprint: "content-c" },
		]);

		expect(first).toBe(reordered);
		expect(first).toStartWith("sha256:");
		expect(first).not.toBe(changed);
	});

	test("stores and reads a portable snapshot by fingerprint and version", async () => {
		const directory = temporaryDirectory();
		const root = join(directory, "repo");
		mkdirSync(root);
		const cache = await cacheAt(join(directory, "cache", "atlas.sqlite3"));
		const key = {
			repositoryFingerprint: "sha256:repository-a",
			snapshotVersion: 4,
		};
		const value = snapshot(root);

		expect(cache.available).toBe(true);
		expect(cache.set(key, value)).toBe(true);
		expect(cache.get(key, validateSnapshot)).toEqual({
			snapshot: value,
			repositoryFingerprint: key.repositoryFingerprint,
			createdAt: expect.any(String),
		});
		expect(cache.getLatest(4, validateSnapshot)).toEqual({
			snapshot: value,
			repositoryFingerprint: key.repositoryFingerprint,
			createdAt: expect.any(String),
		});
		expect(cache.get({
			...key,
			repositoryFingerprint: "sha256:repository-b",
		}, validateSnapshot)).toBeNull();
		expect(cache.get({ ...key, snapshotVersion: 5 }, validateSnapshot)).toBeNull();
	});

	test("replaces stale fingerprints for the same repository and snapshot version", async () => {
		const directory = temporaryDirectory();
		const root = join(directory, "repo");
		mkdirSync(root);
		const cache = await cacheAt(join(directory, "atlas.sqlite3"));
		const firstKey = {
			repositoryFingerprint: "sha256:first",
			snapshotVersion: 4,
		};
		const secondKey = { ...firstKey, repositoryFingerprint: "sha256:second" };

		expect(cache.set(firstKey, snapshot(root))).toBe(true);
		expect(cache.set(secondKey, snapshot(root))).toBe(true);
		expect(cache.get(firstKey, validateSnapshot)).toBeNull();
		expect(cache.get(secondKey, validateSnapshot)?.snapshot).toEqual(snapshot(root));
		expect(cache.getLatest(4, validateSnapshot)?.repositoryFingerprint)
			.toBe(secondKey.repositoryFingerprint);
	});

	test("evicts snapshots rejected by the caller validator", async () => {
		const directory = temporaryDirectory();
		const root = join(directory, "repo");
		mkdirSync(root);
		const cache = await cacheAt(join(directory, "atlas.sqlite3"));
		const key = {
			repositoryFingerprint: "sha256:repository",
			snapshotVersion: 4,
		};
		expect(cache.set(key, snapshot(root))).toBe(true);
		expect(cache.get(key, (_value): _value is AtlasSnapshot => false)).toBeNull();
		expect(cache.getLatest(4, validateSnapshot)).toBeNull();
	});

	test("rejects mismatched snapshot metadata", async () => {
		const directory = temporaryDirectory();
		const root = join(directory, "repo");
		mkdirSync(root);
		const cache = await cacheAt(join(directory, "atlas.sqlite3"));
		const key = {
			repositoryFingerprint: "sha256:repository",
			snapshotVersion: 4,
		};

		expect(cache.set(key, {
			...snapshot(root),
			version: 5,
		} as unknown as AtlasSnapshot)).toBe(false);
		expect(cache.set({ ...key, repositoryFingerprint: "" }, snapshot(root))).toBe(false);
		expect(cache.get(key, validateSnapshot)).toBeNull();
	});

	test("treats malformed JSON as a cache miss", async () => {
		const directory = temporaryDirectory();
		const root = join(directory, "repo");
		const databasePath = join(directory, "atlas.sqlite3");
		mkdirSync(root);
		const cache = await cacheAt(databasePath);
		const key = {
			repositoryFingerprint: "sha256:repository",
			snapshotVersion: 4,
		};
		expect(cache.set(key, snapshot(root))).toBe(true);

		const mutation = spawnSync("node", [
			"-e",
			[
				"const { DatabaseSync } = require('node:sqlite');",
				"const db = new DatabaseSync(process.argv[1]);",
				"db.prepare('UPDATE atlas_snapshots SET snapshot_json = ?').run('{');",
				"db.close();",
			].join(""),
			databasePath,
		], { encoding: "utf8" });
		expect(mutation.status).toBe(0);
		expect(cache.get(key, validateSnapshot)).toBeNull();
		expect(cache.getLatest(4, validateSnapshot)).toBeNull();
	});

	test("creates a database Node can read after Bun writes it", async () => {
		const directory = temporaryDirectory();
		const root = join(directory, "repo");
		const databasePath = join(directory, "atlas.sqlite3");
		mkdirSync(root);
		const cache = await cacheAt(databasePath);
		const key = {
			repositoryFingerprint: "sha256:repository",
			snapshotVersion: 4,
		};
		expect(cache.set(key, snapshot(root))).toBe(true);
		expect(existsSync(`${databasePath}-wal`)).toBe(false);
		expect(readFileSync(databasePath).includes(Buffer.from(realpathSync.native(root))))
			.toBe(false);
		cache.close();

		const read = spawnSync("node", [
			"-e",
			[
				"const { DatabaseSync } = require('node:sqlite');",
				"const db = new DatabaseSync(process.argv[1], { readOnly: true });",
				"const row = db.prepare('SELECT snapshot_json FROM atlas_snapshots').get();",
				"process.stdout.write(row.snapshot_json);",
				"db.close();",
			].join(""),
			databasePath,
		], { encoding: "utf8" });
		expect(read.status).toBe(0);
		const envelope = JSON.parse(read.stdout);
		expect(envelope.cacheSchemaVersion).toBe(ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION);
		expect(envelope.repositoryFingerprint).toBe(key.repositoryFingerprint);
		expect(envelope.snapshot).toEqual(snapshot(root));
	});

	test("disables itself safely when the database file is corrupt", async () => {
		const directory = temporaryDirectory();
		const root = join(directory, "repo");
		const databasePath = join(directory, "atlas.sqlite3");
		mkdirSync(root);
		writeFileSync(databasePath, "not a sqlite database");
		const cache = await cacheAt(databasePath);
		const key = {
			repositoryFingerprint: "sha256:repository",
			snapshotVersion: 4,
		};

		expect(cache.available).toBe(false);
		expect(cache.initializationError).toBeString();
		expect(cache.get(key, validateSnapshot)).toBeNull();
		expect(cache.set(key, snapshot(root))).toBe(false);
	});

	test("replaces an obsolete unversioned cache schema", async () => {
		const directory = temporaryDirectory();
		const root = join(directory, "repo");
		const databasePath = join(directory, "atlas.sqlite3");
		mkdirSync(root);
		const legacy = spawnSync("node", [
			"-e",
			[
				"const { DatabaseSync } = require('node:sqlite');",
				"const db = new DatabaseSync(process.argv[1]);",
				"db.exec('CREATE TABLE atlas_snapshots (obsolete TEXT)');",
				"db.close();",
			].join(""),
			databasePath,
		], { encoding: "utf8" });
		expect(legacy.status).toBe(0);

		const cache = await cacheAt(databasePath);
		const key = {
			repositoryFingerprint: "sha256:repository",
			snapshotVersion: 4,
		};
		expect(cache.available).toBe(true);
		expect(cache.set(key, snapshot(root))).toBe(true);
		expect(cache.get(key, validateSnapshot)?.snapshot).toEqual(snapshot(root));
	});

	test("places the default database inside the repository", () => {
		const root = temporaryDirectory();
		expect(getDefaultAtlasIndexPath(root)).toBe(
			join(realpathSync.native(root), ".plannotator", "atlas.sqlite3"),
		);
	});

	test("resolves relative and absolute index overrides", () => {
		const root = temporaryDirectory();
		expect(resolveAtlasIndexPath(root, "indexes/atlas.sqlite3")).toBe(
			join(realpathSync.native(root), "indexes", "atlas.sqlite3"),
		);
		const external = join(temporaryDirectory(), "atlas.sqlite3");
		expect(resolveAtlasIndexPath(root, external)).toBe(external);
	});

	test("uses the environment override when no explicit path is supplied", () => {
		const root = temporaryDirectory();
		const previous = process.env.PLANNOTATOR_ATLAS_INDEX_PATH;
		process.env.PLANNOTATOR_ATLAS_INDEX_PATH = "external/atlas.sqlite3";
		try {
			expect(resolveAtlasIndexPath(root)).toBe(
				join(realpathSync.native(root), "external", "atlas.sqlite3"),
			);
			expect(resolveAtlasIndexPath(root, "explicit.sqlite3")).toBe(
				join(realpathSync.native(root), "explicit.sqlite3"),
			);
		} finally {
			if (previous === undefined) delete process.env.PLANNOTATOR_ATLAS_INDEX_PATH;
			else process.env.PLANNOTATOR_ATLAS_INDEX_PATH = previous;
		}
	});
});
