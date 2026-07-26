import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startExploreServer, type ExploreServerResult } from "./serverExplore.ts";

const originalPort = process.env.PLANNOTATOR_PORT;
const originalRemote = process.env.PLANNOTATOR_REMOTE;
const activeServers = new Set<ExploreServerResult>();
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const server of activeServers) server.stop();
	activeServers.clear();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
	else process.env.PLANNOTATOR_PORT = originalPort;
	if (originalRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
	else process.env.PLANNOTATOR_REMOTE = originalRemote;
});

function createFixture(): { root: string; outsideFile: string } {
	const parent = mkdtempSync(join(tmpdir(), "plannotator-pi-atlas-"));
	temporaryDirectories.push(parent);
	const root = join(parent, "repository");
	const outsideFile = join(parent, "outside.ts");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "main.ts"), [
		'import { greet } from "./greet.ts";',
		"export function run() {",
		'  return greet("Atlas");',
		"}",
		"",
	].join("\n"));
	writeFileSync(join(root, "src", "greet.ts"), [
		"export function greet(name: string) {",
		"  return `Hello ${name}`;",
		"}",
		"",
	].join("\n"));
	writeFileSync(outsideFile, "export const secret = true;\n");
	symlinkSync(outsideFile, join(root, "outside-link.ts"));
	return { root, outsideFile };
}

async function waitForSnapshot(baseUrl: string): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const response = await fetch(`${baseUrl}/api/atlas`);
		if (response.status === 200) {
			return await response.json() as Record<string, unknown>;
		}
		expect(response.status).toBe(202);
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for Codebase Atlas index");
}

describe("Pi Codebase Atlas server", () => {
	test("serves the Atlas contract and closes on demand", async () => {
		process.env.PLANNOTATOR_PORT = "0";
		process.env.PLANNOTATOR_REMOTE = "0";
		const { root } = createFixture();
		const server = await startExploreServer({
			rootPath: root,
			htmlContent: "<!doctype html><title>Atlas fixture</title>",
		});
		activeServers.add(server);

		const page = await fetch(server.url);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Atlas fixture");

		const favicon = await fetch(`${server.url}/favicon.png`);
		expect(favicon.status).toBe(200);
		expect(favicon.headers.get("content-type")).toBe("image/png");

		const snapshot = await waitForSnapshot(server.url);
		expect(snapshot.version).toBe(1);
		expect(snapshot.rootPath).toBe(root);
		expect((snapshot.summary as { files: number }).files).toBe(2);

		const source = await fetch(
			`${server.url}/api/atlas/source?path=${encodeURIComponent("src/main.ts")}`,
		);
		expect(source.status).toBe(200);
		expect(await source.json()).toMatchObject({
			path: "src/main.ts",
			language: "typescript",
		});

		const references = await fetch(
			`${server.url}/api/atlas/references?symbol=greet&path=${encodeURIComponent("src/main.ts")}`,
		);
		expect(references.status).toBe(200);
		const referenceBody = await references.json() as {
			definitions: Array<{ filePath: string }>;
			references: Array<{ filePath: string }>;
		};
		expect(referenceBody.definitions.some((location) => location.filePath === "src/greet.ts")).toBe(true);
		expect(referenceBody.references.some((location) => location.filePath === "src/main.ts")).toBe(true);

		const closeRequest = fetch(`${server.url}/api/atlas/close`, { method: "POST" });
		await expect(closeRequest.then((response) => response.json())).resolves.toEqual({ ok: true });
		await expect(server.waitForClose()).resolves.toBeUndefined();
	});

	test("rejects paths outside the repository and unknown API routes", async () => {
		process.env.PLANNOTATOR_PORT = "0";
		process.env.PLANNOTATOR_REMOTE = "0";
		const { root } = createFixture();
		const server = await startExploreServer({
			rootPath: root,
			htmlContent: "<!doctype html>",
		});
		activeServers.add(server);
		await waitForSnapshot(server.url);

		const traversal = await fetch(
			`${server.url}/api/atlas/source?path=${encodeURIComponent("../outside.ts")}`,
		);
		expect(traversal.status).toBe(404);

		const symlinkEscape = await fetch(
			`${server.url}/api/atlas/source?path=${encodeURIComponent("outside-link.ts")}`,
		);
		expect(symlinkEscape.status).toBe(404);

		const invalidSymbol = await fetch(
			`${server.url}/api/atlas/references?symbol=${encodeURIComponent("greet()")}`,
		);
		expect(invalidSymbol.status).toBe(400);

		const missingApi = await fetch(`${server.url}/api/atlas/not-real`);
		expect(missingApi.status).toBe(404);
		expect(await missingApi.json()).toEqual({
			error: "API endpoint not found: /api/atlas/not-real",
		});

		const refresh = await fetch(`${server.url}/api/atlas/refresh`, { method: "POST" });
		expect(refresh.status).toBe(202);
		expect(await refresh.json()).toEqual({ status: "indexing" });
	});

	test("releases close waiters when stopped programmatically", async () => {
		process.env.PLANNOTATOR_PORT = "0";
		process.env.PLANNOTATOR_REMOTE = "0";
		const { root } = createFixture();
		const server = await startExploreServer({
			rootPath: root,
			htmlContent: "<!doctype html>",
		});
		activeServers.add(server);

		const closePromise = server.waitForClose();
		server.stop();
		await expect(closePromise).resolves.toBeUndefined();
	});
});
