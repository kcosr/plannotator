import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AtlasReviewRuntimeManager,
	AtlasReviewUnavailableError,
} from "./atlas-review-runtime";

const directories: string[] = [];

function repository(content: string): string {
	const root = mkdtempSync(join(tmpdir(), "plannotator-atlas-review-runtime-"));
	directories.push(root);
	writeFileSync(join(root, "main.ts"), content);
	return root;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("AtlasReviewRuntimeManager", () => {
	test("keeps a pending PR checkout pollable without opening a runtime", async () => {
		const manager = new AtlasReviewRuntimeManager(() => ({
			kind: "unavailable",
			code: "checkout-pending",
			message: "Checkout pending",
			retryable: true,
		}));
		try {
			expect(await manager.status()).toMatchObject({
				status: "indexing",
				phase: "checking",
				hasSnapshot: false,
				capability: {
					available: false,
					code: "checkout-pending",
					retryable: true,
				},
			});
		} finally {
			await manager.dispose();
		}
	});

	test("rejects terminal capability failures with their typed reason", async () => {
		const manager = new AtlasReviewRuntimeManager(() => ({
			kind: "unavailable",
			code: "multi-root-workspace",
			message: "Multiple roots",
			retryable: false,
		}));
		try {
			await expect(manager.status()).rejects.toBeInstanceOf(AtlasReviewUnavailableError);
		} finally {
			await manager.dispose();
		}
	});

	test("disposes and rebinds when the active checkout identity changes", async () => {
		const first = repository("export const checkout = 'first';\n");
		const second = repository("export const checkout = 'second';\n");
		let active = { rootPath: first, bindingKey: "pr:first" };
		const manager = new AtlasReviewRuntimeManager(() => ({
			kind: "ready",
			...active,
		}));
		try {
			await manager.status();
			expect((await manager.source("main.ts")).content).toContain("'first'");
			active = { rootPath: second, bindingKey: "pr:second" };
			await manager.status();
			expect((await manager.source("main.ts")).content).toContain("'second'");
		} finally {
			await manager.dispose();
		}
	});
});
