/**
 * Codebase Atlas server.
 *
 * The HTTP listener is created before repository indexing starts so the UI can
 * render immediately and poll /api/atlas/status for progress.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  buildAtlasSnapshot,
  readAtlasSource,
  type AtlasSemanticProviderCapability,
  type AtlasSnapshot,
} from "@plannotator/shared/atlas";
import {
  AtlasIndexSession,
  type AtlasIndexSessionStatus,
} from "@plannotator/shared/atlas-index-session";
import {
  AtlasSemanticIndexService,
  type AtlasSemanticIndexProgress,
} from "@plannotator/shared/atlas-semantic-index";
import {
  AtlasSemanticSession,
  probeAtlasSemanticCapabilities,
} from "@plannotator/shared/atlas-semantic";
import { isAIEndpointPath, type AIEndpoints } from "@plannotator/ai";
import { resolveAIEnabled } from "./config";
import { isWithinDirectory } from "@plannotator/shared/html-assets-node";
import {
  AI_CAPABILITIES_ENDPOINT,
  AI_QUERY_ENDPOINT,
  createAIRuntime,
  type AIRuntime,
} from "./ai-runtime";
import {
  getServerHostname,
  isRemoteSession,
  startBunServerOnAvailablePort,
} from "./remote";
import { handleFavicon } from "./shared-handlers";
import type { CodeAnnotation } from "@plannotator/shared/code-annotation";

export { handleServerReady as handleExploreServerReady } from "./shared-handlers";

export type AtlasIndexStatus = AtlasIndexSessionStatus["status"];

export interface ExploreServerOptions {
  rootPath: string;
  htmlContent: string;
  indexPath?: string;
  onReady?: (url: string, isRemote: boolean, port: number) => void | Promise<void>;
}

export interface ExploreServerResult {
  port: number;
  url: string;
  isRemote: boolean;
  waitForClose: () => Promise<void>;
  waitForFeedback: () => Promise<AtlasFeedbackResult | null>;
  stop: () => void;
}

export interface AtlasFeedbackResult {
  annotations: CodeAnnotation[];
  markdown: string;
}

export interface IndexAtlasRepositoryOptions {
  rootPath: string;
  indexPath?: string;
  semantic?: boolean;
  onSemanticProgress?: (progress: AtlasSemanticIndexProgress) => void;
}

export interface IndexAtlasRepositoryResult {
  snapshot: AtlasSnapshot;
  indexPath: string;
  source: "cache" | "fresh";
  semantic?: AtlasSemanticIndexProgress;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
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

export async function indexAtlasRepository(
  options: IndexAtlasRepositoryOptions,
): Promise<IndexAtlasRepositoryResult> {
  const session = await AtlasIndexSession.open({
    rootPath: options.rootPath,
    cacheOptions: {
      ...(options.indexPath && { indexPath: options.indexPath }),
    },
    buildSnapshot: ({ rootPath }) => buildIndexedAtlasSnapshot(rootPath),
  });
  try {
    session.start();
    await session.waitUntilIdle();
    const status = session.getStatus();
    const snapshot = session.getSnapshot();
    const generation = session.getSnapshotGeneration();
    if (!snapshot || !generation || status.status === "error") {
      throw new Error(status.error ?? "Atlas indexing failed");
    }
    let semantic: AtlasSemanticIndexProgress | undefined;
    if (options.semantic) {
      const semanticIndex = await AtlasSemanticIndexService.open({
        rootPath: session.rootPath,
        indexPath: session.indexPath,
      });
      try {
        semantic = await semanticIndex.indexAll({
          snapshot: generation.snapshot,
          repositoryFingerprint: generation.repositoryFingerprint,
          onProgress: options.onSemanticProgress,
        });
      } finally {
        await semanticIndex.dispose();
      }
    }
    return {
      snapshot,
      indexPath: session.indexPath,
      source: status.source ?? "fresh",
      ...(semantic && { semantic }),
    };
  } finally {
    await session.dispose();
  }
}

function normalizeSourcePath(rootPath: string, requestedPath: string): string | null {
  if (!requestedPath || isAbsolute(requestedPath)) return null;

  const candidate = resolve(rootPath, requestedPath);
  if (!isWithinDirectory(candidate, rootPath)) return null;

  try {
    const realCandidate = realpathSync(candidate);
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

async function parseAtlasFeedback(
  req: Request,
  rootPath: string,
): Promise<AtlasFeedbackResult | string> {
  let body: unknown;
  try {
    body = await req.json();
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

/**
 * Start a local repository explorer.
 */
