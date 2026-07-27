import type {
	StructuralFileOutline,
	StructuralRange,
} from "./atlas-structure";

export type CFamilyTestRangeReason =
	| "c-family-test-file"
	| "c-family-test-macro"
	| "c-family-test-function";

export interface CFamilyTestRange {
	startLine: number;
	endLine: number;
	reason: CFamilyTestRangeReason;
	confidence: "semantic" | "convention";
}

type TestFramework =
	| "gtest"
	| "boost-test"
	| "criterion"
	| "catch2"
	| "doctest"
	| "unity";

const C_FAMILY_EXTENSIONS = new Set([
	".c",
	".cc",
	".cpp",
	".cxx",
	".h",
	".hh",
	".hpp",
	".hxx",
]);

const TEST_DIRECTORIES = new Set(["test", "tests", "testing", "unittests"]);
const TEST_DATA_DIRECTORIES = new Set([
	"fixture",
	"fixtures",
	"golden",
	"resources",
	"snapshot",
	"snapshots",
	"testdata",
]);

const GTEST_MACROS = new Set([
	"TEST",
	"TEST_F",
	"TEST_P",
	"TYPED_TEST",
	"TYPED_TEST_P",
]);

const BOOST_TEST_MACROS = new Set([
	"BOOST_AUTO_TEST_CASE",
	"BOOST_FIXTURE_TEST_CASE",
	"BOOST_DATA_TEST_CASE",
	"BOOST_DATA_TEST_CASE_F",
	"BOOST_PARAM_TEST_CASE",
]);

const CRITERION_MACROS = new Set([
	"Test",
	"Theory",
	"ParameterizedTest",
]);

const CATCH2_BLOCK_MACROS = new Set([
	"TEST_CASE",
	"TEST_CASE_METHOD",
	"TEMPLATE_TEST_CASE",
	"TEMPLATE_TEST_CASE_METHOD",
	"TEMPLATE_LIST_TEST_CASE",
	"TEMPLATE_LIST_TEST_CASE_METHOD",
	"SCENARIO",
	"SCENARIO_METHOD",
]);

const DOCTEST_BLOCK_MACROS = new Set([
	"TEST_CASE",
	"TEST_CASE_FIXTURE",
	"TEST_CASE_TEMPLATE",
	"TEST_CASE_TEMPLATE_DEFINE",
	"SCENARIO",
	"DOCTEST_TEST_CASE",
	"DOCTEST_TEST_CASE_FIXTURE",
	"DOCTEST_TEST_CASE_TEMPLATE",
	"DOCTEST_TEST_CASE_TEMPLATE_DEFINE",
	"DOCTEST_SCENARIO",
]);

function lineCount(content: string): number {
	if (content.length === 0) return 0;
	const newlines = content.match(/\r\n|\r|\n/g)?.length ?? 0;
	return newlines + (/(?:\r\n|\r|\n)$/.test(content) ? 0 : 1);
}

function extension(filePath: string): string {
	const basename = filePath.replace(/\\/g, "/").split("/").at(-1) ?? "";
	const dot = basename.lastIndexOf(".");
	return dot < 0 ? "" : basename.slice(dot).toLowerCase();
}

function isConventionalTestFile(filePath: string): boolean {
	if (!C_FAMILY_EXTENSIONS.has(extension(filePath))) return false;
	const segments = filePath
		.replace(/\\/g, "/")
		.toLowerCase()
		.split("/")
		.filter(Boolean);
	if (segments.some((segment) => TEST_DATA_DIRECTORIES.has(segment))) return false;

	const basename = segments.at(-1)?.replace(/\.[^.]+$/, "") ?? "";
	if (/^(?:test|tests)(?:[_-].+)?$/.test(basename)) return true;
	if (/(?:^|[_-])tests?$/.test(basename)) return true;
	return segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment));
}

