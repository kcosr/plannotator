import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAtlasRepositoryFingerprint } from "./atlas-repository-fingerprint";

const temporaryDirectories: string[] = [];

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "plannotator-atlas-fingerprint-"));
	temporaryDirectories.push(root);
	return root;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("collectAtlasRepositoryFingerprint", () => {
	test("tracks repository text content and ignores excluded paths", async () => {
		const root = repository();
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, ".plannotator"));
		mkdirSync(join(root, "node_modules", "package"), { recursive: true });
		writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
		writeFileSync(join(root, "README.md"), "first\n");
		writeFileSync(join(root, ".plannotator", "generated.ts"), "export const cache = 1;\n");
		writeFileSync(
			join(root, "node_modules", "package", "index.ts"),
			"export const dependency = 1;\n",
		);

		const initial = await collectAtlasRepositoryFingerprint(root);
		expect(initial.files).toBe(2);
		expect(initial.truncated).toBe(false);

		writeFileSync(join(root, ".plannotator", "generated.ts"), "export const cache = 2;\n");
		writeFileSync(
			join(root, "node_modules", "package", "index.ts"),
			"export const dependency = 2;\n",
		);
		expect((await collectAtlasRepositoryFingerprint(root)).fingerprint)
			.toBe(initial.fingerprint);

		writeFileSync(join(root, "README.md"), "second\n");
		expect((await collectAtlasRepositoryFingerprint(root)).fingerprint)
			.not.toBe(initial.fingerprint);

		const afterReadme = await collectAtlasRepositoryFingerprint(root);
		writeFileSync(join(root, "src", "main.ts"), "export const value = 2;\n");
		expect((await collectAtlasRepositoryFingerprint(root)).fingerprint)
			.not.toBe(afterReadme.fingerprint);
	});

	test("does not follow symlinks outside the repository", async () => {
		const parent = repository();
		const root = join(parent, "repo");
		mkdirSync(root);
		const outside = join(parent, "outside.ts");
		writeFileSync(outside, "export const secret = 1;\n");
		symlinkSync(outside, join(root, "linked.ts"));

		const result = await collectAtlasRepositoryFingerprint(root);
		expect(result.files).toBe(0);
	});

	test("honors Git ignore rules while retaining untracked source files", async () => {
		const root = repository();
		expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
		writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
		writeFileSync(join(root, "ignored.ts"), "export const ignored = 1;\n");
		writeFileSync(join(root, "visible.ts"), "export const visible = 1;\n");
		mkdirSync(join(root, ".plannotator"));
		writeFileSync(join(root, ".plannotator", "generated.ts"), "export const cache = 1;\n");

		const initial = await collectAtlasRepositoryFingerprint(root);
		expect(initial.files).toBe(2);
		writeFileSync(join(root, "ignored.ts"), "export const ignored = 2;\n");
		writeFileSync(join(root, ".plannotator", "generated.ts"), "export const cache = 2;\n");
		expect((await collectAtlasRepositoryFingerprint(root)).fingerprint)
			.toBe(initial.fingerprint);
		writeFileSync(join(root, "visible.ts"), "export const visible = 2;\n");
		expect((await collectAtlasRepositoryFingerprint(root)).fingerprint)
			.not.toBe(initial.fingerprint);
	});

	test("includes limits and truncation in the fingerprint", async () => {
		const root = repository();
		writeFileSync(join(root, "a.ts"), "a\n");
		writeFileSync(join(root, "b.ts"), "b\n");

		const oneFile = await collectAtlasRepositoryFingerprint(root, { maxFiles: 1 });
		const twoFiles = await collectAtlasRepositoryFingerprint(root, { maxFiles: 2 });
		expect(oneFile.files).toBe(1);
		expect(oneFile.truncated).toBe(true);
		expect(twoFiles.files).toBe(2);
		expect(twoFiles.truncated).toBe(false);
		expect(oneFile.fingerprint).not.toBe(twoFiles.fingerprint);
	});

	test("streams complete oversized files into the fingerprint", async () => {
		const root = repository();
		writeFileSync(join(root, "large.txt"), "prefix\nmiddle\nsuffix\n");

		const initial = await collectAtlasRepositoryFingerprint(root, { maxFileBytes: 4 });
		expect(initial.files).toBe(1);
		expect(initial.bytes).toBe(21);
		expect(initial.truncated).toBe(true);

		writeFileSync(join(root, "large.txt"), "prefix\nchanged\nsuffix\n");
			const changed = await collectAtlasRepositoryFingerprint(root, { maxFileBytes: 4 });
			expect(changed.fingerprint).not.toBe(initial.fingerprint);
		});

	test("detects same-size middle-only changes beyond the old edge sample", async () => {
		const root = repository();
		const filePath = join(root, "large.txt");
		const prefix = "p".repeat(12 * 1024);
		const suffix = "s".repeat(12 * 1024);
		writeFileSync(filePath, `${prefix}middle-a${suffix}`);
		const initial = await collectAtlasRepositoryFingerprint(root, {
			maxFileBytes: 1024,
			maxTotalBytes: 1024,
		});

		writeFileSync(filePath, `${prefix}middle-b${suffix}`);
		const changed = await collectAtlasRepositoryFingerprint(root, {
			maxFileBytes: 1024,
			maxTotalBytes: 1024,
		});
		expect(changed.fingerprint).not.toBe(initial.fingerprint);
	});
});
