import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AtlasSnapshot } from "./atlas";

export const ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION = 2;

const DEFAULT_INDEX_PATH = join(".plannotator", "atlas.sqlite3");
const MAX_SNAPSHOTS_PER_VERSION = 8;

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
	repositoryFingerprint: string;
	snapshot: unknown;
}

export interface AtlasSnapshotCacheKey {
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
	rootPath: string;
	indexPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
	key: AtlasSnapshotCacheKey,
): value is StoredSnapshotEnvelope {
	if (
		!isRecord(value) ||
		value.cacheSchemaVersion !== ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION ||
		value.snapshotVersion !== key.snapshotVersion ||
		value.repositoryFingerprint !== key.repositoryFingerprint ||
		!isRecord(value.snapshot)
	) return false;
	return value.snapshot.version === key.snapshotVersion;
}

function initializeSchema(database: SqliteDatabase): void {
	database.exec(`
		PRAGMA journal_mode = DELETE;
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
			DELETE FROM atlas_cache_metadata WHERE key = 'schema_version';
		`);
	}

	database.prepare(`
		INSERT INTO atlas_cache_metadata (key, value)
		VALUES ('schema_version', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`).run(String(ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION));
	database.exec(`
		CREATE TABLE IF NOT EXISTS atlas_snapshots (
			repository_fingerprint TEXT NOT NULL,
			snapshot_version INTEGER NOT NULL,
			snapshot_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (
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

function expandHome(filePath: string): string {
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return join(homedir(), filePath.slice(2));
	}
	return filePath;
}

export function getDefaultAtlasIndexPath(rootPath: string): string {
	return join(realpathSync.native(resolve(rootPath)), DEFAULT_INDEX_PATH);
}

export function resolveAtlasIndexPath(
	rootPath: string,
	explicitPath?: string,
): string {
	const canonicalRoot = realpathSync.native(resolve(rootPath));
	const configuredPath =
		explicitPath?.trim() || process.env.PLANNOTATOR_ATLAS_INDEX_PATH?.trim();
	if (!configuredPath) return join(canonicalRoot, DEFAULT_INDEX_PATH);
	const expanded = expandHome(configuredPath);
	return resolve(canonicalRoot, expanded);
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
	readonly indexPath: string;
	readonly available: boolean;
	readonly initializationError?: string;

	#database: SqliteDatabase | null;
	#lastError: string | undefined;

	private constructor(
		indexPath: string,
		database: SqliteDatabase | null,
		initializationError?: string,
	) {
		this.indexPath = indexPath;
		this.#database = database;
		this.available = database !== null;
		this.initializationError = initializationError;
	}

	static async open(
		options: OpenAtlasSnapshotCacheOptions,
	): Promise<AtlasSnapshotCache> {
		const indexPath = resolveAtlasIndexPath(options.rootPath, options.indexPath);
		let database: SqliteDatabase | null = null;
		try {
			mkdirSync(dirname(indexPath), { recursive: true });
			const Database = await sqliteDatabaseConstructor();
			database = new Database(indexPath);
			initializeSchema(database);
			return new AtlasSnapshotCache(indexPath, database);
		} catch (error) {
			try {
				database?.close();
			} catch {
				// The cache remains disabled after an initialization failure.
			}
			return new AtlasSnapshotCache(
				indexPath,
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
			const row = this.#database.prepare(`
				SELECT repository_fingerprint, snapshot_json, created_at
				FROM atlas_snapshots
				WHERE repository_fingerprint = ?
					AND snapshot_version = ?
			`).get(key.repositoryFingerprint, key.snapshotVersion);
			return this.#parseEntry(row, key, validateSnapshot);
		} catch (error) {
			this.#lastError = error instanceof Error ? error.message : String(error);
			return null;
		}
	}

	get lastError(): string | undefined {
		return this.#lastError ?? this.initializationError;
	}

	set(key: AtlasSnapshotCacheKey, snapshot: AtlasSnapshot): boolean {
		if (!this.#database || !validKey(key) || !isRecord(snapshot)) {
			this.#lastError = this.initializationError ?? "Atlas snapshot cache is unavailable";
			return false;
		}
		try {
			if (snapshot.version !== key.snapshotVersion) {
				this.#lastError = "Atlas snapshot version does not match the cache key";
				return false;
			}
			const envelope: StoredSnapshotEnvelope = {
				cacheSchemaVersion: ATLAS_SNAPSHOT_CACHE_SCHEMA_VERSION,
				snapshotVersion: key.snapshotVersion,
				repositoryFingerprint: key.repositoryFingerprint,
				snapshot,
			};
			const serialized = JSON.stringify(envelope);
			this.#database.exec("BEGIN IMMEDIATE");
			try {
				this.#database.prepare(`
					INSERT INTO atlas_snapshots (
						repository_fingerprint,
						snapshot_version,
						snapshot_json,
						created_at
					) VALUES (?, ?, ?, ?)
					ON CONFLICT(repository_fingerprint, snapshot_version)
					DO UPDATE SET
						snapshot_json = excluded.snapshot_json,
						created_at = excluded.created_at
				`).run(
					key.repositoryFingerprint,
					key.snapshotVersion,
					serialized,
					new Date().toISOString(),
				);
				this.#database.prepare(`
					DELETE FROM atlas_snapshots
					WHERE snapshot_version = ?
						AND rowid NOT IN (
							SELECT rowid
							FROM atlas_snapshots
							WHERE snapshot_version = ?
							ORDER BY created_at DESC, rowid DESC
							LIMIT ?
						)
				`).run(
					key.snapshotVersion,
					key.snapshotVersion,
					MAX_SNAPSHOTS_PER_VERSION,
				);
				this.#database.exec("COMMIT");
			} catch (error) {
				this.#database.exec("ROLLBACK");
				throw error;
			}
			this.#lastError = undefined;
			return true;
		} catch (error) {
			this.#lastError = error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	deleteAll(): boolean {
		if (!this.#database) return false;
		try {
			this.#database.prepare("DELETE FROM atlas_snapshots").run();
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
		key: AtlasSnapshotCacheKey,
	): void {
		try {
			this.#database?.prepare(`
				DELETE FROM atlas_snapshots
				WHERE repository_fingerprint = ?
					AND snapshot_version = ?
			`).run(key.repositoryFingerprint, key.snapshotVersion);
		} catch {
			// A corrupt entry is already a cache miss; cleanup is best effort.
		}
	}

	#parseEntry(
		value: unknown,
		key: AtlasSnapshotCacheKey,
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
				this.#deleteEntry(key);
				return null;
			}
			return {
				snapshot: envelope.snapshot,
				repositoryFingerprint: value.repository_fingerprint,
				createdAt: value.created_at,
			};
		} catch {
			this.#deleteEntry(key);
			return null;
		}
	}
}

export function openAtlasSnapshotCache(
	options: OpenAtlasSnapshotCacheOptions,
): Promise<AtlasSnapshotCache> {
	return AtlasSnapshotCache.open(options);
}
