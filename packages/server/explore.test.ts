import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { startExploreServer } from "./explore";

const environment = createTestEnvironment(
  ["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE"],
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
        `${server.url}/api/atlas/references?symbol=greet`,
      );
      expect(referencesResponse.status).toBe(200);
      const locations = await referencesResponse.json() as {
        definitions: Array<{ kind: string; filePath: string }>;
        references: Array<{ kind: string; filePath: string }>;
      };
      expect(locations.definitions).toHaveLength(1);
      expect(locations.definitions[0]).toMatchObject({
        kind: "definition",
        filePath: "main.ts",
      });
      expect(locations.references).toHaveLength(1);
      expect(locations.references[0]).toMatchObject({
        kind: "reference",
        filePath: "main.ts",
      });

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

      const faviconResponse = await fetch(`${server.url}/favicon.png`);
      expect(faviconResponse.status).toBe(200);
      expect(faviconResponse.headers.get("content-type")).toBe("image/png");

      const spaResponse = await fetch(`${server.url}/files/main.ts`);
      expect(spaResponse.status).toBe(200);
      expect(spaResponse.headers.get("content-type")).toContain("text/html");
      expect(await spaResponse.text()).toBe(SPA_HTML);

      const refreshResponse = await fetch(`${server.url}/api/atlas/refresh`, {
        method: "POST",
      });
      expect(refreshResponse.status).toBe(202);
      expect(await refreshResponse.json()).toEqual({ status: "indexing" });
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
      expect(closed).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("programmatic stop releases close waiters", async () => {
    const root = environment.makeTempDir();
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    const server = await startExploreServer({
      rootPath: root,
      htmlContent: SPA_HTML,
    });

    let closed = false;
    const closePromise = server.waitForClose().then(() => {
      closed = true;
    });
    server.stop();
    await closePromise;

    expect(closed).toBe(true);
  });
});
