import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitContext } from "@plannotator/shared/review-core";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";

const HTML = "<!doctype html><title>Review Atlas</title>";
const directories: string[] = [];
const previousAI = process.env.PLANNOTATOR_AI;
const previousRemote = process.env.PLANNOTATOR_REMOTE;
const previousPort = process.env.PLANNOTATOR_PORT;

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-review-atlas-"));
  directories.push(root);
  writeFileSync(
    join(root, "main.ts"),
    "export function main() {\n  return 1;\n}\n",
  );
  return root;
}

function gitContext(cwd: string): GitContext {
  return {
    currentBranch: "main",
    defaultBranch: "main",
    diffOptions: [],
    worktrees: [],
    availableBranches: { local: ["main"], remote: [] },
    cwd,
    vcsType: "git",
  };
}

async function waitForSnapshot(url: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const statusResponse = await fetch(`${url}/api/atlas/status`);
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json() as {
      hasSnapshot?: boolean;
      capability?: { available?: boolean };
    };
    expect(status.capability?.available).toBe(true);
    if (status.hasSnapshot) {
      const snapshotResponse = await fetch(`${url}/api/atlas`);
      expect(snapshotResponse.status).toBe(200);
      return snapshotResponse.json() as Promise<Record<string, unknown>>;
    }
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for review Atlas snapshot");
}

beforeAll(() => {
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_PORT = "0";
});

afterAll(async () => {
  if (previousAI === undefined) delete process.env.PLANNOTATOR_AI;
  else process.env.PLANNOTATOR_AI = previousAI;
  if (previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
  else process.env.PLANNOTATOR_REMOTE = previousRemote;
  if (previousPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = previousPort;
  await Bun.sleep(100);
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const runtime of [
  { name: "Bun", start: startBunReviewServer, origin: "claude-code" as const },
  { name: "Pi", start: startPiReviewServer, origin: "pi" as const },
]) {
  describe(`${runtime.name} review Atlas`, () => {
    test("indexes and serves the active local checkout with containment", async () => {
      const root = repository();
      const server = await runtime.start({
        rawPatch: "",
        gitRef: "HEAD",
        diffType: "uncommitted",
        gitContext: gitContext(root),
        origin: runtime.origin,
        htmlContent: HTML,
        atlasEnabled: true,
      });
      try {
        const diffResponse = await fetch(`${server.url}/api/diff`);
        expect(diffResponse.status).toBe(200);
        expect(await diffResponse.json()).toMatchObject({ atlasEnabled: true });

        const snapshot = await waitForSnapshot(server.url);
        expect(snapshot).not.toHaveProperty("rootPath");
        expect((snapshot.summary as { files: number }).files).toBe(1);

        const source = await fetch(`${server.url}/api/atlas/source?path=main.ts`);
        expect(source.status).toBe(200);
        expect(await source.json()).toMatchObject({ path: "main.ts" });

        const traversal = await fetch(
          `${server.url}/api/atlas/source?path=${encodeURIComponent("../secret.ts")}`,
        );
        expect(traversal.status).toBe(404);
      } finally {
        server.stop();
      }
    });

    test("reports a typed capability error without a local checkout", async () => {
      const server = await runtime.start({
        rawPatch: "",
        gitRef: "HEAD",
        origin: runtime.origin,
        htmlContent: HTML,
        atlasEnabled: true,
      });
      try {
        const response = await fetch(`${server.url}/api/atlas/status`);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          capability: {
            available: false,
            code: "no-local-checkout",
            retryable: false,
          },
        });
      } finally {
        server.stop();
      }
    });

    test("reports multi-root workspaces instead of indexing the launch directory", async () => {
      const root = repository();
      const workspace = {
        root,
        repos: [
          { id: "repo-1", cwd: join(root, "one"), selected: true },
          { id: "repo-2", cwd: join(root, "two"), selected: true },
        ],
        diffType: "workspace-current",
        diffOptions: [],
        rawPatch: "",
        gitRef: "Workspace",
        getFingerprint: async () => null,
        getPromptContext: () => ({ root, repos: [] }),
        normalizeAnnotationPath: (path: string) => path,
      };
      const server = await runtime.start({
        rawPatch: "",
        gitRef: "Workspace",
        origin: runtime.origin,
        htmlContent: HTML,
        workspace: workspace as never,
        atlasEnabled: true,
      });
      try {
        const response = await fetch(`${server.url}/api/atlas/status`);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          capability: {
            available: false,
            code: "multi-root-workspace",
            retryable: false,
          },
        });
      } finally {
        server.stop();
      }
    });

    test("does not expose Atlas unless the review opts in", async () => {
      const root = repository();
      const server = await runtime.start({
        rawPatch: "",
        gitRef: "HEAD",
        diffType: "uncommitted",
        gitContext: gitContext(root),
        origin: runtime.origin,
        htmlContent: HTML,
      });
      try {
        const diffResponse = await fetch(`${server.url}/api/diff`);
        expect(diffResponse.status).toBe(200);
        expect(await diffResponse.json()).toMatchObject({ atlasEnabled: false });

        const atlasResponse = await fetch(`${server.url}/api/atlas/status`);
        expect(atlasResponse.status).toBe(404);
      } finally {
        server.stop();
      }
    });
  });
}
