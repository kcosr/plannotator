import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	ATLAS_SNAPSHOT_VERSION,
	type AtlasSnapshot,
} from "./atlas";
import {
	AtlasRepositoryFingerprintCache,
	collectAtlasRepositoryFingerprint,
	type AtlasRepositoryFingerprintOptions,
} from "./atlas-repository-fingerprint";
import {
	AtlasSnapshotCache,
	openAtlasSnapshotCache,
	type OpenAtlasSnapshotCacheOptions,
} from "./atlas-snapshot-cache";

const MAX_STABILITY_ATTEMPTS = 3;

export interface AtlasIndexSessionStatus {
	status: "indexing" | "ready" | "error";
	phase: "checking" | "indexing" | "ready" | "error";
	hasSnapshot: boolean;
	revision: number;
	source?: "cache" | "fresh";
	refreshing: boolean;
	persistent: boolean;
	persistenceError?: string;
	error?: string;
}

export interface AtlasSnapshotBuildContext {
	rootPath: string;
	repositoryFingerprint: string;
	forced: boolean;
	signal: AbortSignal;
}

export interface AtlasSnapshotGeneration {
	snapshot: AtlasSnapshot;
	repositoryFingerprint: string;
}

export interface OpenAtlasIndexSessionOptions {
	rootPath: string;
	buildSnapshot: (context: AtlasSnapshotBuildContext) => Promise<AtlasSnapshot>;
	cache?: AtlasSnapshotCache;
	cacheOptions?: Omit<OpenAtlasSnapshotCacheOptions, "rootPath">;
	fingerprintOptions?: AtlasRepositoryFingerprintOptions;
	collectFingerprint?: (
		rootPath: string,
		signal?: AbortSignal,
	) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAtlasSnapshot(value: unknown): value is AtlasSnapshot {
	return (
		isRecord(value) &&
		value.version === ATLAS_SNAPSHOT_VERSION &&
		typeof value.rootName === "string" &&
		typeof value.rootId === "string" &&
		typeof value.generatedAt === "string" &&
		Array.isArray(value.nodes) &&
		Array.isArray(value.dependencies) &&
		isRecord(value.summary) &&
		isRecord(value.analyzers)
	);
}

export class AtlasIndexSession {
	readonly rootPath: string;

	#buildSnapshot: OpenAtlasIndexSessionOptions["buildSnapshot"];
	#cache: AtlasSnapshotCache;
	#collectFingerprint: (
		rootPath: string,
		signal?: AbortSignal,
	) => Promise<string>;
	#snapshot: AtlasSnapshot | undefined;
	#snapshotFingerprint: string | undefined;
	#status: AtlasIndexSessionStatus;
	#activeWork: Promise<void> | undefined;
	#activeAbortController: AbortController | undefined;
	#forcedRunQueued = false;
	#started = false;
	#disposed = false;

