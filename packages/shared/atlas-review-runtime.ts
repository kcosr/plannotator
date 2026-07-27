import { realpathSync, statSync } from "node:fs";
import {
	buildAtlasSnapshot,
	readAtlasSource,
	type AtlasSemanticProviderCapability,
	type AtlasSnapshot,
} from "./atlas";
import {
	AtlasIndexSession,
	type AtlasIndexSessionStatus,
} from "./atlas-index-session";
import {
	AtlasSemanticIndexService,
} from "./atlas-semantic-index";
import {
	AtlasSemanticSession,
	probeAtlasSemanticCapabilities,
} from "./atlas-semantic";
import type {
	AtlasCallHierarchyResponse,
	AtlasReferenceResponse,
	AtlasSourceFile,
} from "./atlas-source";

export type AtlasReviewCapabilityCode =
	| "no-local-checkout"
	| "checkout-pending"
	| "multi-root-workspace";

export type AtlasReviewRootResolution =
	| { kind: "ready"; rootPath: string; bindingKey: string }
	| {
			kind: "unavailable";
			code: AtlasReviewCapabilityCode;
			message: string;
			retryable: boolean;
		};

export interface AtlasReviewCapability {
	available: boolean;
	code?: AtlasReviewCapabilityCode;
	message?: string;
	retryable?: boolean;
}

export interface AtlasReviewPendingStatus extends AtlasIndexSessionStatus {
	capability: AtlasReviewCapability;
}

export interface AtlasReviewUnavailableStatus {
	error: string;
	capability: AtlasReviewCapability & {
		available: false;
		code: Exclude<AtlasReviewCapabilityCode, "checkout-pending">;
		message: string;
		retryable: false;
	};
}

export class AtlasReviewUnavailableError extends Error {
	readonly resolution: Extract<AtlasReviewRootResolution, { kind: "unavailable" }>;

	constructor(resolution: Extract<AtlasReviewRootResolution, { kind: "unavailable" }>) {
		super(resolution.message);
		this.name = "AtlasReviewUnavailableError";
		this.resolution = resolution;
	}
}

interface AtlasReviewRuntime {
	bindingKey: string;
	rootPath: string;
	indexSession: AtlasIndexSession;
	semanticIndex: Promise<AtlasSemanticIndexService>;
	semanticSession: AtlasSemanticSession;
}

async function buildReviewAtlasSnapshot(
	rootPath: string,
	signal?: AbortSignal,
): Promise<AtlasSnapshot> {
	const capabilities = await probeAtlasSemanticCapabilities({ signal });
	const semanticProviders: AtlasSemanticProviderCapability[] =
		Object.values(capabilities).map((capability) => ({
			language: capability.language,
			name: capability.serverId,
			available: capability.available,
			...(capability.version && { version: capability.version }),
			...(capability.command && {
				source: process.env[capability.envVariable]?.trim() ? "env" : "path",
			}),
			...(capability.reason && { reason: capability.reason }),
		}));
	return buildAtlasSnapshot(rootPath, { semanticProviders, signal });
}

function unavailableStatus(
	resolution: Extract<AtlasReviewRootResolution, { kind: "unavailable" }>,
): AtlasReviewUnavailableStatus {
	if (resolution.code === "checkout-pending") {
		throw new Error("Pending checkout must use pendingStatus");
	}
	return {
		error: resolution.message,
		capability: {
			available: false,
			code: resolution.code,
			message: resolution.message,
			retryable: false,
		},
	};
}

export function pendingAtlasReviewStatus(
	resolution: Extract<AtlasReviewRootResolution, { kind: "unavailable" }>,
): AtlasReviewPendingStatus {
	return {
		status: "indexing",
		phase: "checking",
		hasSnapshot: false,
		revision: 0,
		refreshing: true,
		persistent: false,
		capability: {
			available: false,
			code: resolution.code,
			message: resolution.message,
			retryable: true,
		},
	};
}

export function atlasReviewUnavailableStatus(
	error: AtlasReviewUnavailableError,
): AtlasReviewUnavailableStatus {
	return unavailableStatus(error.resolution);
}

export class AtlasReviewRuntimeManager {
	readonly #resolveRoot: () => AtlasReviewRootResolution;
	#runtime: AtlasReviewRuntime | undefined;
	#transition: Promise<void> = Promise.resolve();
	#disposed = false;

	constructor(resolveRoot: () => AtlasReviewRootResolution) {
		this.#resolveRoot = resolveRoot;
	}

	resolveRoot(): AtlasReviewRootResolution {
		return this.#resolveRoot();
	}

	async status(): Promise<AtlasReviewPendingStatus> {
		const resolution = this.#resolveRoot();
		if (resolution.kind === "unavailable") {
			await this.#dropRuntime();
			if (resolution.code === "checkout-pending") {
				return pendingAtlasReviewStatus(resolution);
			}
			throw new AtlasReviewUnavailableError(resolution);
		}
		const runtime = await this.#runtimeFor(resolution);
		return {
			...runtime.indexSession.getStatus(),
			capability: { available: true },
		};
	}

