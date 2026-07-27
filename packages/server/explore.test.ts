import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { indexAtlasRepository, startExploreServer } from "./explore";

const environment = createTestEnvironment(
  ["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI"],
  "plannotator-explore-",
);
const SPA_HTML = "<!doctype html><html><body>Atlas app</body></html>";

async function waitForReady(url: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${url}/api/atlas/status`);
    const body = await response.json() as { status: string; error?: string };
    if (body.status === "ready") return;
    if (body.status === "error") {
      throw new Error(body.error ?? "Atlas indexing failed");
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for Atlas indexing");
}

describe("explore server", () => {
  beforeEach(() => {
    environment.reset();
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_AI = "disabled";
  });

  afterEach(() => environment.restore());

  test("serves the repository atlas and enforces source containment", async () => {
    const root = environment.makeTempDir();
    const outside = environment.makeTempDir();
    writeFileSync(
      join(root, "main.ts"),
      [
        "export function greet(name: string) {",
        "  return `Hello ${name}`;",
        "}",
        "export const welcome = greet('Atlas');",
        "",
      ].join("\n"),
    );
    const secretPath = join(outside, "secret.ts");
    writeFileSync(secretPath, "export const secret = 'outside';\n");
    symlinkSync(secretPath, join(root, "escape.ts"));

    let ready:
      | { url: string; isRemote: boolean; port: number }
      | undefined;
    const server = await startExploreServer({
      rootPath: root,
      htmlContent: SPA_HTML,
      indexPath: join(environment.makeTempDir(), "atlas.sqlite3"),
      onReady: (url, isRemote, port) => {
        ready = { url, isRemote, port };
      },
    });

    try {
      expect(server.url).toBe(`http://localhost:${server.port}`);
      expect(ready).toEqual({
        url: server.url,
        isRemote: false,
        port: server.port,
      });

      const initialStatus = await fetch(`${server.url}/api/atlas/status`);
      expect(initialStatus.status).toBe(200);
      expect(["indexing", "ready"]).toContain(
        (await initialStatus.json() as { status: string }).status,
      );
      await waitForReady(server.url);

      const atlasResponse = await fetch(`${server.url}/api/atlas`);
      expect(atlasResponse.status).toBe(200);
      const atlas = await atlasResponse.json() as {
        rootName: string;
        nodes: Array<{ path: string }>;
        summary: { files: number };
      };
      expect(atlas.rootName).toBe(basename(root));
      expect(atlas.summary.files).toBe(1);
      expect(atlas.nodes.some((node) => node.path === "main.ts")).toBe(true);

      const sourceResponse = await fetch(
        `${server.url}/api/atlas/source?path=${encodeURIComponent("main.ts")}`,
      );
      expect(sourceResponse.status).toBe(200);
      const source = await sourceResponse.json() as {
        path: string;
        content: string;
        language: string;
      };
      expect(source.path).toBe("main.ts");
      expect(source.language).toBe("typescript");
      expect(source.content).toContain("function greet");

      const referencesResponse = await fetch(
        `${server.url}/api/atlas/references?symbol=greet&path=main.ts&line=1&column=17`,
      );
      expect(referencesResponse.status).toBe(200);
      const locations = await referencesResponse.json() as {
        definitions: Array<{ kind: string; filePath: string }>;
        references: Array<{ kind: string; filePath: string }>;
        provider: { kind: string; status: string };
      };
      expect(locations.definitions).toHaveLength(1);
      expect(locations.definitions[0]).toMatchObject({
        kind: "definition",
        filePath: "main.ts",
      });
      expect(locations.references).toHaveLength(0);
      expect(locations.provider).toMatchObject({
        kind: "syntax",
        status: "unavailable",
      });

      const callsResponse = await fetch(
        `${server.url}/api/atlas/calls?path=main.ts&line=1&column=17`,
      );
      expect(callsResponse.status).toBe(200);
      const calls = await callsResponse.json() as {
        root: unknown;
        callers: unknown[];
        callees: unknown[];
        truncated: boolean;
        provider: { kind: string; status: string };
      };
      expect(Array.isArray(calls.callers)).toBe(true);
      expect(Array.isArray(calls.callees)).toBe(true);
      expect(typeof calls.truncated).toBe("boolean");
      expect(calls.provider.kind).toBe("lsp");
      expect(["ready", "unsupported", "unavailable"]).toContain(calls.provider.status);

      const traversalResponse = await fetch(
        `${server.url}/api/atlas/source?path=${encodeURIComponent("../secret.ts")}`,
      );
      expect(traversalResponse.status).toBe(404);
      expect(await traversalResponse.text()).not.toContain("outside");

      const symlinkResponse = await fetch(
        `${server.url}/api/atlas/source?path=${encodeURIComponent("escape.ts")}`,
      );
      expect(symlinkResponse.status).toBe(404);
      expect(await symlinkResponse.text()).not.toContain("outside");

      const invalidSymbol = await fetch(
        `${server.url}/api/atlas/references?symbol=${encodeURIComponent("greet()")}`,
      );
      expect(invalidSymbol.status).toBe(400);

      const missingApi = await fetch(`${server.url}/api/not-real`);
      expect(missingApi.status).toBe(404);
      expect(missingApi.headers.get("content-type")).toContain("application/json");

      const capabilities = await fetch(`${server.url}/api/ai/capabilities`);
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toEqual({ available: false, providers: [] });

      const unavailableSession = await fetch(`${server.url}/api/ai/session`, {
        method: "POST",
      });
      expect(unavailableSession.status).toBe(503);
      expect(await unavailableSession.json()).toEqual({
        error: "AI backend not available",
      });

      const missingAI = await fetch(`${server.url}/api/ai/not-real`);
      expect(missingAI.status).toBe(404);
      expect(await missingAI.json()).toEqual({
        error: "API endpoint not found: /api/ai/not-real",
      });

      const faviconResponse = await fetch(`${server.url}/favicon.png`);
      expect(faviconResponse.status).toBe(200);
      expect(faviconResponse.headers.get("content-type")).toBe("image/png");

      const spaResponse = await fetch(`${server.url}/files/main.ts`);
      expect(spaResponse.status).toBe(200);
      expect(spaResponse.headers.get("content-type")).toContain("text/html");
      expect(await spaResponse.text()).toBe(SPA_HTML);

      const refreshResponse = await fetch(`${server.url}/api/atlas/index`, {
        method: "POST",
      });
      expect(refreshResponse.status).toBe(202);
      expect(await refreshResponse.json()).toMatchObject({
        status: "indexing",
        refreshing: true,
      });
      await waitForReady(server.url);

      let closed = false;
      const closePromise = server.waitForClose().then(() => {
        closed = true;
      });
      const closeResponse = await fetch(`${server.url}/api/atlas/close`, {
        method: "POST",
      });
      expect(closeResponse.status).toBe(200);
      expect(await closeResponse.json()).toEqual({ ok: true });
      await closePromise;
      await expect(server.waitForFeedback()).resolves.toBeNull();
      expect(closed).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("programmatic stop releases close waiters", async () => {
    const root = environment.makeTempDir();
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    const server = await startExploreServer({
      rootPath: root,
      htmlContent: SPA_HTML,
      indexPath: join(environment.makeTempDir(), "atlas.sqlite3"),
    });

    let closed = false;
    const closePromise = server.waitForClose().then(() => {
      closed = true;
    });
    await server.stop();
    await closePromise;

    expect(closed).toBe(true);
    await expect(server.waitForFeedback()).resolves.toBeNull();
  });

  test("returns graceful semantic fallbacks for files without an LSP provider", async () => {
    const root = environment.makeTempDir();
    writeFileSync(join(root, "notes.txt"), "Architecture notes\n");
    const server = await startExploreServer({
      rootPath: root,
      htmlContent: SPA_HTML,
      indexPath: join(environment.makeTempDir(), "atlas.sqlite3"),
    });
    try {
      await waitForReady(server.url);
      const references = await fetch(
        `${server.url}/api/atlas/references?symbol=Architecture&path=notes.txt&line=1&column=1`,
      );
      expect(references.status).toBe(200);
      expect(await references.json()).toMatchObject({
        definitions: [],
        references: [],
        provider: { kind: "syntax", status: "unavailable" },
      });

      const calls = await fetch(
        `${server.url}/api/atlas/calls?path=notes.txt&line=1&column=1`,
      );
      expect(calls.status).toBe(200);
      expect(await calls.json()).toMatchObject({
        root: null,
        callers: [],
        callees: [],
        provider: { kind: "lsp", status: "unavailable" },
      });
    } finally {
      await server.stop();
    }
  });

  test("manual indexing writes a snapshot that a server hydrates after verification", async () => {
    const root = environment.makeTempDir();
    const indexPath = join(environment.makeTempDir(), "atlas.sqlite3");
    writeFileSync(join(root, "index.ts"), "export const cached = true;\n");

    const indexed = await indexAtlasRepository({ rootPath: root, indexPath });
    expect(indexed.source).toBe("fresh");
    expect(indexed.snapshot.summary.files).toBe(1);
    expect(indexed.snapshot.summary.symbols).toBe(1);
    expect(indexed.indexPath).toBe(indexPath);
    expect(existsSync(indexPath)).toBe(true);

    const server = await startExploreServer({
      rootPath: root,
      htmlContent: SPA_HTML,
      indexPath,
    });
    try {
      await waitForReady(server.url);
      const status = await fetch(`${server.url}/api/atlas/status`).then(
        (response) => response.json() as Promise<{
          hasSnapshot: boolean;
          source?: string;
        }>,
      );
      expect(status.hasSnapshot).toBe(true);
      expect(status.source).toBe("cache");

      const snapshot = await fetch(`${server.url}/api/atlas`);
      expect(snapshot.status).toBe(200);
      expect((await snapshot.json() as { generatedAt: string }).generatedAt)
        .toBe(indexed.snapshot.generatedAt);

      await fetch(`${server.url}/api/atlas/close`, { method: "POST" });
    } finally {
      await server.stop();
    }
  });

  test("manual indexing fails when the requested cache cannot be persisted", async () => {
    const root = environment.makeTempDir();
    writeFileSync(join(root, "index.ts"), "export const cached = true;\n");

    await expect(indexAtlasRepository({
      rootPath: root,
      indexPath: environment.makeTempDir(),
    })).rejects.toThrow(/persist|database|directory/i);
  });

  test("validates and returns submitted Atlas feedback", async () => {
    const root = environment.makeTempDir();
    writeFileSync(join(root, "index.ts"), [
      "export function value() {",
      "  return 1;",
      "}",
      "",
    ].join("\n"));
    const server = await startExploreServer({
      rootPath: root,
      htmlContent: SPA_HTML,
      indexPath: join(environment.makeTempDir(), "atlas.sqlite3"),
    });

    const oversized = await fetch(`${server.url}/api/atlas/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        annotations: Array.from({ length: 501 }, () => ({})),
        markdown: "Too many",
      }),
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toEqual({
      error: "Annotations must contain at most 500 items",
    });

    const invalid = await fetch(`${server.url}/api/atlas/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        annotations: [{
          id: "outside",
          type: "comment",
          scope: "line",
          filePath: "../outside.ts",
          lineStart: 1,
          lineEnd: 1,
          side: "new",
          text: "Not contained",
          createdAt: Date.parse("2026-07-26T12:00:00.000Z"),
          source: "atlas",
          atlasSnapshotGeneratedAt: "2026-07-26T11:59:00.000Z",
        }],
        markdown: "Invalid",
      }),
    });
    expect(invalid.status).toBe(400);

    const feedback = {
      annotations: [{
        id: "annotation-1",
        type: "comment",
        scope: "line",
        filePath: "index.ts",
        lineStart: 1,
        lineEnd: 3,
        side: "new",
        text: "Review this function",
        originalCode: "export function value()",
        createdAt: Date.parse("2026-07-26T12:00:00.000Z"),
        source: "atlas",
        atlasSnapshotGeneratedAt: "2026-07-26T11:59:00.000Z",
      }],
      markdown: "## Atlas feedback\n\nReview this function.",
    };
    const response = await fetch(`${server.url}/api/atlas/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(feedback),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(feedback);
    await expect(server.waitForFeedback()).resolves.toEqual(feedback);
    await expect(server.waitForClose()).resolves.toBeUndefined();

    const duplicate = await fetch(`${server.url}/api/atlas/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(feedback),
    });
    expect(duplicate.status).toBe(409);
    await server.stop();
  });
});