function includePaths(
	content: string,
	outline: StructuralFileOutline | undefined,
): Set<string> {
	const paths = new Set<string>();
	for (const item of outline?.items ?? []) {
		if (!item.isImport && item.astKind !== "preproc_include") continue;
		for (const candidate of [item.name, item.signature]) {
			const match = candidate.match(/[<"]([^>"]+)[>"]/);
			if (match) paths.add(match[1]!.replace(/\\/g, "/").toLowerCase());
		}
	}
	for (const match of content.matchAll(
		/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm,
	)) {
		paths.add(match[1]!.replace(/\\/g, "/").toLowerCase());
	}
	return paths;
}

function detectedFrameworks(
	content: string,
	outline: StructuralFileOutline | undefined,
): Set<TestFramework> {
	const frameworks = new Set<TestFramework>();
	for (const path of includePaths(content, outline)) {
		if (path.startsWith("gtest/") || path.startsWith("gmock/")) {
			frameworks.add("gtest");
		}
		if (path.startsWith("boost/test/")) frameworks.add("boost-test");
		if (path.startsWith("criterion/")) frameworks.add("criterion");
		if (
			path === "catch.hpp" ||
			path.endsWith("/catch.hpp") ||
			path.startsWith("catch2/") ||
			path.includes("/catch2/")
		) {
			frameworks.add("catch2");
		}
		if (
			path === "doctest.h" ||
			path.endsWith("/doctest.h") ||
			path.startsWith("doctest/") ||
			path.includes("/doctest/")
		) {
			frameworks.add("doctest");
		}
		if (path === "unity.h" || path.endsWith("/unity.h")) {
			frameworks.add("unity");
		}
	}
	return frameworks;
}

function endLine(range: StructuralRange, totalLines: number): number {
	const exclusiveEnd = range.end.column === 0 && range.end.line > range.start.line;
	return Math.min(totalLines, range.end.line + (exclusiveEnd ? 0 : 1));
}

function semanticRange(
	range: StructuralRange,
	totalLines: number,
	reason: Extract<
		CFamilyTestRangeReason,
		"c-family-test-macro" | "c-family-test-function"
	>,
): CFamilyTestRange | null {
	const startLine = range.start.line + 1;
	const finalLine = endLine(range, totalLines);
	if (startLine > totalLines || finalLine < startLine) return null;
	return {
		startLine,
		endLine: finalLine,
		reason,
		confidence: "semantic",
	};
}

function isOutlineTestMacro(
	name: string,
	frameworks: Set<TestFramework>,
): boolean {
	return (
		(frameworks.has("gtest") && GTEST_MACROS.has(name)) ||
		(frameworks.has("boost-test") && BOOST_TEST_MACROS.has(name)) ||
		(frameworks.has("criterion") && CRITERION_MACROS.has(name)) ||
		(frameworks.has("catch2") && CATCH2_BLOCK_MACROS.has(name)) ||
		(frameworks.has("doctest") && DOCTEST_BLOCK_MACROS.has(name))
	);
}

function unityRunTestNames(content: string): Set<string> {
	const masked = content.split("");
	let quote: "'" | '"' | null = null;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < content.length; index += 1) {
		const character = content[index]!;
		const next = content[index + 1];
		if (lineComment) {
			if (character === "\n") {
				lineComment = false;
			} else {
				masked[index] = " ";
			}
			continue;
		}
		if (blockComment) {
			if (character === "\n") continue;
			masked[index] = " ";
			if (character === "*" && next === "/") {
				masked[index + 1] = " ";
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (character === "\n") continue;
			masked[index] = " ";
			if (character === "\\") {
				if (next !== "\n") masked[index + 1] = " ";
				index += 1;
				continue;
			}
			if (character === quote) quote = null;
			continue;
		}
		if (character === "/" && next === "/") {
			masked[index] = " ";
			masked[index + 1] = " ";
			lineComment = true;
			index += 1;
			continue;
		}
		if (character === "/" && next === "*") {
			masked[index] = " ";
			masked[index + 1] = " ";
			blockComment = true;
			index += 1;
			continue;
		}
		if (character === "'" || character === '"') {
			masked[index] = " ";
			quote = character;
		}
	}

	const names = new Set<string>();
	for (const match of masked.join("").matchAll(
		/\bRUN_TEST\s*\(\s*([A-Za-z_]\w*)\s*(?:,|\))/g,
	)) {
		names.add(match[1]!);
	}
	return names;
}

function normalizeRanges(ranges: CFamilyTestRange[]): CFamilyTestRange[] {
	const result: CFamilyTestRange[] = [];
	const ordered = [...ranges].sort(
		(first, second) =>
			first.startLine - second.startLine ||
			second.endLine - first.endLine,
	);
	for (const range of ordered) {
		const previous = result.at(-1);
		if (!previous || range.startLine > previous.endLine) {
			result.push({ ...range });
			continue;
		}
		if (range.endLine <= previous.endLine) continue;
		previous.endLine = range.endLine;
	}
	return result;
}

/**
 * Classify C and C++ tests from exact ast-grep ranges.
 *
 * Framework-specific declarations require a matching include in the same file.
 * The source is never scanned for braces or used to manufacture item ranges.
 */
export function classifyCFamilyTestRanges(
	filePath: string,
	content: string,
	outline: StructuralFileOutline | undefined,
): CFamilyTestRange[] {
	const totalLines = lineCount(content);
	if (totalLines === 0) return [];
	if (isConventionalTestFile(filePath)) {
		return [{
			startLine: 1,
			endLine: totalLines,
			reason: "c-family-test-file",
			confidence: "convention",
		}];
	}

	const frameworks = detectedFrameworks(content, outline);
	const unityTests = frameworks.has("unity")
		? unityRunTestNames(content)
		: new Set<string>();
	const ranges: CFamilyTestRange[] = [];
	for (const item of outline?.items ?? []) {
		if (
			item.astKind === "function_definition" &&
			isOutlineTestMacro(item.name, frameworks)
		) {
			const range = semanticRange(
				item.range,
				totalLines,
				"c-family-test-macro",
			);
			if (range) ranges.push(range);
			continue;
		}
		if (
			frameworks.has("unity") &&
			item.astKind === "function_definition" &&
			unityTests.has(item.name)
		) {
			const range = semanticRange(
				item.range,
				totalLines,
				"c-family-test-function",
			);
			if (range) ranges.push(range);
		}
	}

	return normalizeRanges(ranges);
}
