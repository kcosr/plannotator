import { describe, expect, test } from "bun:test";
import type {
	StructuralFileOutline,
	StructuralItem,
} from "./atlas-structure";
import { classifyJavaScriptTestRanges } from "./atlas-test-classification-js";

function structuralItem(
	contentLines: string[],
	line: number,
	options: { isImport?: boolean; astKind?: string } = {},
): StructuralItem {
	const source = contentLines[line - 1]!;
	return {
		role: "item",
		symbolType: options.isImport ? "module" : "constant",
		name: options.isImport ? "'framework'" : "binding",
		range: {
			start: { line: line - 1, column: 0 },
			end: { line: line - 1, column: source.length },
		},
		signature: source,
		astKind: options.astKind ?? (options.isImport
			? "import_statement"
			: "variable_declarator"),
		isImport: options.isImport ?? false,
		isExported: false,
	};
}

function outline(
	path: string,
	contentLines: string[],
	entries: Array<{ line: number; isImport?: boolean; astKind?: string }>,
): StructuralFileOutline {
	return {
		path,
		language: path.endsWith("x") ? "Tsx" : "TypeScript",
		items: entries.map((entry) => structuralItem(contentLines, entry.line, entry)),
	};
}

describe("classifyJavaScriptTestRanges", () => {
	test("classifies conventional test files and directories in full", () => {
		const source = "const helper = 1;\ntest('works', () => {});\n";
		for (const filePath of [
			"src/widget.test.ts",
			"src/widget-spec.tsx",
			"src/__tests__/widget.js",
			"test/widget.mjs",
			"e2e/login.cy.ts",
		]) {
			expect(classifyJavaScriptTestRanges(filePath, source, undefined)).toEqual([{
				startLine: 1,
				endLine: 2,
				reason: "js-test-file",
				confidence: "convention",
			}]);
		}

		expect(
			classifyJavaScriptTestRanges("src/contest.ts", source, undefined),
		).toEqual([]);
		expect(
			classifyJavaScriptTestRanges("src/test-utils.ts", source, undefined),
		).toEqual([]);
	});

	test("recognizes aliased named imports in mixed source files", () => {
		const lines = [
			"import { describe as group, test as check } from 'vitest';",
			"export function live() {}",
			"group('feature', () => {",
			"  check.each([1, 2])('case', value => {",
			"    expect(value).toBeTruthy();",
			"  });",
			"});",
		];
		const fileOutline = outline("src/feature.ts", lines, [{
			line: 1,
			isImport: true,
		}]);

		expect(classifyJavaScriptTestRanges(
			"src/feature.ts",
			lines.join("\n"),
			fileOutline,
		)).toEqual([
			{
				startLine: 3,
				endLine: 7,
				reason: "js-test-call",
				confidence: "semantic",
			},
		]);
	});

	test("balances parameterized each and for factory calls", () => {
		const lines = [
			"import { describe, test } from 'vitest';",
			"test.each(cases.map((item) => ({",
			"  value: item,",
			"})))('mapped %s', ({ value }) => {",
			"  expect(value).toBeTruthy();",
			"});",
			"test.for([{ value: 1 }])(",
			"  'scoped',",
			"  ({ value }) => expect(value).toBe(1),",
			");",
		];
		const fileOutline = outline("src/feature.ts", lines, [{
			line: 1,
			isImport: true,
		}]);

		expect(classifyJavaScriptTestRanges(
			"src/feature.ts",
			lines.join("\n"),
			fileOutline,
		)).toEqual([
			expect.objectContaining({ startLine: 2, endLine: 6 }),
			expect.objectContaining({ startLine: 7, endLine: 10 }),
		]);
	});

	test("supports tagged-template each tables with interpolations", () => {
		const lines = [
			"import { test } from 'vitest';",
			"test.each`",
			"  left | right | total",
			"  ${1} | ${2}  | ${3}",
			"`('adds $left and $right', ({ left, right, total }) => {",
			"  expect(left + right).toBe(total);",
			"});",
		];
		const fileOutline = outline("src/feature.ts", lines, [{
			line: 1,
			isImport: true,
		}]);

		expect(classifyJavaScriptTestRanges(
			"src/feature.ts",
			lines.join("\n"),
			fileOutline,
		)).toEqual([{
			startLine: 2,
			endLine: 7,
			reason: "js-test-call",
			confidence: "semantic",
		}]);
	});

	test("masks regex literals without treating division as regex", () => {
		const lines = [
			"import { test } from 'vitest';",
			"test('regex', () => {",
			"  const matcher = /https?:\\/\\/[^/]+\\/[()](foo|bar\\))/gi;",
			"  const ratio = total / (count + 1) / scale;",
			"  expect(matcher.test(String(ratio))).toBe(false);",
			"});",
			"test('next', () => {});",
		];
		const fileOutline = outline("src/feature.ts", lines, [{
			line: 1,
			isImport: true,
		}]);

		expect(classifyJavaScriptTestRanges(
			"src/feature.ts",
			lines.join("\n"),
			fileOutline,
		)).toEqual([
			expect.objectContaining({ startLine: 2, endLine: 6 }),
			expect.objectContaining({ startLine: 7, endLine: 7 }),
		]);
	});

	test("keeps keyword-named properties as division operands", () => {
		const lines = [
			"import { test } from 'vitest';",
			"test('division', () => {",
			"  const first = iterator.return / (total / 2);",
			"  const second = cache.delete / (width / 2);",
			"});",
			"test('next', () => {});",
		];
		const fileOutline = outline("src/feature.ts", lines, [{
			line: 1,
			isImport: true,
		}]);

		expect(classifyJavaScriptTestRanges(
			"src/feature.ts",
			lines.join("\n"),
			fileOutline,
		)).toEqual([
			expect.objectContaining({ startLine: 2, endLine: 5 }),
			expect.objectContaining({ startLine: 6, endLine: 6 }),
		]);
	});

	test("masks statement regexes after control heads and blocks", () => {
		const lines = [
			"import { test } from 'vitest';",
			"test('statement regex', () => {",
			"  if (ready) /[(]/.test(value);",
			"  { prepare(); }",
			"  /[)]/.test(value);",
			"  expect(value).toBeTruthy();",
			"});",
			"test('next', () => {});",
		];
		const fileOutline = outline("src/feature.ts", lines, [{
			line: 1,
			isImport: true,
		}]);

		expect(classifyJavaScriptTestRanges(
			"src/feature.ts",
			lines.join("\n"),
			fileOutline,
		)).toEqual([
			expect.objectContaining({ startLine: 2, endLine: 7 }),
			expect.objectContaining({ startLine: 8, endLine: 8 }),
		]);
	});

	test("ignores test-like calls inside comments and strings", () => {
		const lines = [
			"import { test } from 'vitest';",
			"/*",
			"test('comment', () => {});",
			"*/",
			"const example = `",
			"test('template', () => {});",
			"`;",
			"test('real', () => {});",
		];
		const fileOutline = outline("src/feature.ts", lines, [{
			line: 1,
			isImport: true,
		}]);

		expect(classifyJavaScriptTestRanges(
			"src/feature.ts",
			lines.join("\n"),
			fileOutline,
		)).toEqual([expect.objectContaining({
			startLine: 8,
			endLine: 8,
		})]);
	});

	test("supports namespaces, default bindings, require aliases, and modifiers", () => {
		const lines = [
			"import * as runner from '@playwright/test';",
			"import verify from 'ava';",
			"const { test: check } = require('node:test');",
			"const mocha = require('mocha');",
			"runner.test.describe.only('browser', () => {});",
			"verify.serial('unit', () => {});",
			"check.skip('node', () => {});",
			"mocha.suite('legacy', () => {});",
		];
		const fileOutline = outline("src/checks.ts", lines, [
			{ line: 1, isImport: true },
			{ line: 2, isImport: true },
			{ line: 3 },
			{ line: 4 },
		]);

		expect(classifyJavaScriptTestRanges(
			"src/checks.ts",
			lines.join("\n"),
			fileOutline,
		)).toEqual([
			expect.objectContaining({ startLine: 5, endLine: 5 }),
			expect.objectContaining({ startLine: 6, endLine: 6 }),
			expect.objectContaining({ startLine: 7, endLine: 7 }),
			expect.objectContaining({ startLine: 8, endLine: 8 }),
		]);
	});

	test("recognizes Deno tests without an import", () => {
		const source = [
			"export function live() {}",
			"Deno.test('works', () => {",
			"  live();",
			"});",
		].join("\n");

		expect(classifyJavaScriptTestRanges(
			"src/mod.ts",
			source,
			undefined,
		)).toEqual([{
			startLine: 2,
			endLine: 4,
			reason: "js-test-call",
			confidence: "semantic",
		}]);
	});

	test("does not trust unbound globals or similarly named package APIs", () => {
		const lines = [
			"import { test } from 'some-production-library';",
			"describe('not proven', () => {});",
			"test('also not proven', () => {});",
			"runner.contest('not an API', () => {});",
		];
		const fileOutline = outline("src/runtime.ts", lines, [{
			line: 1,
			isImport: true,
		}]);

		expect(classifyJavaScriptTestRanges(
			"src/runtime.ts",
			lines.join("\n"),
			fileOutline,
		)).toEqual([]);
	});
});
