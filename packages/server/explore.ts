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
  resolveAtlasReferences,
  type AtlasSemanticProviderCapability,
  type AtlasSnapshot,
} from "@plannotator/shared/atlas";
import {
  AtlasSemanticSession,
  probeAtlasSemanticCapabilities,
} from "@plannotator/shared/atlas-semantic";
import { isWithinDirectory } from "@plannotator/shared/html-assets-node";
import {
  getServerHostname,
  isRemoteSession,
  startBunServerOnAvailablePort,
} from "./remote";
import { handleFavicon } from "./shared-handlers";

export { handleServerReady as handleExploreServerReady } from "./shared-handlers";

export type AtlasIndexStatus = "indexing" | "ready" | "error";

export interface ExploreServerOptions {
  rootPath: string;
  htmlContent: string;
  onReady?: (url: string, isRemote: boolean, port: number) => void | Promise<void>;
}

export interface ExploreServerResult {
  port: number;
  url: string;
  isRemote: boolean;
  waitForClose: () => Promise<void>;
  stop: () => void;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
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
  let status: AtlasIndexStatus = "indexing";
  let snapshot: AtlasSnapshot | undefined;
  let indexingError: string | undefined;
  let activeBuild: Promise<void> | undefined;
  const semanticSession = new AtlasSemanticSession();
  let stopped = false;
  let closeResolved = false;
  let resolveClose!: () => void;
  const closePromise = new Promise<void>((resolvePromise) => {
    resolveClose = resolvePromise;
  });
  const resolveCloseOnce = () => {
    if (closeResolved) return;
    closeResolved = true;
    resolveClose();
  };

  const beginIndexing = (): Promise<void> => {
    if (activeBuild) return activeBuild;
    status = "indexing";
    indexingError = undefined;
    activeBuild = Promise.resolve()
      .then(async () => {
        const capabilities = await probeAtlasSemanticCapabilities();
        const semanticProviders: AtlasSemanticProviderCapability[] = Object.values(capabilities)
          .map((capability) => ({
            language: capability.language,
            name: capability.serverId,
            available: capability.available,
            ...(capability.command && {
              source: process.env[capability.envVariable]?.trim() ? "env" : "path",
            }),
            ...(capability.reason && { reason: capability.reason }),
          }));
        return buildAtlasSnapshot(rootPath, { semanticProviders });
      })
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

  const server = await startBunServerOnAvailablePort((port) =>
    Bun.serve({
      hostname: getServerHostname(),
      port,
      async fetch(req) {
        const url = new URL(req.url);
        const method = req.method.toUpperCase();

        if (method === "GET" && url.pathname === "/api/atlas/status") {
          return Response.json({
            status,
            ...(indexingError ? { error: indexingError } : {}),
          });
        }

        if (method === "GET" && url.pathname === "/api/atlas") {
          if (status === "indexing" || !snapshot) {
            if (status === "error") {
              return Response.json(
                { status, error: indexingError ?? "Repository indexing failed" },
                { status: 500 },
              );
            }
            return Response.json({ status: "indexing" }, { status: 202 });
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
          if (status !== "ready" || !snapshot) {
            if (status === "error") {
              return Response.json(
                { status, error: indexingError ?? "Repository indexing failed" },
                { status: 500 },
              );
            }
            return Response.json({ status: "indexing" }, { status: 202 });
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
          return Response.json(
            await resolveAtlasReferences(
              semanticSession,
              snapshot,
              symbol,
              sourcePath,
              line,
              column,
            ),
          );
        }

        if (method === "POST" && url.pathname === "/api/atlas/refresh") {
          void beginIndexing();
          return Response.json({ status: "indexing" }, { status: 202 });
        }

        if (method === "POST" && url.pathname === "/api/atlas/close") {
          await semanticSession.dispose();
          resolveCloseOnce();
          return Response.json({ ok: true });
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

  // The listener is live before this promise is scheduled.
  void beginIndexing();

  try {
    await options.onReady?.(url, isRemote, port);
  } catch (error) {
    stopped = true;
    server.stop();
    throw error;
  }

  return {
    port,
    url,
    isRemote,
    waitForClose: () => closePromise,
    stop: () => {
      if (stopped) return;
      stopped = true;
      resolveCloseOnce();
      void semanticSession.dispose();
      server.stop();
    },
  };
}
