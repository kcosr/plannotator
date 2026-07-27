import { realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
	buildAtlasSnapshot,
	readAtlasSource,
	type AtlasSemanticProviderCapability,
	type AtlasSnapshot,
} from "../generated/atlas.ts";
import {
	AtlasIndexSession,
	type AtlasIndexSessionStatus,
} from "../generated/atlas-index-session.ts";
import { AtlasSemanticIndexService } from "../generated/atlas-semantic-index.ts";
import {
	AtlasSemanticSession,
	probeAtlasSemanticCapabilities,
} from "../generated/atlas-semantic.ts";
import { isAIEndpointPath } from "../generated/ai/endpoints.ts";
import { resolveAIEnabled } from "../generated/config.ts";
import {
	createPiAIRuntime,
	handlePiAIRequest,
	AI_QUERY_ENDPOINT,
	type PiAIRuntime,
} from "./ai-runtime.ts";
import { handleFavicon } from "./handlers.ts";
import { html, json, requestUrl } from "./helpers.ts";
import { isRemoteSession, listenOnPort } from "./network.ts";
import type { CodeAnnotation } from "../generated/code-annotation.ts";

export type AtlasIndexStatus = AtlasIndexSessionStatus["status"];

export interface ExploreServerResult {
	port: number;
	portSource: "env" | "remote-default" | "random";
	url: string;
	isRemote: boolean;
	waitForClose: () => Promise<void>;
	waitForFeedback: () => Promise<AtlasFeedbackResult | null>;
	stop: () => Promise<void>;
}

export interface AtlasFeedbackResult {
	annotations: CodeAnnotation[];
	markdown: string;
}

async function buildIndexedAtlasSnapshot(rootPath: string): Promise<AtlasSnapshot> {
	const capabilities = await probeAtlasSemanticCapabilities();
	const semanticProviders: AtlasSemanticProviderCapability[] = Object.values(capabilities)
		.map((capability) => ({
			language: capability.language,
			name: capability.serverId,
			available: capability.available,
			...(capability.command && {
				source: process.env[capability.envVariable]?.trim() ? "env" : "path",
			}),
			...(capability.version && { version: capability.version }),
			...(capability.reason && { reason: capability.reason }),
		}));
	return buildAtlasSnapshot(rootPath, { semanticProviders });
}

async function warmAtlasSemantics(
	semanticSession: AtlasSemanticSession,
	rootPath: string,
	snapshot: AtlasSnapshot,
): Promise<void> {
	const capabilities = await probeAtlasSemanticCapabilities();
	const languages = Object.values(capabilities)
		.filter(
			(capability) =>
				capability.available &&
				Boolean(snapshot.summary.languages[capability.language]),
		)
		.map((capability) => capability.language);
	await semanticSession.warmLanguages(rootPath, languages);
}

function isWithinDirectory(candidate: string, root: string): boolean {
	const fromRoot = relative(root, candidate);
	return (
		fromRoot === "" ||
		(fromRoot !== ".." &&
			!fromRoot.startsWith(`..${sep}`) &&
			!isAbsolute(fromRoot))
	);
}

function normalizeSourcePath(rootPath: string, requestedPath: string): string | null {
	if (!requestedPath || isAbsolute(requestedPath)) return null;

	try {
		const realCandidate = realpathSync(resolve(rootPath, requestedPath));
		if (!isWithinDirectory(realCandidate, rootPath) || !statSync(realCandidate).isFile()) {
			return null;
		}
		const relativePath = relative(rootPath, realCandidate);
		if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
			return null;
		}
		return relativePath.replace(/\\/g, "/");
	} catch {
		return null;
	}
}

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const keys = Object.keys(value);
	return required.every((key) => key in value)
		&& keys.every((key) => required.includes(key) || optional.includes(key));
}