	private constructor(
		rootPath: string,
		options: OpenAtlasIndexSessionOptions,
		cache: AtlasSnapshotCache,
	) {
		this.rootPath = rootPath;
		this.#buildSnapshot = options.buildSnapshot;
		this.#cache = cache;
		const fingerprintCache = new AtlasRepositoryFingerprintCache();
		this.#collectFingerprint = options.collectFingerprint ??
			(async (repositoryRoot, signal) =>
				(await collectAtlasRepositoryFingerprint(
					repositoryRoot,
					{
						...options.fingerprintOptions,
						signal,
						contentCache: fingerprintCache,
						excludedPaths: [
							...(options.fingerprintOptions?.excludedPaths ?? []),
							cache.indexPath,
						],
					},
				)).fingerprint);

		this.#status = {
			status: "indexing",
			phase: "checking",
			hasSnapshot: false,
			revision: 0,
			refreshing: false,
			persistent: cache.available,
			...(cache.initializationError && {
				persistenceError: cache.initializationError,
			}),
		};
	}

	static async open(
		options: OpenAtlasIndexSessionOptions,
	): Promise<AtlasIndexSession> {
		const rootPath = await realpath(resolve(options.rootPath));
		const cache = options.cache ?? await openAtlasSnapshotCache({
			...options.cacheOptions,
			rootPath,
		});
		return new AtlasIndexSession(rootPath, options, cache);
	}

	start(): void {
		if (this.#disposed || this.#started) return;
		this.#started = true;
		void this.#schedule(false);
	}

	reindex(): Promise<void> {
		if (this.#disposed) {
			return Promise.reject(new Error("Atlas index session is disposed"));
		}
		this.#started = true;
		return this.#schedule(true);
	}

	getStatus(): AtlasIndexSessionStatus {
		return { ...this.#status };
	}

	get indexPath(): string {
		return this.#cache.indexPath;
	}

	getSnapshot(): AtlasSnapshot | undefined {
		return this.#snapshot;
	}

	getSnapshotGeneration(): AtlasSnapshotGeneration | undefined {
		if (!this.#snapshot || !this.#snapshotFingerprint) return undefined;
		return {
			snapshot: this.#snapshot,
			repositoryFingerprint: this.#snapshotFingerprint,
		};
	}

	async verifyRepositoryFingerprint(
		expectedFingerprint: string,
		signal?: AbortSignal,
	): Promise<void> {
		if (this.#disposed) {
			throw new Error("Atlas index session is disposed");
		}
		const currentFingerprint = await this.#collectFingerprint(
			this.rootPath,
			signal,
		);
		if (currentFingerprint !== expectedFingerprint) {
			throw new Error("Repository changed since the Atlas index was generated");
		}
	}

	async waitUntilIdle(): Promise<void> {
		await this.#activeWork;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) {
			await this.#activeWork;
			return;
		}
		this.#disposed = true;
		this.#forcedRunQueued = false;
		this.#activeAbortController?.abort(
			new Error("Atlas index session was disposed"),
		);
		await this.#activeWork;
		this.#cache.close();
	}

	#schedule(force: boolean): Promise<void> {
		if (force) this.#forcedRunQueued = true;
		if (this.#activeWork) return this.#activeWork;

		const initialForce = this.#forcedRunQueued;
		this.#forcedRunQueued = false;
		const controller = new AbortController();
		this.#activeAbortController = controller;
		const work = this.#runLoop(initialForce, controller.signal);
		this.#activeWork = work;
		const clearActiveWork = () => {
			if (this.#activeWork === work) {
				this.#activeWork = undefined;
				this.#activeAbortController = undefined;
			}
		};
		void work.then(clearActiveWork, clearActiveWork);
		return work;
	}

	async #runLoop(initialForce: boolean, signal: AbortSignal): Promise<void> {
		let force = initialForce;
		do {
			await this.#runOnce(force, signal);
			if (this.#disposed) return;
			force = this.#forcedRunQueued;
			this.#forcedRunQueued = false;
		} while (force);
	}

	async #runOnce(force: boolean, signal: AbortSignal): Promise<void> {
		this.#status = {
			status: "indexing",
			phase: "checking",
			hasSnapshot: Boolean(this.#snapshot),
			revision: this.#status.revision,
			...(this.#status.source && { source: this.#status.source }),
			refreshing: true,
			persistent: this.#status.persistent,
			...(this.#status.persistenceError && {
				persistenceError: this.#status.persistenceError,
			}),
		};
		try {
			signal.throwIfAborted();
			let repositoryFingerprint = await this.#collectFingerprint(
				this.rootPath,
				signal,
			);
			if (this.#disposed) return;
			if (!force && !this.#snapshot) {
				const cached = this.#cache.get({
					repositoryFingerprint,
					snapshotVersion: ATLAS_SNAPSHOT_VERSION,
				}, isAtlasSnapshot);
				if (cached) {
					this.#snapshot = bindSnapshotToRepository(
						cached.snapshot,
						this.rootPath,
					);
					this.#snapshotFingerprint = repositoryFingerprint;
					this.#status = {
						status: "ready",
						phase: "ready",
						hasSnapshot: true,
						revision: this.#status.revision + 1,
						source: "cache",
						refreshing: false,
						persistent: this.#cache.available,
						...(this.#cache.lastError && {
							persistenceError: this.#cache.lastError,
						}),
					};
					return;
				}
			}
			if (
				!force &&
				this.#snapshot &&
				this.#snapshotFingerprint === repositoryFingerprint
			) {
				this.#status = {
					status: "ready",
					phase: "ready",
					hasSnapshot: true,
					revision: this.#status.revision,
					source: this.#status.source ?? "cache",
					refreshing: false,
					persistent: this.#status.persistent,
					...(this.#status.persistenceError && {
						persistenceError: this.#status.persistenceError,
					}),
				};
				return;
			}

			this.#status = {
				status: "indexing",
				phase: "indexing",
				hasSnapshot: Boolean(this.#snapshot),
				revision: this.#status.revision,
				...(this.#status.source && { source: this.#status.source }),
				refreshing: true,
				persistent: this.#status.persistent,
				...(this.#status.persistenceError && {
					persistenceError: this.#status.persistenceError,
				}),
			};
			let nextSnapshot: AtlasSnapshot | undefined;
			for (let attempt = 1; attempt <= MAX_STABILITY_ATTEMPTS; attempt += 1) {
				nextSnapshot = await this.#buildSnapshot({
					rootPath: this.rootPath,
					repositoryFingerprint,
					forced: force,
					signal,
				});
				if (this.#disposed) return;
				signal.throwIfAborted();
				const afterBuildFingerprint = await this.#collectFingerprint(
					this.rootPath,
					signal,
				);
				if (afterBuildFingerprint === repositoryFingerprint) break;
				if (attempt === MAX_STABILITY_ATTEMPTS) {
					throw new Error("Repository kept changing while Atlas was indexing");
				}
				repositoryFingerprint = afterBuildFingerprint;
			}
			if (this.#disposed) return;
			if (
				!nextSnapshot ||
				!isAtlasSnapshot(nextSnapshot)
			) {
				throw new Error("Atlas snapshot builder returned an invalid snapshot");
			}

			const persistent = this.#cache.set({
				repositoryFingerprint,
				snapshotVersion: ATLAS_SNAPSHOT_VERSION,
			}, nextSnapshot);
			this.#snapshot = nextSnapshot;
			this.#snapshotFingerprint = repositoryFingerprint;
			this.#status = {
				status: "ready",
				phase: "ready",
				hasSnapshot: true,
				revision: this.#status.revision + 1,
				source: "fresh",
				refreshing: false,
				persistent,
				...(!persistent && {
					persistenceError: this.#cache.lastError ??
						"Atlas snapshot could not be persisted",
				}),
			};
		} catch (error) {
			if (this.#disposed) return;
			this.#status = {
				status: "error",
				phase: "error",
				hasSnapshot: Boolean(this.#snapshot),
				revision: this.#status.revision,
				...(this.#status.source && { source: this.#status.source }),
				refreshing: false,
				persistent: this.#status.persistent,
				...(this.#status.persistenceError && {
					persistenceError: this.#status.persistenceError,
				}),
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

function bindSnapshotToRepository(
	snapshot: AtlasSnapshot,
	rootPath: string,
): AtlasSnapshot {
	const rootName = basename(rootPath);
	return {
		...snapshot,
		rootName,
		nodes: snapshot.nodes.map((node) =>
			node.id === snapshot.rootId
				? { ...node, name: rootName }
				: node),
	};
}
