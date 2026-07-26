import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAtlasSnapshot } from "./atlas";
import {
	findAtlasDeclarations,
	readAtlasSource,
	resolveAtlasSourcePath,
	validateAtlasRelativePath,
} from "./atlas-source";

const fixtures: string[] = [];

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "plannotator-atlas-"));
	fixtures.push(root);
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
	await writeFile(
		join(root, "src", "math.ts"),
		[
			"export interface Operation { run(value: number): number }",
			"export type Numeric = number;",
			"export function double(value: number) {",
			"  if (value > 10 && value < 20) return value * 2;",
			"  return value + value;",
			"}",
		].join("\n"),
	);
	await writeFile(
		join(root, "src", "main.ts"),
		[
			'import {',
			"  type Numeric,",
			"  double,",
			'} from "./math";',
			'import React from "react";',
			'// import { fake } from "./fake";',
			"export const run = (value: Numeric) => double(value);",
		].join("\n"),
	);
	await writeFile(join(root, "src", "tool.py"), "class Tool:\n    def run(self):\n        return True\n");
	await writeFile(join(root, "node_modules", "ignored", "index.ts"), "export const ignored = true;");
	await writeFile(join(root, "src", "generated.ts"), "// Code generated. DO NOT EDIT.\nexport const generated = 1;");
	await writeFile(join(root, "src", "binary.ts"), Buffer.from([0, 1, 2, 3]));
	return root;
}

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("buildAtlasSnapshot", () => {
	test("builds stable nested nodes, metrics, symbols, and dependencies", async () => {
		const root = await fixture();
		const snapshot = await buildAtlasSnapshot(root);

		expect(snapshot.version).toBe(2);
		expect(snapshot.analyzers.structural).toEqual(expect.objectContaining({
			name: "ast-grep",
			version: expect.any(String),
		}));
		expect(snapshot.rootId).toBe("root");
		expect(snapshot.summary.files).toBe(3);
		expect(snapshot.summary.directories).toBe(1);
		expect(snapshot.rootName).toBe(root.split("/").pop()!);
		expect(snapshot.summary.languages.typescript?.files).toBe(2);
		expect(snapshot.summary.languages.python?.files).toBe(1);
		expect(snapshot.summary.skippedFiles).toBeGreaterThanOrEqual(2);

		const sourceDirectory = snapshot.nodes.find((node) => node.id === "dir:src");
		const main = snapshot.nodes.find((node) => node.id === "file:src/main.ts");
		const math = snapshot.nodes.find((node) => node.id === "file:src/math.ts");
		expect(sourceDirectory?.parentId).toBe("root");
		expect(sourceDirectory?.depth).toBe(1);
		expect(sourceDirectory?.childIds).toContain("file:src/main.ts");
		expect(sourceDirectory?.bytes).toBe(snapshot.summary.bytes);
		expect(main?.language).toBe("typescript");
		expect(math?.symbols.map((symbol) => [symbol.kind, symbol.name])).toEqual([
			["interface", "Operation"],
			["method", "run"],
			["type", "Numeric"],
			["function", "double"],
		]);
		expect(math?.symbols.every((symbol) => symbol.column > 0)).toBe(true);
		expect(main?.symbols.some((symbol) => symbol.name === "Numeric")).toBe(false);
		expect(math?.complexity).toBeGreaterThan(1);
		expect(math?.symbols[0]?.complexity).toBe(1);
		expect(math?.symbols.find((symbol) => symbol.name === "double")?.complexity).toBeGreaterThan(1);

		expect(snapshot.dependencies).toEqual([
			expect.objectContaining({
				sourceId: "file:src/main.ts",
				specifier: "./math",
				targetId: "file:src/math.ts",
				targetPath: "src/math.ts",
				count: 1,
			}),
			expect.objectContaining({
				sourceId: "file:src/main.ts",
				specifier: "react",
				targetId: null,
				targetPath: null,
			}),
		]);
	});

	test("enforces file and byte budgets", async () => {
		const root = await fixture();
		const byFiles = await buildAtlasSnapshot(root, { maxFiles: 1 });
		expect(byFiles.summary.truncated).toBe(true);
		expect(byFiles.summary.files).toBeLessThanOrEqual(1);

		const byBytes = await buildAtlasSnapshot(root, { maxTotalBytes: 1 });
		expect(byBytes.summary.truncated).toBe(true);
		expect(byBytes.summary.files).toBe(0);
	});

	test("preserves language-specific struct and trait kinds", async () => {
		const root = await fixture();
		await writeFile(
			join(root, "src", "model.go"),
			"type Record struct {}\ntype Runner interface {}\n",
		);
		await writeFile(
			join(root, "src", "model.rs"),
			"pub struct Record;\npub trait Runner {}\n",
		);
		await writeFile(
			join(root, "src", "model.hpp"),
			"struct Record {};\nclass Runner {};\n",
		);

		const snapshot = await buildAtlasSnapshot(root);
		expect(snapshot.nodes.find((node) => node.path === "src/model.go")?.symbols)
			.toEqual(expect.arrayContaining([
				expect.objectContaining({ name: "Record", kind: "struct" }),
				expect.objectContaining({ name: "Runner", kind: "interface" }),
			]));
		expect(snapshot.nodes.find((node) => node.path === "src/model.rs")?.symbols)
			.toEqual(expect.arrayContaining([
				expect.objectContaining({ name: "Record", kind: "struct" }),
				expect.objectContaining({ name: "Runner", kind: "trait" }),
			]));
		expect(snapshot.nodes.find((node) => node.path === "src/model.hpp")?.symbols)
			.toEqual(expect.arrayContaining([
				expect.objectContaining({ name: "Record", kind: "struct" }),
				expect.objectContaining({ name: "Runner", kind: "class" }),
			]));
	});
});

describe("Atlas source helpers", () => {
	test("reads files and searches bounded references", async () => {
		const root = await fixture();
		const snapshot = await buildAtlasSnapshot(root);
		const source = await readAtlasSource(root, "src/main.ts");
		expect(source.content).toContain("double(value)");
		expect(source.language).toBe("typescript");

		const references = await findAtlasDeclarations(snapshot, "double", undefined, {
			maxResults: 2,
		});
		expect(references).toHaveLength(1);
		expect(references[0]?.filePath).toBe("src/math.ts");
		expect(references[0]?.kind).toBe("definition");
		expect(references[0]?.line).toBeGreaterThan(0);

		const filtered = await findAtlasDeclarations(snapshot, "double", "src/math.ts");
		expect(filtered).toHaveLength(1);
		expect(filtered[0]).toEqual(expect.objectContaining({
			kind: "definition",
			filePath: "src/math.ts",
		}));
	});

	test("rejects traversal and symlinks that leave the root", async () => {
		const root = await fixture();
		const outside = await mkdtemp(join(tmpdir(), "plannotator-atlas-outside-"));
		fixtures.push(outside);
		await writeFile(join(outside, "secret.ts"), "secret");
		await symlink(join(outside, "secret.ts"), join(root, "src", "linked.ts"));

		expect(() => validateAtlasRelativePath("../secret.ts")).toThrow();
		await expect(resolveAtlasSourcePath(root, "src/linked.ts")).rejects.toThrow(
			"escapes the repository root",
		);
	});
});