	async snapshot(): Promise<{
		status: AtlasIndexSessionStatus;
		snapshot: AtlasSnapshot | undefined;
	}> {
		const runtime = await this.#requiredRuntime();
		return {
			status: runtime.indexSession.getStatus(),
			snapshot: runtime.indexSession.getSnapshot(),
		};
	}

	async source(filePath: string): Promise<AtlasSourceFile> {
		const runtime = await this.#requiredRuntime();
		return readAtlasSource(runtime.rootPath, filePath);
	}

	async references(input: {
		symbol: string;
		filePath: string;
		line: number;
		column: number;
		signal?: AbortSignal;
	}): Promise<AtlasReferenceResponse | AtlasIndexSessionStatus> {
		const runtime = await this.#requiredRuntime();
		const generation = runtime.indexSession.getSnapshotGeneration();
		if (!generation) return runtime.indexSession.getStatus();
		return (await (await runtime.semanticIndex).resolveReferences({
			snapshot: generation.snapshot,
			repositoryFingerprint: generation.repositoryFingerprint,
			...input,
		})).response;
	}

	async calls(input: {
		filePath: string;
		line: number;
		column: number;
		signal?: AbortSignal;
	}): Promise<AtlasCallHierarchyResponse | AtlasIndexSessionStatus> {
		const runtime = await this.#requiredRuntime();
		const generation = runtime.indexSession.getSnapshotGeneration();
		if (!generation) return runtime.indexSession.getStatus();
		return (await (await runtime.semanticIndex).resolveCalls({
			snapshot: generation.snapshot,
			repositoryFingerprint: generation.repositoryFingerprint,
			...input,
		})).response;
	}

	async reindex(): Promise<AtlasIndexSessionStatus> {
		const runtime = await this.#requiredRuntime();
		void runtime.indexSession.reindex();
		return runtime.indexSession.getStatus();
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		await this.#dropRuntime();
	}

	async #requiredRuntime(): Promise<AtlasReviewRuntime> {
		const resolution = this.#resolveRoot();
		if (resolution.kind === "unavailable") {
			await this.#dropRuntime();
			throw new AtlasReviewUnavailableError(resolution);
		}
		return this.#runtimeFor(resolution);
	}

	async #runtimeFor(
		resolution: Extract<AtlasReviewRootResolution, { kind: "ready" }>,
	): Promise<AtlasReviewRuntime> {
		if (this.#disposed) throw new Error("Atlas review runtime is disposed");
		let result: AtlasReviewRuntime | undefined;
		const transition = this.#transition.then(async () => {
			if (this.#disposed) throw new Error("Atlas review runtime is disposed");
			if (this.#runtime?.bindingKey === resolution.bindingKey) {
				result = this.#runtime;
				return;
			}
			await this.#disposeRuntime();
			let rootPath: string;
			try {
				rootPath = realpathSync.native(resolution.rootPath);
				if (!statSync(rootPath).isDirectory()) throw new Error("not a directory");
			} catch {
				throw new AtlasReviewUnavailableError({
					kind: "unavailable",
					code: "no-local-checkout",
					message: "The active review checkout is not available on disk.",
					retryable: false,
				});
			}
			const semanticSession = new AtlasSemanticSession();
			const indexSession = await AtlasIndexSession.open({
				rootPath,
				buildSnapshot: ({ rootPath: repositoryRoot, signal }) =>
					buildReviewAtlasSnapshot(repositoryRoot, signal),
			});
			const semanticIndex = AtlasSemanticIndexService.open({
				rootPath,
				indexPath: indexSession.indexPath,
				session: semanticSession,
				verifyRepositoryFingerprint: (expectedFingerprint, signal) =>
					indexSession.verifyRepositoryFingerprint(expectedFingerprint, signal),
			});
			void semanticIndex.catch(() => {});
			this.#runtime = {
				bindingKey: resolution.bindingKey,
				rootPath,
				indexSession,
				semanticIndex,
				semanticSession,
			};
			indexSession.start();
			result = this.#runtime;
		});
		this.#transition = transition.then(() => {}, () => {});
		await transition;
		return result!;
	}

	async #dropRuntime(): Promise<void> {
		const transition = this.#transition.then(() => this.#disposeRuntime());
		this.#transition = transition.then(() => {}, () => {});
		await transition;
	}

	async #disposeRuntime(): Promise<void> {
		const runtime = this.#runtime;
		this.#runtime = undefined;
		if (!runtime) return;
		await Promise.all([
			runtime.indexSession.dispose(),
			runtime.semanticIndex.then(
				(service) => service.dispose(),
				() => undefined,
			),
			runtime.semanticSession.dispose(),
		]);
	}
}
