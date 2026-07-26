import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAtlasSnapshot } from "./atlas";
import type { AtlasSemanticSession } from "./atlas-semantic";
import {
	findAtlasDeclarations,
	readAtlasSource,
	resolveAtlasCallHierarchy,
	resolveAtlasSourcePath,
	validateAtlasRelativePath,
} from "./atlas-source";

const fixtures: string[] = [];

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "plannotator-atlas-"));
	fixtures.push(root);
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(join(root, ".plannotator"), { recursive: true });
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
	await writeFile(join(root, ".plannotator", "ignored.ts"), "export const ignored = true;");
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

		expect(snapshot.version).toBe(4);
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

	test("classifies and aggregates mixed Rust test code", async () => {
		const root = await fixture();
		await mkdir(join(root, "tests"), { recursive: true });
		await mkdir(join(root, "benches"), { recursive: true });
		await writeFile(
			join(root, "src", "lib.rs"),
			[
				"pub fn live() -> bool { true }",
				"",
				"#[cfg(test)]",
				"mod tests {",
				"    fn helper() -> bool { true }",
				"",
				"    #[test]",
				"    fn works() { assert!(helper()); }",
				"}",
				"",
				"#[tokio::test]",
				"async fn async_test() {}",
			].join("\n"),
		);
		await writeFile(
			join(root, "tests", "api.rs"),
			"fn helper() {}\n#[test]\nfn integration_test() {}\n",
		);
		await writeFile(join(root, "benches", "throughput.rs"), "fn benchmark_helper() {}\n");

		const snapshot = await buildAtlasSnapshot(root);
		const library = snapshot.nodes.find((node) => node.path === "src/lib.rs")!;
		const integration = snapshot.nodes.find((node) => node.path === "tests/api.rs")!;
		const benchmark = snapshot.nodes.find((node) => node.path === "benches/throughput.rs")!;

		expect(library.testRanges).toEqual([
			expect.objectContaining({ startLine: 3, endLine: 9, reason: "rust-cfg-test" }),
			expect.objectContaining({ startLine: 11, endLine: 12, reason: "rust-test-attribute" }),
		]);
		expect(library.testLines).toBe(9);
		expect(library.testBytes).toBeGreaterThan(0);
		expect(library.testBytes).toBeLessThan(library.bytes);
		expect(library.symbols.find((symbol) => symbol.name === "live")?.isTest).toBe(false);
		expect(library.symbols.find((symbol) => symbol.name === "tests")?.isTest).toBe(true);
		expect(library.symbols.find((symbol) => symbol.name === "helper")?.isTest).toBe(true);
		expect(library.symbols.find((symbol) => symbol.name === "async_test")?.isTest).toBe(true);

		expect(integration.testLines).toBe(integration.lines);
		expect(integration.testBytes).toBe(integration.bytes);
		expect(integration.symbols.every((symbol) => symbol.isTest)).toBe(true);
		expect(benchmark.testLines).toBe(0);
		expect(benchmark.symbols.every((symbol) => !symbol.isTest)).toBe(true);

		expect(snapshot.nodes.find((node) => node.id === "root")).toEqual(
			expect.objectContaining({
				testLines: library.testLines + integration.testLines,
				testBytes: library.testBytes + integration.testBytes,
				testComplexity: library.testComplexity + integration.testComplexity,
			}),
		);
	});

	test("propagates cfg-test status into external Rust modules", async () => {
		const root = await fixture();
		await mkdir(join(root, "src", "tests"), { recursive: true });
		await writeFile(
			join(root, "src", "lib.rs"),
			"pub fn live() {}\n#[cfg(test)]\nmod tests;\n",
		);
		await writeFile(
			join(root, "src", "tests.rs"),
			"fn helper() {}\nmod support;\n",
		);
		await writeFile(
			join(root, "src", "tests", "support.rs"),
			"fn nested_helper() {}\n",
		);
		await writeFile(
			join(root, "src", "orphan_tests.rs"),
			"fn not_referenced() {}\n",
		);

		const snapshot = await buildAtlasSnapshot(root);
		const library = snapshot.nodes.find((node) => node.path === "src/lib.rs")!;
		const tests = snapshot.nodes.find((node) => node.path === "src/tests.rs")!;
		const support = snapshot.nodes.find((node) => node.path === "src/tests/support.rs")!;
		const orphan = snapshot.nodes.find((node) => node.path === "src/orphan_tests.rs")!;

		expect(library.testLines).toBe(2);
		expect(tests.testLines).toBe(tests.lines);
		expect(tests.testBytes).toBe(tests.bytes);
		expect(tests.symbols.every((symbol) => symbol.isTest)).toBe(true);
		expect(support.testLines).toBe(support.lines);
		expect(support.symbols.every((symbol) => symbol.isTest)).toBe(true);
		expect(orphan.testLines).toBe(0);
		expect(orphan.symbols.every((symbol) => !symbol.isTest)).toBe(true);
	});

	test("classifies conventional tests across supported languages", async () => {
		const root = await fixture();
		await mkdir(join(root, "tests"), { recursive: true });
		await mkdir(join(root, "internal"), { recursive: true });
		await mkdir(join(root, "src", "test", "java"), { recursive: true });
		await mkdir(join(root, "spec"), { recursive: true });
		await writeFile(join(root, "tests", "test_service.py"), "def test_service():\n    assert True\n");
		await writeFile(
			join(root, "internal", "service_test.go"),
			"package internal\n\nfunc TestService(t *testing.T) {}\n",
		);
		await writeFile(
			join(root, "src", "test", "java", "ServiceTest.java"),
			"class ServiceTest { void works() {} }\n",
		);
		await writeFile(
			join(root, "spec", "service_spec.rb"),
			"describe Service do\n  it('works') { }\nend\n",
		);
		await writeFile(
			join(root, "tests", "widget.spec.ts"),
			"import { test } from 'vitest';\ntest('works', () => {});\n",
		);
		await writeFile(
			join(root, "tests", "parser_test.cpp"),
			"void parser_test() {}\n",
		);

		const snapshot = await buildAtlasSnapshot(root);
		for (const path of [
			"tests/test_service.py",
			"internal/service_test.go",
			"src/test/java/ServiceTest.java",
			"spec/service_spec.rb",
			"tests/widget.spec.ts",
			"tests/parser_test.cpp",
		]) {
			const node = snapshot.nodes.find((candidate) => candidate.path === path)!;
			expect(node.testLines).toBe(node.lines);
			expect(node.testBytes).toBe(node.bytes);
			expect(node.symbols.every((symbol) => symbol.isTest)).toBe(true);
		}
	});
});