export async function startExploreServer(
  options: ExploreServerOptions,
): Promise<ExploreServerResult> {
  const rootPath = realpathSync(resolve(options.rootPath));
  if (!statSync(rootPath).isDirectory()) {
    throw new Error(`Explore path is not a directory: ${options.rootPath}`);
  }

  const isRemote = isRemoteSession();
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
  let aiRuntimePromise: Promise<AIRuntime | null> | undefined;
  const getAIRuntime = (): Promise<AIRuntime | null> => {
    if (!aiRuntimePromise) {
      aiRuntimePromise = resolveAIEnabled()
        ? createAIRuntime({ cwd: rootPath }).catch(() => null)
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
  const resolveCloseOnce = () => {
    if (closeResolved) return;
    closeResolved = true;
    resolveClose();
  };
  const resolveFeedbackOnce = (feedback: AtlasFeedbackResult | null) => {
    if (feedbackResolved) return false;
    feedbackResolved = true;
    resolveFeedback(feedback);
    resolveCloseOnce();
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

  const server = await startBunServerOnAvailablePort((port) =>
    Bun.serve({
      hostname: getServerHostname(),
      port,
      idleTimeout: 0,
      async fetch(req, bunServer) {
        const url = new URL(req.url);
        const method = req.method.toUpperCase();
        const indexStatus = indexSession.getStatus();
        const snapshot = indexSession.getSnapshot();

        if (method === "GET" && url.pathname === "/api/atlas/status") {
          return Response.json(indexStatus);
        }

        if (method === "GET" && url.pathname === "/api/atlas") {
          if (!snapshot) {
            if (indexStatus.status === "error") {
              return Response.json(
                indexStatus,
                { status: 500 },
              );
            }
            return Response.json(indexStatus, { status: 202 });
          }
          return Response.json(snapshot);
        }

        if (method === "GET" && url.pathname === "/api/atlas/source") {
          const requestedPath = url.searchParams.get("path");
          if (!requestedPath) return jsonError("Missing path parameter", 400);
          const sourcePath = normalizeSourcePath(rootPath, requestedPath);
          if (!sourcePath) return jsonError("Source file not found", 404);

          try {
            return Response.json(await readAtlasSource(rootPath, sourcePath));
          } catch (error) {
            return jsonError(
              error instanceof Error ? error.message : "Failed to read source file",
              404,
            );
          }
        }

        if (method === "GET" && url.pathname === "/api/atlas/references") {
          const symbol = url.searchParams.get("symbol")?.trim();
          if (!symbol) return jsonError("Missing symbol parameter", 400);
          if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(symbol)) {
            return jsonError("Invalid symbol parameter", 400);
          }
          if (!snapshot) {
            if (indexStatus.status === "error") {
              return Response.json(
                indexStatus,
                { status: 500 },
              );
            }
            return Response.json(indexStatus, { status: 202 });
          }

          const requestedPath = url.searchParams.get("path") || undefined;
          if (!requestedPath) return jsonError("Missing path parameter", 400);
          const sourcePath = normalizeSourcePath(rootPath, requestedPath);
          if (!sourcePath) return jsonError("Source file not found", 404);
          const line = Number(url.searchParams.get("line"));
          const column = Number(url.searchParams.get("column"));
          if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
            return jsonError("Line and column must be positive integers", 400);
          }
          const generation = indexSession.getSnapshotGeneration();
          if (!generation) return Response.json(indexStatus, { status: 202 });
          return Response.json(
            (
              await (await semanticIndexPromise).resolveReferences({
                snapshot: generation.snapshot,
                repositoryFingerprint: generation.repositoryFingerprint,
                symbol,
                filePath: sourcePath,
                line,
                column,
                signal: req.signal,
              })
            ).response,
          );
        }

        if (method === "GET" && url.pathname === "/api/atlas/calls") {
          if (!snapshot) {
            if (indexStatus.status === "error") {
              return Response.json(
                indexStatus,
                { status: 500 },
              );
            }
            return Response.json(indexStatus, { status: 202 });
          }

          const requestedPath = url.searchParams.get("path");
          if (!requestedPath) return jsonError("Missing path parameter", 400);
          const sourcePath = normalizeSourcePath(rootPath, requestedPath);
          if (!sourcePath) return jsonError("Source file not found", 404);
          const line = Number(url.searchParams.get("line"));
          const column = Number(url.searchParams.get("column"));
          if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
            return jsonError("Line and column must be positive integers", 400);
          }
          const generation = indexSession.getSnapshotGeneration();
          if (!generation) return Response.json(indexStatus, { status: 202 });
          return Response.json((
            await (await semanticIndexPromise).resolveCalls({
              snapshot: generation.snapshot,
              repositoryFingerprint: generation.repositoryFingerprint,
              filePath: sourcePath,
              line,
              column,
              signal: req.signal,
            })
          ).response);
        }

        if (method === "POST" && url.pathname === "/api/atlas/index") {
          if (feedbackResolved) return jsonError("Atlas session is already closed", 409);
          void reindex();
          return Response.json(indexSession.getStatus(), { status: 202 });
        }

        if (method === "POST" && url.pathname === "/api/atlas/feedback") {
          if (feedbackResolved) return jsonError("Atlas session is already closed", 409);
          const feedback = await parseAtlasFeedback(req, rootPath);
          if (typeof feedback === "string") return jsonError(feedback, 400);
          if (!resolveFeedbackOnce(feedback)) {
            return jsonError("Atlas session is already closed", 409);
          }
          await disposeRuntimes();
          return Response.json(feedback);
        }

        if (method === "POST" && url.pathname === "/api/atlas/close") {
          resolveFeedbackOnce(null);
          await disposeRuntimes();
          return Response.json({ ok: true });
        }

        if (url.pathname.startsWith("/api/ai/")) {
          if (!isAIEndpointPath(url.pathname)) {
            return jsonError(`API endpoint not found: ${url.pathname}`, 404);
          }
          const aiRuntime = await getAIRuntime();
          if (!aiRuntime) {
            if (url.pathname === AI_CAPABILITIES_ENDPOINT && method === "GET") {
              return Response.json({ available: false, providers: [] });
            }
            return jsonError("AI backend not available", 503);
          }
          const handler = aiRuntime.endpoints[url.pathname as keyof AIEndpoints];
          if (!handler) return jsonError(`API endpoint not found: ${url.pathname}`, 404);
          if (url.pathname === AI_QUERY_ENDPOINT) bunServer.timeout(req, 0);
          return handler(req);
        }

        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          return jsonError(`API endpoint not found: ${url.pathname}`, 404);
        }

        if (url.pathname === "/favicon.png") return handleFavicon();

        return new Response(options.htmlContent, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
      error(error) {
        console.error("[plannotator] Explore server error:", error);
        return jsonError("Internal server error", 500);
      },
    }),
  );

  const port = server.port!;
  const url = `http://localhost:${port}`;

  // The listener is live before repository verification or indexing starts.
  void warmCurrentSnapshot();
  indexSession.start();
  void indexSession.waitUntilIdle().then(warmCurrentSnapshot);

  try {
    await options.onReady?.(url, isRemote, port);
  } catch (error) {
    stopped = true;
    resolveFeedbackOnce(null);
    await disposeRuntimes();
    server.stop();
    throw error;
  }

  return {
    port,
    url,
    isRemote,
    waitForClose: () => closePromise,
    waitForFeedback: () => feedbackPromise,
    stop: () => {
      if (stopped) return;
      stopped = true;
      resolveFeedbackOnce(null);
      void disposeRuntimes();
      server.stop();
    },
  };
}