async function readRequestJson(req: import("node:http").IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function parseAtlasFeedback(
	req: import("node:http").IncomingMessage,
	rootPath: string,
): Promise<AtlasFeedbackResult | string> {
	let body: unknown;
	try {
		body = await readRequestJson(req);
	} catch {
		return "Request body must be valid JSON";
	}
	if (
		!body
		|| typeof body !== "object"
		|| Array.isArray(body)
		|| !hasExactKeys(body as Record<string, unknown>, ["annotations", "markdown"])
	) {
		return "Request body must contain exactly annotations and markdown";
	}

	const { annotations, markdown } = body as Record<string, unknown>;
	if (!Array.isArray(annotations) || typeof markdown !== "string") {
		return "Annotations must be an array and markdown must be a string";
	}

	const parsed: CodeAnnotation[] = [];
	const ids = new Set<string>();
	for (const value of annotations) {
		if (
			!value
			|| typeof value !== "object"
			|| Array.isArray(value)
			|| !hasExactKeys(
				value as Record<string, unknown>,
				[
					"id", "type", "scope", "filePath", "lineStart", "lineEnd", "side",
					"text", "createdAt", "source", "atlasSnapshotGeneratedAt",
				],
				["originalCode"],
			)
		) {
			return "Each annotation must contain the expected Atlas annotation fields";
		}
		const annotation = value as Record<string, unknown>;
		const {
			id,
			type,
			scope,
			filePath,
			lineStart,
			lineEnd,
			side,
			text,
			originalCode,
			createdAt,
			source,
			atlasSnapshotGeneratedAt,
		} = annotation;
		if (
			typeof id !== "string"
			|| id.length === 0
			|| ids.has(id)
			|| type !== "comment"
			|| scope !== "line"
			|| typeof filePath !== "string"
			|| typeof text !== "string"
			|| side !== "new"
			|| typeof createdAt !== "number"
			|| !Number.isFinite(createdAt)
			|| source !== "atlas"
			|| typeof atlasSnapshotGeneratedAt !== "string"
			|| atlasSnapshotGeneratedAt.length === 0
			|| (originalCode !== undefined && typeof originalCode !== "string")
			|| !Number.isInteger(lineStart)
			|| !Number.isInteger(lineEnd)
			|| (lineStart as number) < 1
			|| (lineEnd as number) < (lineStart as number)
		) {
			return "Annotation fields are invalid";
		}

		const sourcePath = normalizeSourcePath(rootPath, filePath);
		if (!sourcePath || sourcePath !== filePath.replace(/\\/g, "/")) {
			return `Annotation path is outside the repository or invalid: ${filePath}`;
		}
		const sourceFile = await readAtlasSource(rootPath, sourcePath);
		const lineCount = sourceFile.content.split(/\r?\n/).length;
		if ((lineEnd as number) > lineCount) {
			return `Annotation line range is outside the source file: ${filePath}`;
		}

		ids.add(id);
		parsed.push({
			id,
			type: "comment",
			scope: "line",
			filePath,
			lineStart: lineStart as number,
			lineEnd: lineEnd as number,
			side: "new",
			text,
			...(originalCode !== undefined && { originalCode }),
			createdAt: createdAt as number,
			source: "atlas",
			atlasSnapshotGeneratedAt,
		});
	}

	return { annotations: parsed, markdown };
}

export async function startExploreServer(options: {
	rootPath: string;
	htmlContent: string;
	indexPath?: string;
}): Promise<ExploreServerResult> {
	const rootPath = realpathSync(resolve(options.rootPath));
	if (!statSync(rootPath).isDirectory()) {
		throw new Error(`Explore path is not a directory: ${options.rootPath}`);
	}

	let stopped = false;
	const semanticSession = new AtlasSemanticSession();
	const indexSession = await AtlasIndexSession.open({
		rootPath,
		...(options.indexPath && {
			cacheOptions: { indexPath: options.indexPath },
		}),
		buildSnapshot: ({ rootPath: repositoryRoot }) =>
			buildIndexedAtlasSnapshot(repositoryRoot),
	});
	const semanticIndexPromise = AtlasSemanticIndexService.open({
		rootPath,
		indexPath: indexSession.indexPath,
		session: semanticSession,
	});
	void semanticIndexPromise.catch((error) => {
		console.warn(
			"[plannotator] Atlas semantic index unavailable:",
			error instanceof Error ? error.message : String(error),
		);
	});
	let warmedRevision = -1;
	const warmCurrentSnapshot = async (): Promise<void> => {
		if (stopped) return;
		const status = indexSession.getStatus();
		const snapshot = indexSession.getSnapshot();
		if (!snapshot || status.revision === warmedRevision) return;
		warmedRevision = status.revision;
		try {
			await warmAtlasSemantics(semanticSession, rootPath, snapshot);
		} catch (error) {
			if (!stopped) {
				console.warn(
					"[plannotator] Atlas semantic warmup failed:",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	};
	const reindex = async (): Promise<void> => {
		await indexSession.reindex();
		if (!stopped) await warmCurrentSnapshot();
	};
	let aiRuntimePromise: Promise<PiAIRuntime | null> | undefined;
	const getAIRuntime = (): Promise<PiAIRuntime | null> => {
		if (!aiRuntimePromise) {
			aiRuntimePromise = resolveAIEnabled()
				? createPiAIRuntime({ cwd: rootPath })
				: Promise.resolve(null);
		}
		return aiRuntimePromise;
	};
	let closeResolved = false;
	let feedbackResolved = false;
	let resolveClose!: () => void;
	let resolveFeedback!: (feedback: AtlasFeedbackResult | null) => void;
	const closePromise = new Promise<void>((resolvePromise) => {
		resolveClose = resolvePromise;
	});
	const feedbackPromise = new Promise<AtlasFeedbackResult | null>((resolvePromise) => {
		resolveFeedback = resolvePromise;
	});
	const resolveCloseOnce = (): void => {
		if (closeResolved) return;
		closeResolved = true;
		resolveClose();
	};
	let completionPromise: Promise<void> | undefined;
	const resolveFeedbackOnce = (feedback: AtlasFeedbackResult | null): boolean => {
		if (feedbackResolved) return false;
		feedbackResolved = true;
		completionPromise = disposeRuntimes()
			.catch((error) => {
				console.warn(
					"[plannotator] Atlas shutdown failed:",
					error instanceof Error ? error.message : String(error),
				);
			})
			.then(() => {
				resolveFeedback(feedback);
				resolveCloseOnce();
			});
		return true;
	};
	let disposePromise: Promise<void> | undefined;
	const disposeRuntimes = (): Promise<void> => {
		if (!disposePromise) {
			disposePromise = Promise.all([
				indexSession.dispose(),
				semanticIndexPromise.then(
					(semanticIndex) => semanticIndex.dispose(),
					() => undefined,
				),
				semanticSession.dispose(),
				aiRuntimePromise?.then((runtime) => runtime?.dispose()),
			]).then(() => {});
		}
		return disposePromise;
	};

	const server = createServer((req, res) => {
		void (async () => {
			const url = requestUrl(req);
			const method = req.method?.toUpperCase() ?? "GET";
			const indexStatus = indexSession.getStatus();
			const snapshot = indexSession.getSnapshot();

			if (method === "GET" && url.pathname === "/api/atlas/status") {
				json(res, indexStatus);
				return;
			}

			if (method === "GET" && url.pathname === "/api/atlas") {
				if (!snapshot) {
					json(res, indexStatus, indexStatus.status === "error" ? 500 : 202);
					return;
				}
				json(res, snapshot);
				return;
			}

			if (method === "GET" && url.pathname === "/api/atlas/source") {
				const requestedPath = url.searchParams.get("path");
				if (!requestedPath) {
					json(res, { error: "Missing path parameter" }, 400);
					return;
				}
				const sourcePath = normalizeSourcePath(rootPath, requestedPath);
				if (!sourcePath) {
					json(res, { error: "Source file not found" }, 404);
					return;
				}
				try {
					json(res, await readAtlasSource(rootPath, sourcePath));
				} catch (error) {
					json(res, {
						error: error instanceof Error ? error.message : "Failed to read source file",
					}, 404);
				}
				return;
			}

			if (method === "GET" && url.pathname === "/api/atlas/references") {
				const symbol = url.searchParams.get("symbol")?.trim();
				if (!symbol) {
					json(res, { error: "Missing symbol parameter" }, 400);
					return;
				}
				if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(symbol)) {
					json(res, { error: "Invalid symbol parameter" }, 400);
					return;
				}
				if (!snapshot) {
					json(res, indexStatus, indexStatus.status === "error" ? 500 : 202);
					return;
				}

				const requestedPath = url.searchParams.get("path");
				if (!requestedPath) {
					json(res, { error: "Missing path parameter" }, 400);
					return;
				}
				const sourcePath = normalizeSourcePath(rootPath, requestedPath);
				if (!sourcePath) {
					json(res, { error: "Source file not found" }, 404);
					return;
				}
				const line = Number(url.searchParams.get("line"));
				const column = Number(url.searchParams.get("column"));
				if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
					json(res, { error: "Line and column must be positive integers" }, 400);
					return;
				}

				const generation = indexSession.getSnapshotGeneration();
				if (!generation) {
					json(res, indexStatus, 202);
					return;
				}
				const cancellation = new AbortController();
				const abortRequest = () => cancellation.abort();
				const abortResponse = () => {
					if (!res.writableEnded) cancellation.abort();
				};
				req.once("aborted", abortRequest);
				res.once("close", abortResponse);
				try {
					const references = await (await semanticIndexPromise).resolveReferences({
						snapshot: generation.snapshot,
						repositoryFingerprint: generation.repositoryFingerprint,
						symbol,
						filePath: sourcePath,
						line,
						column,
						signal: cancellation.signal,
					});
					if (!cancellation.signal.aborted) json(res, references.response);
				} catch (error) {
					if (!cancellation.signal.aborted) throw error;
				} finally {
					req.off("aborted", abortRequest);
					res.off("close", abortResponse);
				}
				return;
			}

			if (method === "GET" && url.pathname === "/api/atlas/calls") {
				if (!snapshot) {
					json(res, indexStatus, indexStatus.status === "error" ? 500 : 202);
					return;
				}

				const requestedPath = url.searchParams.get("path");
				if (!requestedPath) {
					json(res, { error: "Missing path parameter" }, 400);
					return;
				}
				const sourcePath = normalizeSourcePath(rootPath, requestedPath);
				if (!sourcePath) {
					json(res, { error: "Source file not found" }, 404);
					return;
				}
				const line = Number(url.searchParams.get("line"));
				const column = Number(url.searchParams.get("column"));
				if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
					json(res, { error: "Line and column must be positive integers" }, 400);
					return;
				}
				const cancellation = new AbortController();
				const abortRequest = () => cancellation.abort();
				const abortResponse = () => {
					if (!res.writableEnded) cancellation.abort();
				};
				req.once("aborted", abortRequest);
				res.once("close", abortResponse);
				try {
					const generation = indexSession.getSnapshotGeneration();
					if (!generation) {
						json(res, indexStatus, 202);
						return;
					}
					const calls = await (await semanticIndexPromise).resolveCalls({
						snapshot: generation.snapshot,
						repositoryFingerprint: generation.repositoryFingerprint,
						filePath: sourcePath,
						line,
						column,
						signal: cancellation.signal,
					});
					if (!cancellation.signal.aborted) json(res, calls.response);
				} catch (error) {
					if (!cancellation.signal.aborted) throw error;
				} finally {
					req.off("aborted", abortRequest);
					res.off("close", abortResponse);
				}
				return;
			}

			if (method === "POST" && url.pathname === "/api/atlas/index") {
				if (feedbackResolved) {
					json(res, { error: "Atlas session is already closed" }, 409);
					return;
				}
				void reindex();
				json(res, indexSession.getStatus(), 202);
				return;
			}

			if (method === "POST" && url.pathname === "/api/atlas/feedback") {
				if (feedbackResolved) {
					json(res, { error: "Atlas session is already closed" }, 409);
					return;
				}
				const feedback = await parseAtlasFeedback(req, rootPath);
				if (typeof feedback === "string") {
					json(res, { error: feedback }, 400);
					return;
				}
				if (!resolveFeedbackOnce(feedback)) {
					json(res, { error: "Atlas session is already closed" }, 409);
					return;
				}
				await completionPromise;
				json(res, feedback);
				return;
			}

			if (method === "POST" && url.pathname === "/api/atlas/close") {
				resolveFeedbackOnce(null);
				await completionPromise;
				json(res, { ok: true });
				return;
			}

			if (url.pathname === AI_QUERY_ENDPOINT) {
				req.socket.setTimeout(0);
				res.setTimeout(0);
			}
			if (url.pathname.startsWith("/api/ai/")) {
				if (!isAIEndpointPath(url.pathname)) {
					json(res, { error: `API endpoint not found: ${url.pathname}` }, 404);
					return;
				}
				if (await handlePiAIRequest(req, res, url, await getAIRuntime())) return;
			}

			if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
				json(res, { error: `API endpoint not found: ${url.pathname}` }, 404);
				return;
			}

			if (url.pathname === "/favicon.png") {
				handleFavicon(res);
				return;
			}

			html(res, options.htmlContent);
		})().catch((error: unknown) => {
			console.error("[plannotator] Explore server error:", error);
			if (!res.headersSent) {
				json(res, { error: "Internal server error" }, 500);
			} else if (!res.writableEnded) {
				res.end();
			}
		});
	});

	const { port, portSource } = await listenOnPort(server);
	const isRemote = isRemoteSession();

	// The listener is live before repository verification or indexing starts.
	void warmCurrentSnapshot();
	indexSession.start();
	void indexSession.waitUntilIdle().then(warmCurrentSnapshot);

	return {
		port,
		portSource,
		url: `http://localhost:${port}`,
		isRemote,
		waitForClose: () => closePromise,
		waitForFeedback: () => feedbackPromise,
		stop: async () => {
			if (stopped) {
				await completionPromise;
				return;
			}
			stopped = true;
			resolveFeedbackOnce(null);
			server.close();
			await completionPromise;
		},
	};
}