describe("Atlas source helpers", () => {
	test("reads files and searches bounded references", async () => {
		const root = await fixture();
		const snapshot = await buildAtlasSnapshot(root);
		const source = await readAtlasSource(root, "src/main.ts");
		expect(source.content).toContain("double(value)");
		expect(source.language).toBe("typescript");

		const references = await findAtlasDeclarations(root, snapshot, "double", undefined, {
			maxResults: 2,
		});
		expect(references).toHaveLength(1);
		expect(references[0]?.filePath).toBe("src/math.ts");
		expect(references[0]?.kind).toBe("definition");
		expect(references[0]?.line).toBeGreaterThan(0);

		const filtered = await findAtlasDeclarations(root, snapshot, "double", "src/math.ts");
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

	test("groups semantic callers and callees with exact repository call sites", async () => {
		const root = await fixture();
		const snapshot = await buildAtlasSnapshot(root, {
			semanticProviders: [{
				language: "typescript",
				name: "typescript-language-server",
				available: true,
			}],
		});
		const session = {
			findCallHierarchy: async () => ({
				supported: true,
				root: {
					name: "run",
					kind: 12,
					location: {
						filePath: "src/main.ts",
						range: {
							start: { line: 7, column: 1 },
							end: { line: 7, column: 60 },
						},
						external: false,
					},
					selectionRange: {
						start: { line: 7, column: 14 },
						end: { line: 7, column: 17 },
					},
				},
				incoming: [{
					item: {
						name: "double",
						kind: 12,
						location: {
							filePath: "src/math.ts",
							range: {
								start: { line: 3, column: 1 },
								end: { line: 6, column: 2 },
							},
							external: false,
						},
						selectionRange: {
							start: { line: 3, column: 17 },
							end: { line: 3, column: 23 },
						},
					},
					fromRanges: [{
						start: { line: 5, column: 10 },
						end: { line: 5, column: 16 },
					}],
				}],
				outgoing: [{
					item: {
						name: "double",
						kind: 12,
						detail: "(value: number) => number",
						location: {
							filePath: "src/math.ts",
							range: {
								start: { line: 3, column: 1 },
								end: { line: 6, column: 2 },
							},
							external: false,
						},
						selectionRange: {
							start: { line: 3, column: 17 },
							end: { line: 3, column: 23 },
						},
					},
					fromRanges: [{
						start: { line: 7, column: 40 },
						end: { line: 7, column: 46 },
					}],
				}],
			}),
		} as unknown as AtlasSemanticSession;

		const result = await resolveAtlasCallHierarchy(
			session,
			root,
			snapshot,
			"src/main.ts",
			7,
			15,
		);

			expect(result.provider).toEqual({
				kind: "lsp",
				name: "typescript-language-server",
				status: "ready",
			});
			expect(result.truncated).toBe(false);
		expect(result.root).toEqual(expect.objectContaining({
			name: "run",
			declaration: expect.objectContaining({
				fileId: "file:src/main.ts",
				filePath: "src/main.ts",
				line: 7,
			}),
			callSites: [],
		}));
		expect(result.callers[0]).toEqual(expect.objectContaining({
			name: "double",
			declaration: expect.objectContaining({ fileId: "file:src/math.ts", line: 3 }),
			callSites: [
				expect.objectContaining({
					filePath: "src/math.ts",
					line: 5,
					snippet: "  return value + value;",
				}),
			],
		}));
		expect(result.callees[0]).toEqual(expect.objectContaining({
			name: "double",
			detail: "(value: number) => number",
			callSites: [
				expect.objectContaining({
					filePath: "src/main.ts",
					line: 7,
				}),
			],
		}));
	});
});
