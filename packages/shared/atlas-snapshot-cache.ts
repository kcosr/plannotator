import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AtlasSnapshot } from "./atlas";
import { getPlannotatorDataDir } from "./data-dir";

export const ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;

const DEFAULT_CACHE_FILENAME = "snapshots.sqlite3";

interface SqliteStatement {
	get(...parameters: unknown[]): unknown;
	run(...parameters: unknown[]): unknown;
}

interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface SqliteDatabaseConstructor {
	new (filename: string): SqliteDatabase;
}

interface StoredSnapshotRow {
	repository_fingerprint: string;
	snapshot_json: string;
	created_at: string;
}

interface StoredSnapshotEnvelope {
	cacheSchemaVersion: number;
	snapshotVersion: number;
	canonicalRoot: string;
	repositoryFingerprint: string;
	snapshot: unknown;
}

export interface AtlasSnapshotCacheKey {
	rootPath: string;
	repositoryFingerprint: string;
	snapshotVersion: number;
}

export interface AtlasSnapshotCacheEntry {
	snapshot: AtlasSnapshot;
	repositoryFingerprint: string;
	createdAt: string;
}

export type AtlasSnapshotValidator = (value: unknown) => value is AtlasSnapshot;

export interface AtlasRepositoryFingerprintEntry {
	path: string;
	contentFingerprint: string;
}

export interface OpenAtlasSnapshotCacheOptions {
	databasePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalRoot(rootPath: string): string {
	return realpathSync.native(resolve(rootPath));
}

function normalizedRepositoryPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function validKey(key: AtlasSnapshotCacheKey): boolean {
	return (
		key.repositoryFingerprint.trim().length > 0 &&
		Number.isInteger(key.snapshotVersion) &&
		key.snapshotVersion > 0
	);
}

function isStoredSnapshotRow(value: unknown): value is StoredSnapshotRow {
	return (
		isRecord(value) &&
		typeof value.repository_fingerprint === "string" &&
		typeof value.snapshot_json === "string" &&
		typeof value.created_at === "string"
	);
}

function isStoredSnapshotEnvelope(
	value: unknown,
	key: Omit<AtlasSnapshotCacheKey, "rootPath"> & { canonicalRoot: string },
): value is StoredSnapshotEnvelope {
	if (
		!isRecord(value) ||
		value.cacheSchemaVersion !== ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION ||
		value.snapshotVersion !== key.snapshotVersion ||
		value.canonicalRoot !== key.canonicalRoot ||
		value.repositoryFingerprint !== key.repositoryFingerprint ||
		!isRecord(value.snapshot)
	) return false;
	return (
		value.snapshot.version === key.snapshotVersion &&
		value.snapshot.rootPath === key.canonicalRoot
	);
}

function initializeSchema(database: SqliteDatabase): void {
	database.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 2000;
		CREATE TABLE IF NOT EXISTS atlas_cache_metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);

	const metadata = database.prepare(
		"SELECT value FROM atlas_cache_metadata WHERE key = 'schema_version'",
	).get();
	const storedVersion = isRecord(metadata) && typeof metadata.value === "string"
		? Number(metadata.value)
		: null;
	if (storedVersion !== ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION) {
		database.exec(`
			DROP TABLE IF EXISTS atlas_snapshots;
			DELETE FROM atlas_cache_metadata;
		`);
	}

	database.prepare(`
		INSERT INTO atlas_cache_metadata (key, value)
		VALUES ('schema_version', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`).run(String(ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION));
	database.exec(`
		CREATE TABLE IF NOT EXISTS atlas_snapshots (
			canonical_root TEXT NOT NULL,
			repository_fingerprint TEXT NOT NULL,
			snapshot_version INTEGER NOT NULL,
			snapshot_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (
				canonical_root,
				repository_fingerprint,
				snapshot_version
			)
		);
	`);
}

async function sqliteDatabaseConstructor(): Promise<SqliteDatabaseConstructor> {
	if ("bun" in process.versions) {
		const bunSqliteSpecifier = "bun:sqlite";
		const module = await import(bunSqliteSpecifier) as {
			Database: SqliteDatabaseConstructor;
		};
		return module.Database;
	}
	const module = await import("node:sqlite");
	return module.DatabaseSync as unknown as SqliteDatabaseConstructor;
}

