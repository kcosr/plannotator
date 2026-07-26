import { realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
	buildAtlasSnapshot,
	findAtlasReferences,
	readAtlasSource,
	type AtlasSnapshot,
} from "../generated/atlas.ts";
import { handleFavicon } from "./handlers.ts";
import { html, json, requestUrl } from "./helpers.ts";
import { isRemoteSession, listenOnPort } from "./network.ts";

export type AtlasIndexStatus = "indexing" | "ready" | "error";

export interface ExploreServerResult {
	port: number;
	portSource: "env" | "remote-default" | "random";
	url: string;
	isRemote: boolean;
	waitForClose: () => Promise<void>;
	stop: () => void;
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

export async function startExploreServer(options: {
	rootPath: string;
	htmlContent: string;
}): Promise<ExploreServerResult> {
	const rootPath = realpathSync(resolve(options.rootPath));
	if (!statSync(rootPath).isDirectory()) {
		throw new Error(`Explore path is not a directory: ${options.rootPath}`);
	}

	let status: AtlasIndexStatus = "indexing";
	let snapshot: AtlasSnapshot | undefined;
	let indexingError: string | undefined;
	let activeBuild: Promise<void> | undefined;
	let stopped = false;
	let closeResolved = false;
	let resolveClose!: () => void;
	const closePromise = new Promise<void>((resolvePromise) => {
		resolveClose = resolvePromise;
	});
	const resolveCloseOnce = (): void => {
		if (closeResolved) return;
		closeResolved = true;
		resolveClose();
	};

	const beginIndexing = (): Promise<void> => {
		if (activeBuild) return activeBuild;
		status = "indexing";
		indexingError = undefined;
		activeBuild = Promise.resolve()
			.then(() => buildAtlasSnapshot(rootPath))
			.then((nextSnapshot) => {
				if (stopped) return;
				snapshot = nextSnapshot;
				status = "ready";
			})
			.catch((error: unknown) => {
				if (stopped) return;
				snapshot = undefined;
				status = "error";
				indexingError = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				activeBuild = undefined;
			});
		return activeBuild;
	};

	const server = createServer((req, res) => {
		void (async () => {
			const url = requestUrl(req);
			const method = req.method?.toUpperCase() ?? "GET";

			if (method === "GET" && url.pathname === "/api/atlas/status") {
				json(res, {
					status,
					...(indexingError ? { error: indexingError } : {}),
				});
				return;
			}

			if (method === "GET" && url.pathname === "/api/atlas") {
				if (status === "error") {
					json(res, {
						status,
						error: indexingError ?? "Repository indexing failed",
					}, 500);
					return;
				}
				if (status === "indexing" || !snapshot) {
					json(res, { status: "indexing" }, 202);
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
				if (status === "error") {
					json(res, {
						status,
						error: indexingError ?? "Repository indexing failed",
					}, 500);
					return;
				}
				if (status !== "ready" || !snapshot) {
					json(res, { status: "indexing" }, 202);
					return;
				}

				const requestedPath = url.searchParams.get("path") || undefined;
				let sourcePath: string | undefined;
				if (requestedPath) {
					const normalizedPath = normalizeSourcePath(rootPath, requestedPath);
					if (!normalizedPath) {
						json(res, { error: "Source file not found" }, 404);
						return;
					}
					sourcePath = normalizedPath;
				}

				const locations = await findAtlasReferences(snapshot, symbol, sourcePath);
				json(res, {
					definitions: locations.filter((location) => location.kind === "definition"),
					references: locations.filter((location) => location.kind === "reference"),
				});
				return;
			}

			if (method === "POST" && url.pathname === "/api/atlas/refresh") {
				void beginIndexing();
				json(res, { status: "indexing" }, 202);
				return;
			}

			if (method === "POST" && url.pathname === "/api/atlas/close") {
				resolveCloseOnce();
				json(res, { ok: true });
				return;
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

	// The listener is live before repository analysis begins.
	void beginIndexing();

	return {
		port,
		portSource,
		url: `http://localhost:${port}`,
		isRemote,
		waitForClose: () => closePromise,
		stop: () => {
			if (stopped) return;
			stopped = true;
			resolveCloseOnce();
			server.close();
		},
	};
}
