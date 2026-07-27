import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
	AtlasNode,
	AtlasSemanticProviderCapability,
	AtlasSnapshot,
	AtlasSymbol,
} from "./atlas";
import {
	resolveAtlasCallHierarchyOutcome,
	resolveAtlasReferencesOutcome,
	validateAtlasRelativePath,
	type AtlasCallHierarchyResponse,
	type AtlasCallHierarchyTarget,
	type AtlasReference,
	type AtlasReferenceResponse,
	type AtlasSemanticResolutionOutcome,
} from "./atlas-source";
import {
	AtlasSemanticSession,
	probeAtlasSemanticCapabilities,
	type AtlasSemanticCapability,
	type AtlasSemanticLanguage,
} from "./atlas-semantic";

export const ATLAS_SEMANTIC_INDEX_SCHEMA_VERSION = 1;

interface SqliteStatement {
	all(...parameters: unknown[]): unknown[];
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

type QueryKind = "references" | "calls";
type StoredQueryState = "complete" | "unsupported";

interface QueryDescriptor {
	queryKey: string;
	repositoryFingerprint: string;
	snapshotVersion: number;
	providerFingerprint: string;
	kind: QueryKind;
	filePath: string;
	line: number;
	column: number;
	symbol: string;
	atlasSymbolId: string | null;
}

interface StoredQueryRow {
	state: StoredQueryState;
	provider_kind: "lsp" | "syntax";
	provider_name: string;
	provider_status: "ready" | "unsupported" | "unavailable";
	provider_message: string | null;
	truncated: number;
}

interface StoredReferenceRow {
	kind: "definition" | "reference";
	file_id: string;
	file_path: string;
	line: number;
	column: number;
	snippet: string;
}

interface StoredCallTargetRow {
	target_key: string;
	direction: "root" | "caller" | "callee";
	name: string;
	kind: number;
	detail: string | null;
	file_id: string;
	file_path: string;
	line: number;
	column: number;
	snippet: string;
}

interface StoredCallSiteRow {
	target_key: string;
	file_id: string;
	file_path: string;
	line: number;
	column: number;
	snippet: string;
}

export interface OpenAtlasSemanticIndexStoreOptions {
	indexPath: string;
}

export interface OpenAtlasSemanticIndexServiceOptions {
	indexPath: string;
	rootPath: string;
	session?: AtlasSemanticSession;
	capabilities?: Record<AtlasSemanticLanguage, AtlasSemanticCapability>;
	semanticSessionOptions?: ConstructorParameters<typeof AtlasSemanticSession>[0];
}

export interface AtlasSemanticLookup<T> {
	response: T;
	source: "cache" | "live";
	cacheability: AtlasSemanticResolutionOutcome<T>["cacheability"];
}

export interface AtlasSemanticQueryInput {
	snapshot: AtlasSnapshot;
	repositoryFingerprint: string;
	filePath: string;
	line: number;
	column: number;
	atlasSymbolId?: string;
	signal?: AbortSignal;
}

export interface AtlasSemanticReferenceInput extends AtlasSemanticQueryInput {
	symbol: string;
}

export interface AtlasSemanticIndexProgress {
	total: number;
	completed: number;
	cached: number;
	resolved: number;
	unsupported: number;
	failed: number;
	current?: {
		kind: QueryKind;
		filePath: string;
		symbol: string;
		language: string;
	};
}

export interface AtlasSemanticIndexAllOptions {
	snapshot: AtlasSnapshot;
	repositoryFingerprint: string;
	signal?: AbortSignal;
	onProgress?: (progress: AtlasSemanticIndexProgress) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStoredQueryRow(value: unknown): value is StoredQueryRow {
	return (
		isRecord(value) &&
		(value.state === "complete" || value.state === "unsupported") &&
		(value.provider_kind === "lsp" || value.provider_kind === "syntax") &&
		typeof value.provider_name === "string" &&
		(value.provider_status === "ready" ||
			value.provider_status === "unsupported" ||
			value.provider_status === "unavailable") &&
		(value.provider_message === null || typeof value.provider_message === "string") &&
		typeof value.truncated === "number"
	);
}

function isStoredReferenceRow(value: unknown): value is StoredReferenceRow {
	return (
		isRecord(value) &&
		(value.kind === "definition" || value.kind === "reference") &&
		typeof value.file_id === "string" &&
		typeof value.file_path === "string" &&
		typeof value.line === "number" &&
		typeof value.column === "number" &&
		typeof value.snippet === "string"
	);
}

function isStoredCallTargetRow(value: unknown): value is StoredCallTargetRow {
	return (
		isRecord(value) &&
		typeof value.target_key === "string" &&
		(value.direction === "root" ||
			value.direction === "caller" ||
			value.direction === "callee") &&
		typeof value.name === "string" &&
		typeof value.kind === "number" &&
		(value.detail === null || typeof value.detail === "string") &&
		typeof value.file_id === "string" &&
		typeof value.file_path === "string" &&
		typeof value.line === "number" &&
		typeof value.column === "number" &&
		typeof value.snippet === "string"
	);
}

function isStoredCallSiteRow(value: unknown): value is StoredCallSiteRow {
	return (
		isRecord(value) &&
		typeof value.target_key === "string" &&
		typeof value.file_id === "string" &&
		typeof value.file_path === "string" &&
		typeof value.line === "number" &&
		typeof value.column === "number" &&
		typeof value.snippet === "string"
	);
}

async function sqliteDatabaseConstructor(): Promise<SqliteDatabaseConstructor> {
	if ("bun" in process.versions) {
		const bunSqliteSpecifier = "bun:sqlite";
		const module = await import(bunSqliteSpecifier);
		return module.Database as unknown as SqliteDatabaseConstructor;
	}
	const module = await import("node:sqlite");
	return module.DatabaseSync as unknown as SqliteDatabaseConstructor;
}

function initializeSchema(database: SqliteDatabase): void {
	database.exec(`
		PRAGMA journal_mode = DELETE;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 5000;
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS atlas_cache_metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	const row = database.prepare(
		"SELECT value FROM atlas_cache_metadata WHERE key = 'semantic_schema_version'",
	).get();
	const version = isRecord(row) && typeof row.value === "string"
		? Number(row.value)
		: null;
	if (version !== ATLAS_SEMANTIC_INDEX_SCHEMA_VERSION) {
		database.exec(`
			DROP TABLE IF EXISTS atlas_semantic_call_sites;
			DROP TABLE IF EXISTS atlas_semantic_call_targets;
			DROP TABLE IF EXISTS atlas_semantic_references;
			DROP TABLE IF EXISTS atlas_semantic_queries;
		`);
	}
	database.prepare(`
		INSERT INTO atlas_cache_metadata (key, value)
		VALUES ('semantic_schema_version', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`).run(String(ATLAS_SEMANTIC_INDEX_SCHEMA_VERSION));
	database.exec(`
		CREATE TABLE IF NOT EXISTS atlas_semantic_queries (
			query_key TEXT PRIMARY KEY,
			repository_fingerprint TEXT NOT NULL,
			snapshot_version INTEGER NOT NULL,
			provider_fingerprint TEXT NOT NULL,
			query_kind TEXT NOT NULL CHECK (query_kind IN ('references', 'calls')),
			file_path TEXT NOT NULL,
			line INTEGER NOT NULL,
			column_number INTEGER NOT NULL,
			symbol TEXT NOT NULL,
			atlas_symbol_id TEXT,
			state TEXT NOT NULL CHECK (state IN ('complete', 'unsupported')),
			provider_kind TEXT NOT NULL,
			provider_name TEXT NOT NULL,
			provider_status TEXT NOT NULL,
			provider_message TEXT,
			truncated INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS atlas_semantic_queries_generation
			ON atlas_semantic_queries (
				repository_fingerprint,
				snapshot_version,
				provider_fingerprint,
				query_kind
			);
		CREATE TABLE IF NOT EXISTS atlas_semantic_references (
			query_key TEXT NOT NULL REFERENCES atlas_semantic_queries(query_key)
				ON DELETE CASCADE,
			ordinal INTEGER NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('definition', 'reference')),
			file_id TEXT NOT NULL,
			file_path TEXT NOT NULL,
			line INTEGER NOT NULL,
			column_number INTEGER NOT NULL,
			snippet TEXT NOT NULL,
			PRIMARY KEY (query_key, ordinal)
		);
		CREATE INDEX IF NOT EXISTS atlas_semantic_references_location
			ON atlas_semantic_references (file_path, line, column_number);
		CREATE TABLE IF NOT EXISTS atlas_semantic_call_targets (
			target_key TEXT PRIMARY KEY,
			query_key TEXT NOT NULL REFERENCES atlas_semantic_queries(query_key)
				ON DELETE CASCADE,
			direction TEXT NOT NULL CHECK (direction IN ('root', 'caller', 'callee')),
			ordinal INTEGER NOT NULL,
			name TEXT NOT NULL,
			kind INTEGER NOT NULL,
			detail TEXT,
			file_id TEXT NOT NULL,
			file_path TEXT NOT NULL,
			line INTEGER NOT NULL,
			column_number INTEGER NOT NULL,
			snippet TEXT NOT NULL,
			UNIQUE (query_key, direction, ordinal)
		);
		CREATE INDEX IF NOT EXISTS atlas_semantic_call_targets_location
			ON atlas_semantic_call_targets (file_path, line, column_number);
		CREATE TABLE IF NOT EXISTS atlas_semantic_call_sites (
			target_key TEXT NOT NULL REFERENCES atlas_semantic_call_targets(target_key)
				ON DELETE CASCADE,
			ordinal INTEGER NOT NULL,
			file_id TEXT NOT NULL,
			file_path TEXT NOT NULL,
			line INTEGER NOT NULL,
			column_number INTEGER NOT NULL,
			snippet TEXT NOT NULL,
			PRIMARY KEY (target_key, ordinal)
		);
		CREATE INDEX IF NOT EXISTS atlas_semantic_call_sites_location
			ON atlas_semantic_call_sites (file_path, line, column_number);
	`);
}

function hashParts(parts: readonly (string | number)[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		const value = Buffer.from(String(part));
		const length = Buffer.allocUnsafe(4);
		length.writeUInt32BE(value.length);
		hash.update(length);
		hash.update(value);
	}
	return `sha256:${hash.digest("hex")}`;
}

function validateFingerprint(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must not be empty`);
	return trimmed;
}

function validatePosition(line: number, column: number): void {
	if (
		!Number.isInteger(line) ||
		line < 1 ||
		!Number.isInteger(column) ||
		column < 1
	) {
		throw new Error("Atlas semantic line and column must be positive integers");
	}
}

function validatePortablePath(filePath: string): string {
	const normalized = validateAtlasRelativePath(filePath);
	if (isAbsolute(normalized)) throw new Error("Semantic index paths must be relative");
	return normalized;
}

function queryKey(
	repositoryFingerprint: string,
	snapshotVersion: number,
	providerFingerprint: string,
	kind: QueryKind,
	filePath: string,
	line: number,
	column: number,
	symbol: string,
): string {
	return hashParts([
		repositoryFingerprint,
		snapshotVersion,
		providerFingerprint,
		kind,
		filePath,
		line,
		column,
		symbol,
	]);
}

function capabilityProvider(
	capability: AtlasSemanticCapability,
): AtlasSemanticProviderCapability {
	return {
		language: capability.language,
		name: capability.serverId,
		available: capability.available,
		...(capability.version && { version: capability.version }),
		...(capability.command && {
			source: process.env[capability.envVariable]?.trim() ? "env" : "path",
		}),
		...(capability.reason && { reason: capability.reason }),
	};
}

function providerFingerprint(capability: AtlasSemanticCapability): string {
	return hashParts([
		capability.language,
		capability.serverId,
		capability.version ?? "unavailable",
		...(capability.args ?? []),
		process.env[capability.envVariable]?.trim() ? "env-override" : "path",
		capability.available ? "available" : "unavailable",
	]);
}

function snapshotWithLiveProviders(
	snapshot: AtlasSnapshot,
	capabilities: Record<AtlasSemanticLanguage, AtlasSemanticCapability>,
): AtlasSnapshot {
	return {
		...snapshot,
		analyzers: {
			...snapshot.analyzers,
			semantic: {
				protocol: "lsp",
				providers: Object.values(capabilities).map(capabilityProvider),
			},
		},
	};
}

function languageForNode(node: AtlasNode): AtlasSemanticLanguage | null {
	switch (node.language) {
		case "rust":
		case "typescript":
		case "javascript":
		case "python":
		case "go":
		case "c":
		case "cpp":
		case "java":
		case "ruby":
			return node.language;
		default:
			return null;
	}
}

function stateForOutcome<T>(
	outcome: AtlasSemanticResolutionOutcome<T>,
): StoredQueryState | null {
	if (outcome.cacheability === "complete") return "complete";
	if (outcome.cacheability === "unsupported") return "unsupported";
	return null;
}

export class AtlasSemanticIndexStore {
	readonly indexPath: string;
	#database: SqliteDatabase | null;

	private constructor(indexPath: string, database: SqliteDatabase) {
		this.indexPath = indexPath;
		this.#database = database;
	}

	static async open(
		options: OpenAtlasSemanticIndexStoreOptions,
	): Promise<AtlasSemanticIndexStore> {
		const indexPath = resolve(options.indexPath);
		mkdirSync(dirname(indexPath), { recursive: true });
		const Database = await sqliteDatabaseConstructor();
		const database = new Database(indexPath);
		try {
			initializeSchema(database);
			return new AtlasSemanticIndexStore(indexPath, database);
		} catch (error) {
			database.close();
			throw error;
		}
	}

	getReferences(descriptor: QueryDescriptor): AtlasReferenceResponse | null {
		const query = this.#getQuery(descriptor);
		if (!query) return null;
		const rows = this.#database!.prepare(`
			SELECT kind, file_id, file_path, line, column_number AS column, snippet
			FROM atlas_semantic_references
			WHERE query_key = ?
			ORDER BY ordinal
		`).all(descriptor.queryKey);
		if (!rows.every(isStoredReferenceRow)) {
			this.deleteQuery(descriptor.queryKey);
			return null;
		}
		const locations = rows as StoredReferenceRow[];
		if (!locations.every((location) => this.#validStoredPath(location.file_path))) {
			this.deleteQuery(descriptor.queryKey);
			return null;
		}
		const convert = (location: StoredReferenceRow): AtlasReference => ({
			kind: location.kind,
			fileId: location.file_id,
			filePath: location.file_path,
			line: location.line,
			column: location.column,
			snippet: location.snippet,
		});
		return {
			definitions: locations.filter((item) => item.kind === "definition").map(convert),
			references: locations.filter((item) => item.kind === "reference").map(convert),
			provider: {
				kind: query.provider_kind,
				name: query.provider_name,
				status: query.provider_status === "unsupported"
					? "unavailable"
					: query.provider_status,
				...(query.provider_message && { message: query.provider_message }),
			},
		};
	}

	findReferencesAtLocation(
		descriptor: QueryDescriptor,
	): AtlasReferenceResponse | null {
		if (!this.#database) return null;
		const row = this.#database.prepare(`
			SELECT queries.query_key
			FROM atlas_semantic_queries AS queries
			INNER JOIN atlas_semantic_references AS locations
				ON locations.query_key = queries.query_key
			WHERE queries.repository_fingerprint = ?
				AND queries.snapshot_version = ?
				AND queries.provider_fingerprint = ?
				AND queries.query_kind = 'references'
				AND queries.symbol = ?
				AND locations.file_path = ?
				AND locations.line = ?
				AND locations.column_number = ?
			ORDER BY queries.created_at DESC
			LIMIT 1
		`).get(
			descriptor.repositoryFingerprint,
			descriptor.snapshotVersion,
			descriptor.providerFingerprint,
			descriptor.symbol,
			descriptor.filePath,
			descriptor.line,
			descriptor.column,
		);
		if (!isRecord(row) || typeof row.query_key !== "string") return null;
		return this.getReferences({ ...descriptor, queryKey: row.query_key });
	}

	getCalls(descriptor: QueryDescriptor): AtlasCallHierarchyResponse | null {
		const query = this.#getQuery(descriptor);
		if (!query) return null;
		const targets = this.#database!.prepare(`
			SELECT
				target_key,
				direction,
				name,
				kind,
				detail,
				file_id,
				file_path,
				line,
				column_number AS column,
				snippet
			FROM atlas_semantic_call_targets
			WHERE query_key = ?
			ORDER BY
				CASE direction WHEN 'root' THEN 0 WHEN 'caller' THEN 1 ELSE 2 END,
				ordinal
		`).all(descriptor.queryKey);
		if (
			!targets.every(isStoredCallTargetRow) ||
			!(targets as StoredCallTargetRow[]).every(
				(target) => this.#validStoredPath(target.file_path),
			)
		) {
			this.deleteQuery(descriptor.queryKey);
			return null;
		}
		const sites = this.#database!.prepare(`
			SELECT
				target_key,
				file_id,
				file_path,
				line,
				column_number AS column,
				snippet
			FROM atlas_semantic_call_sites
			WHERE target_key IN (
				SELECT target_key FROM atlas_semantic_call_targets WHERE query_key = ?
			)
			ORDER BY target_key, ordinal
		`).all(descriptor.queryKey);
		if (
			!sites.every(isStoredCallSiteRow) ||
			!(sites as StoredCallSiteRow[]).every(
				(site) => this.#validStoredPath(site.file_path),
			)
		) {
			this.deleteQuery(descriptor.queryKey);
			return null;
		}
		const sitesByTarget = new Map<string, StoredCallSiteRow[]>();
		for (const site of sites as StoredCallSiteRow[]) {
			const existing = sitesByTarget.get(site.target_key) ?? [];
			existing.push(site);
			sitesByTarget.set(site.target_key, existing);
		}
		const converted = new Map<string, AtlasCallHierarchyTarget>();
		for (const target of targets as StoredCallTargetRow[]) {
			converted.set(target.target_key, {
				name: target.name,
				kind: target.kind,
				...(target.detail && { detail: target.detail }),
				declaration: {
					fileId: target.file_id,
					filePath: target.file_path,
					line: target.line,
					column: target.column,
					snippet: target.snippet,
				},
				callSites: (sitesByTarget.get(target.target_key) ?? []).map((site) => ({
					fileId: site.file_id,
					filePath: site.file_path,
					line: site.line,
					column: site.column,
					snippet: site.snippet,
				})),
			});
		}
		const targetsByDirection = (direction: StoredCallTargetRow["direction"]) =>
			(targets as StoredCallTargetRow[])
				.filter((target) => target.direction === direction)
				.map((target) => converted.get(target.target_key)!);
		return {
			root: targetsByDirection("root")[0] ?? null,
			callers: targetsByDirection("caller"),
			callees: targetsByDirection("callee"),
			truncated: query.truncated === 1,
			provider: {
				kind: "lsp",
				name: query.provider_name,
				status: query.provider_status,
				...(query.provider_message && { message: query.provider_message }),
			},
		};
	}

	findCallsAtLocation(descriptor: QueryDescriptor): AtlasCallHierarchyResponse | null {
		if (!this.#database) return null;
		const row = this.#database.prepare(`
			SELECT query_key
			FROM (
				SELECT
					queries.query_key AS query_key,
					CASE targets.direction WHEN 'caller' THEN 0 WHEN 'root' THEN 1 ELSE 2 END
						AS priority,
					queries.created_at AS created_at
				FROM atlas_semantic_queries AS queries
				INNER JOIN atlas_semantic_call_targets AS targets
					ON targets.query_key = queries.query_key
				WHERE queries.repository_fingerprint = ?
					AND queries.snapshot_version = ?
					AND queries.provider_fingerprint = ?
					AND queries.query_kind = 'calls'
					AND targets.file_path = ?
					AND targets.line = ?
					AND targets.column_number = ?
				UNION ALL
				SELECT
					queries.query_key AS query_key,
					CASE targets.direction WHEN 'caller' THEN 0 ELSE 3 END AS priority,
					queries.created_at AS created_at
				FROM atlas_semantic_queries AS queries
				INNER JOIN atlas_semantic_call_targets AS targets
					ON targets.query_key = queries.query_key
				INNER JOIN atlas_semantic_call_sites AS sites
					ON sites.target_key = targets.target_key
				WHERE queries.repository_fingerprint = ?
					AND queries.snapshot_version = ?
					AND queries.provider_fingerprint = ?
					AND queries.query_kind = 'calls'
					AND sites.file_path = ?
					AND sites.line = ?
					AND sites.column_number = ?
			)
			ORDER BY priority, created_at DESC
			LIMIT 1
		`).get(
			descriptor.repositoryFingerprint,
			descriptor.snapshotVersion,
			descriptor.providerFingerprint,
			descriptor.filePath,
			descriptor.line,
			descriptor.column,
			descriptor.repositoryFingerprint,
			descriptor.snapshotVersion,
			descriptor.providerFingerprint,
			descriptor.filePath,
			descriptor.line,
			descriptor.column,
		);
		if (!isRecord(row) || typeof row.query_key !== "string") return null;
		return this.getCalls({ ...descriptor, queryKey: row.query_key });
	}

	setReferences(
		descriptor: QueryDescriptor,
		state: StoredQueryState,
		response: AtlasReferenceResponse,
	): void {
		const locations = [...response.definitions, ...response.references];
		for (const location of locations) validatePortablePath(location.filePath);
		this.#transaction(() => {
			this.#insertQuery(descriptor, state, response.provider, false);
			const statement = this.#database!.prepare(`
				INSERT INTO atlas_semantic_references (
					query_key, ordinal, kind, file_id, file_path, line, column_number, snippet
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`);
			locations.forEach((location, ordinal) => {
				statement.run(
					descriptor.queryKey,
					ordinal,
					location.kind,
					location.fileId,
					location.filePath,
					location.line,
					location.column,
					location.snippet,
				);
			});
		});
	}

	setCalls(
		descriptor: QueryDescriptor,
		state: StoredQueryState,
		response: AtlasCallHierarchyResponse,
	): void {
		const targets: Array<{
			direction: StoredCallTargetRow["direction"];
			target: AtlasCallHierarchyTarget;
		}> = [
			...(response.root ? [{ direction: "root" as const, target: response.root }] : []),
			...response.callers.map((target) => ({ direction: "caller" as const, target })),
			...response.callees.map((target) => ({ direction: "callee" as const, target })),
		];
		for (const { target } of targets) {
			validatePortablePath(target.declaration.filePath);
			for (const site of target.callSites) validatePortablePath(site.filePath);
		}
		this.#transaction(() => {
			this.#insertQuery(descriptor, state, response.provider, response.truncated);
			const targetStatement = this.#database!.prepare(`
				INSERT INTO atlas_semantic_call_targets (
					target_key, query_key, direction, ordinal, name, kind, detail,
					file_id, file_path, line, column_number, snippet
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
			const siteStatement = this.#database!.prepare(`
				INSERT INTO atlas_semantic_call_sites (
					target_key, ordinal, file_id, file_path, line, column_number, snippet
				) VALUES (?, ?, ?, ?, ?, ?, ?)
			`);
			const ordinalByDirection = new Map<StoredCallTargetRow["direction"], number>();
			for (const { direction, target } of targets) {
				const ordinal = ordinalByDirection.get(direction) ?? 0;
				ordinalByDirection.set(direction, ordinal + 1);
				const targetKey = hashParts([descriptor.queryKey, direction, ordinal]);
				targetStatement.run(
					targetKey,
					descriptor.queryKey,
					direction,
					ordinal,
					target.name,
					target.kind,
					target.detail ?? null,
					target.declaration.fileId,
					target.declaration.filePath,
					target.declaration.line,
					target.declaration.column,
					target.declaration.snippet,
				);
				target.callSites.forEach((site, siteOrdinal) => {
					siteStatement.run(
						targetKey,
						siteOrdinal,
						site.fileId,
						site.filePath,
						site.line,
						site.column,
						site.snippet,
					);
				});
			}
		});
	}

	deleteQuery(queryKeyValue: string): void {
		this.#database?.prepare(
			"DELETE FROM atlas_semantic_queries WHERE query_key = ?",
		).run(queryKeyValue);
	}

	close(): void {
		const database = this.#database;
		this.#database = null;
		database?.close();
	}

	#getQuery(descriptor: QueryDescriptor): StoredQueryRow | null {
		if (!this.#database) return null;
		const row = this.#database.prepare(`
			SELECT
				state,
				provider_kind,
				provider_name,
				provider_status,
				provider_message,
				truncated
			FROM atlas_semantic_queries
				WHERE query_key = ?
					AND repository_fingerprint = ?
					AND snapshot_version = ?
					AND provider_fingerprint = ?
					AND query_kind = ?
			`).get(
				descriptor.queryKey,
				descriptor.repositoryFingerprint,
				descriptor.snapshotVersion,
				descriptor.providerFingerprint,
				descriptor.kind,
			);
		return isStoredQueryRow(row) ? row : null;
	}

	#insertQuery(
		descriptor: QueryDescriptor,
		state: StoredQueryState,
		provider: AtlasReferenceResponse["provider"] | AtlasCallHierarchyResponse["provider"],
		truncated: boolean,
	): void {
		this.#database!.prepare(
			"DELETE FROM atlas_semantic_queries WHERE query_key = ?",
		).run(descriptor.queryKey);
		this.#database!.prepare(`
			INSERT INTO atlas_semantic_queries (
				query_key,
				repository_fingerprint,
				snapshot_version,
				provider_fingerprint,
				query_kind,
				file_path,
				line,
				column_number,
				symbol,
				atlas_symbol_id,
				state,
				provider_kind,
				provider_name,
				provider_status,
				provider_message,
				truncated,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			descriptor.queryKey,
			descriptor.repositoryFingerprint,
			descriptor.snapshotVersion,
			descriptor.providerFingerprint,
			descriptor.kind,
			descriptor.filePath,
			descriptor.line,
			descriptor.column,
			descriptor.symbol,
			descriptor.atlasSymbolId,
			state,
			provider.kind,
			provider.name,
			provider.status,
			provider.message ?? null,
			truncated ? 1 : 0,
			new Date().toISOString(),
		);
	}

	#transaction(action: () => void): void {
		if (!this.#database) throw new Error("Atlas semantic index store is closed");
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			action();
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	#validStoredPath(filePath: string): boolean {
		try {
			return validatePortablePath(filePath) === filePath;
		} catch {
			return false;
		}
	}
}

export class AtlasSemanticIndexService {
	readonly rootPath: string;
	readonly indexPath: string;
	readonly capabilities: Record<AtlasSemanticLanguage, AtlasSemanticCapability>;

	#store: AtlasSemanticIndexStore;
	#session: AtlasSemanticSession;
	#ownsSession: boolean;
	#disposed = false;

	private constructor(
		rootPath: string,
		store: AtlasSemanticIndexStore,
		session: AtlasSemanticSession,
		ownsSession: boolean,
		capabilities: Record<AtlasSemanticLanguage, AtlasSemanticCapability>,
	) {
		this.rootPath = rootPath;
		this.indexPath = store.indexPath;
		this.#store = store;
		this.#session = session;
		this.#ownsSession = ownsSession;
		this.capabilities = capabilities;
	}

	static async open(
		options: OpenAtlasSemanticIndexServiceOptions,
	): Promise<AtlasSemanticIndexService> {
		const rootPath = realpathSync.native(resolve(options.rootPath));
		const [store, capabilities] = await Promise.all([
			AtlasSemanticIndexStore.open({ indexPath: options.indexPath }),
			options.capabilities
				? Promise.resolve(options.capabilities)
				: probeAtlasSemanticCapabilities(options.semanticSessionOptions),
		]);
		const session = options.session ??
			new AtlasSemanticSession(options.semanticSessionOptions);
		return new AtlasSemanticIndexService(
			rootPath,
			store,
			session,
			options.session === undefined,
			capabilities,
		);
	}

	async resolveReferences(
		input: AtlasSemanticReferenceInput,
	): Promise<AtlasSemanticLookup<AtlasReferenceResponse>> {
		this.#assertActive();
			const descriptor = this.#descriptor("references", input, input.symbol);
			const cached = this.#store.getReferences(descriptor)
				?? this.#store.findReferencesAtLocation(descriptor);
		if (cached) {
			return {
				response: cached,
				source: "cache",
				cacheability: "complete",
			};
		}
		const outcome = await resolveAtlasReferencesOutcome(
			this.#session,
			this.rootPath,
			snapshotWithLiveProviders(input.snapshot, this.capabilities),
			input.symbol,
			descriptor.filePath,
			descriptor.line,
			descriptor.column,
			input.signal,
		);
		const state = stateForOutcome(outcome);
		if (state) this.#store.setReferences(descriptor, state, outcome.response);
		return {
			response: outcome.response,
			source: "live",
			cacheability: outcome.cacheability,
		};
	}

	async resolveCalls(
		input: AtlasSemanticQueryInput,
	): Promise<AtlasSemanticLookup<AtlasCallHierarchyResponse>> {
		this.#assertActive();
			const descriptor = this.#descriptor("calls", input, "");
			const cached = this.#store.getCalls(descriptor)
				?? this.#store.findCallsAtLocation(descriptor);
		if (cached) {
			return {
				response: cached,
				source: "cache",
				cacheability: cached.provider.status === "unsupported"
					? "unsupported"
					: "complete",
			};
		}
		const outcome = await resolveAtlasCallHierarchyOutcome(
			this.#session,
			this.rootPath,
			snapshotWithLiveProviders(input.snapshot, this.capabilities),
			descriptor.filePath,
			descriptor.line,
			descriptor.column,
			input.signal,
		);
		const state = stateForOutcome(outcome);
		if (state) this.#store.setCalls(descriptor, state, outcome.response);
		return {
			response: outcome.response,
			source: "live",
			cacheability: outcome.cacheability,
		};
	}

	async indexAll(
		options: AtlasSemanticIndexAllOptions,
	): Promise<AtlasSemanticIndexProgress> {
		this.#assertActive();
		validateFingerprint(options.repositoryFingerprint, "Repository fingerprint");
		const work = options.snapshot.nodes
			.filter((node) => node.kind === "file" && languageForNode(node) !== null)
			.flatMap((node) =>
				node.symbols.flatMap((symbol) => [
					{ kind: "references" as const, node, symbol },
					...(
						symbol.kind === "function" || symbol.kind === "method"
							? [{ kind: "calls" as const, node, symbol }]
							: []
					),
				]),
			);
		const progress: AtlasSemanticIndexProgress = {
			total: work.length,
			completed: 0,
			cached: 0,
			resolved: 0,
			unsupported: 0,
			failed: 0,
		};
		options.onProgress?.({ ...progress });

		for (const item of work) {
			options.signal?.throwIfAborted();
			const language = languageForNode(item.node)!;
			progress.current = {
				kind: item.kind,
				filePath: item.node.path,
				symbol: item.symbol.name,
				language,
			};
			let result: AtlasSemanticLookup<
				AtlasReferenceResponse | AtlasCallHierarchyResponse
			>;
			if (item.kind === "references") {
				result = await this.resolveReferences({
					snapshot: options.snapshot,
					repositoryFingerprint: options.repositoryFingerprint,
					symbol: item.symbol.name,
					filePath: item.node.path,
					line: item.symbol.line,
					column: item.symbol.column,
					atlasSymbolId: item.symbol.id,
					signal: options.signal,
				});
			} else {
				result = await this.resolveCalls({
					snapshot: options.snapshot,
					repositoryFingerprint: options.repositoryFingerprint,
					filePath: item.node.path,
					line: item.symbol.line,
					column: item.symbol.column,
					atlasSymbolId: item.symbol.id,
					signal: options.signal,
				});
			}
			progress.completed += 1;
			if (result.source === "cache") progress.cached += 1;
			else if (result.cacheability === "complete") progress.resolved += 1;
			else if (result.cacheability === "unsupported") progress.unsupported += 1;
			else progress.failed += 1;
			options.onProgress?.({ ...progress, current: { ...progress.current } });
		}
		delete progress.current;
		options.onProgress?.({ ...progress });
		return progress;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#store.close();
		if (this.#ownsSession) await this.#session.dispose();
	}

	#descriptor(
		kind: QueryKind,
		input: AtlasSemanticQueryInput,
		symbol: string,
	): QueryDescriptor {
		const repositoryFingerprint = validateFingerprint(
			input.repositoryFingerprint,
			"Repository fingerprint",
		);
		validatePosition(input.line, input.column);
		const filePath = validatePortablePath(input.filePath);
		const node = input.snapshot.nodes.find(
			(candidate) => candidate.kind === "file" && candidate.path === filePath,
		);
		if (!node) throw new Error("Atlas source file is not indexed");
		const language = languageForNode(node);
		if (!language) throw new Error(`No semantic provider supports ${node.language ?? "text"}`);
		const capability = this.capabilities[language];
		const provider = providerFingerprint(capability);
		return {
			queryKey: queryKey(
				repositoryFingerprint,
				input.snapshot.version,
				provider,
				kind,
				filePath,
				input.line,
				input.column,
				symbol,
			),
			repositoryFingerprint,
			snapshotVersion: input.snapshot.version,
			providerFingerprint: provider,
			kind,
			filePath,
			line: input.line,
			column: input.column,
			symbol,
			atlasSymbolId: input.atlasSymbolId ?? null,
		};
	}

	#assertActive(): void {
		if (this.#disposed) {
			throw new Error("Atlas semantic index service is disposed");
		}
	}
}

export function isAtlasSemanticCallable(symbol: AtlasSymbol): boolean {
	return symbol.kind === "function" || symbol.kind === "method";
}