export function getDefaultAtlasSnapshotCachePath(): string {
	return join(getPlannotatorDataDir(), "atlas", DEFAULT_CACHE_FILENAME);
}

/**
 * Produce an order-independent repository fingerprint from content-derived
 * file fingerprints. Callers choose how to hash content while this function
 * supplies stable path normalization and unambiguous framing.
 */
export function createAtlasRepositoryFingerprint(
	entries: Iterable<AtlasRepositoryFingerprintEntry>,
): string {
	const ordered = [...entries]
		.map((entry) => ({
			path: normalizedRepositoryPath(entry.path),
			contentFingerprint: entry.contentFingerprint,
		}))
		.sort(
			(first, second) =>
				first.path.localeCompare(second.path) ||
				first.contentFingerprint.localeCompare(second.contentFingerprint),
		);
	const hash = createHash("sha256");
	for (const entry of ordered) {
		const path = Buffer.from(entry.path);
		const contentFingerprint = Buffer.from(entry.contentFingerprint);
		const framing = Buffer.allocUnsafe(8);
		framing.writeUInt32BE(path.length, 0);
		framing.writeUInt32BE(contentFingerprint.length, 4);
		hash.update(framing);
		hash.update(path);
		hash.update(contentFingerprint);
	}
	return `sha256:${hash.digest("hex")}`;
}

export class AtlasSnapshotCache {
	readonly databasePath: string;
	readonly available: boolean;
	readonly initializationError?: string;

	#database: SqliteDatabase | null;

	private constructor(
		databasePath: string,
		database: SqliteDatabase | null,
		initializationError?: string,
	) {
		this.databasePath = databasePath;
		this.#database = database;
		this.available = database !== null;
		this.initializationError = initializationError;
	}

	static async open(
		options: OpenAtlasSnapshotCacheOptions = {},
	): Promise<AtlasSnapshotCache> {
		const databasePath = resolve(
			options.databasePath ?? getDefaultAtlasSnapshotCachePath(),
		);
		let database: SqliteDatabase | null = null;
		try {
			mkdirSync(dirname(databasePath), { recursive: true });
			const Database = await sqliteDatabaseConstructor();
			database = new Database(databasePath);
			initializeSchema(database);
			return new AtlasSnapshotCache(databasePath, database);
		} catch (error) {
			try {
				database?.close();
			} catch {
				// The cache remains disabled after an initialization failure.
			}
			return new AtlasSnapshotCache(
				databasePath,
				null,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	get(
		key: AtlasSnapshotCacheKey,
		validateSnapshot: AtlasSnapshotValidator,
	): AtlasSnapshotCacheEntry | null {
		if (!this.#database || !validKey(key)) return null;
		try {
			const canonical = canonicalRoot(key.rootPath);
			const row = this.#database.prepare(`
				SELECT repository_fingerprint, snapshot_json, created_at
				FROM atlas_snapshots
				WHERE canonical_root = ?
					AND repository_fingerprint = ?
					AND snapshot_version = ?
			`).get(canonical, key.repositoryFingerprint, key.snapshotVersion);
			return this.#parseEntry(row, {
				canonicalRoot: canonical,
				repositoryFingerprint: key.repositoryFingerprint,
				snapshotVersion: key.snapshotVersion,
			}, validateSnapshot);
		} catch {
			return null;
		}
	}

	getLatest(
		rootPath: string,
		snapshotVersion: number,
		validateSnapshot: AtlasSnapshotValidator,
	): AtlasSnapshotCacheEntry | null {
		if (
			!this.#database ||
			!Number.isInteger(snapshotVersion) ||
			snapshotVersion < 1
		) return null;
		try {
			const canonical = canonicalRoot(rootPath);
			const row = this.#database.prepare(`
				SELECT repository_fingerprint, snapshot_json, created_at
				FROM atlas_snapshots
				WHERE canonical_root = ? AND snapshot_version = ?
				ORDER BY created_at DESC
				LIMIT 1
			`).get(canonical, snapshotVersion);
			if (!isStoredSnapshotRow(row)) return null;
			return this.#parseEntry(row, {
				canonicalRoot: canonical,
				repositoryFingerprint: row.repository_fingerprint,
				snapshotVersion,
			}, validateSnapshot);
		} catch {
			return null;
		}
	}

	set(key: AtlasSnapshotCacheKey, snapshot: AtlasSnapshot): boolean {
		if (!this.#database || !validKey(key) || !isRecord(snapshot)) return false;
		try {
			const canonical = canonicalRoot(key.rootPath);
			if (
				snapshot.version !== key.snapshotVersion ||
				snapshot.rootPath !== canonical
			) return false;
			const envelope: StoredSnapshotEnvelope = {
				cacheSchemaVersion: ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION,
				snapshotVersion: key.snapshotVersion,
				canonicalRoot: canonical,
				repositoryFingerprint: key.repositoryFingerprint,
				snapshot,
			};
			const serialized = JSON.stringify(envelope);
			this.#database.exec("BEGIN IMMEDIATE");
			try {
				this.#database.prepare(`
					DELETE FROM atlas_snapshots
					WHERE canonical_root = ? AND snapshot_version = ?
				`).run(canonical, key.snapshotVersion);
				this.#database.prepare(`
					INSERT INTO atlas_snapshots (
						canonical_root,
						repository_fingerprint,
						snapshot_version,
						snapshot_json,
						created_at
					) VALUES (?, ?, ?, ?, ?)
				`).run(
					canonical,
					key.repositoryFingerprint,
					key.snapshotVersion,
					serialized,
					new Date().toISOString(),
				);
				this.#database.exec("COMMIT");
			} catch (error) {
				this.#database.exec("ROLLBACK");
				throw error;
			}
			return true;
		} catch {
			return false;
		}
	}

	deleteRoot(rootPath: string): boolean {
		if (!this.#database) return false;
		try {
			const canonical = canonicalRoot(rootPath);
			this.#database.prepare(
				"DELETE FROM atlas_snapshots WHERE canonical_root = ?",
			).run(canonical);
			return true;
		} catch {
			return false;
		}
	}

	close(): void {
		const database = this.#database;
		this.#database = null;
		try {
			database?.close();
		} catch {
			// Closing a disposable cache must not affect process shutdown.
		}
	}

	#deleteEntry(
		canonical: string,
		key: Pick<AtlasSnapshotCacheKey, "repositoryFingerprint" | "snapshotVersion">,
	): void {
		try {
			this.#database?.prepare(`
				DELETE FROM atlas_snapshots
				WHERE canonical_root = ?
					AND repository_fingerprint = ?
					AND snapshot_version = ?
			`).run(canonical, key.repositoryFingerprint, key.snapshotVersion);
		} catch {
			// A corrupt entry is already a cache miss; cleanup is best effort.
		}
	}

	#parseEntry(
		value: unknown,
		key: Omit<AtlasSnapshotCacheKey, "rootPath"> & { canonicalRoot: string },
		validateSnapshot: AtlasSnapshotValidator,
	): AtlasSnapshotCacheEntry | null {
		if (!isStoredSnapshotRow(value)) return null;
		try {
			const envelope = JSON.parse(value.snapshot_json);
			if (
				value.repository_fingerprint !== key.repositoryFingerprint ||
				!isStoredSnapshotEnvelope(envelope, key) ||
				!validateSnapshot(envelope.snapshot)
			) {
				this.#deleteEntry(key.canonicalRoot, key);
				return null;
			}
			return {
				snapshot: envelope.snapshot,
				repositoryFingerprint: value.repository_fingerprint,
				createdAt: value.created_at,
			};
		} catch {
			this.#deleteEntry(key.canonicalRoot, key);
			return null;
		}
	}
}

export function openAtlasSnapshotCache(
	options: OpenAtlasSnapshotCacheOptions = {},
): Promise<AtlasSnapshotCache> {
	return AtlasSnapshotCache.open(options);
}
