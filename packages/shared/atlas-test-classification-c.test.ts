import { describe, expect, test } from "bun:test";
import type {
	StructuralFileOutline,
	StructuralItem,
} from "./atlas-structure";
import {
	classifyCFamilyTestRanges,
} from "./atlas-test-classification-c";

function include(path: string, line = 1): StructuralItem {
	return {
		role: "item",
		symbolType: "module",
		name: `<${path}>`,
		range: {
			start: { line: line - 1, column: 0 },
			end: { line, column: 0 },
		},
		signature: `#include <${path}>`,
		astKind: "preproc_include",
		isImport: true,
		isExported: false,
	};
}

function functionItem(
	name: string,
	startLine: number,
	endLine: number,
): StructuralItem {
	return {
		role: "item",
		symbolType: "function",
		name,
		range: {
			start: { line: startLine - 1, column: 0 },
			end: { line: endLine - 1, column: 1 },
		},
		signature: `${name}(...) {`,
		astKind: "function_definition",
		isImport: false,
		isExported: true,
	};
}

function outline(
	path: string,
	items: StructuralItem[],
	language = "Cpp",
): StructuralFileOutline {
	return { path, language, items };
}

describe("classifyCFamilyTestRanges", () => {
	test("classifies conservative test file conventions as whole files", () => {
		const source = "void helper() {}\nvoid run() {}\n";
		for (const path of [
			"tests/parser.cpp",
			"src/testing/parser.cc",
			"src/parser_test.c",
			"src/test_parser.cxx",
			"src/parser-tests.hpp",
			"test.cpp",
		]) {
			expect(classifyCFamilyTestRanges(path, source, undefined)).toEqual([{
				startLine: 1,
				endLine: 2,
				reason: "c-family-test-file",
				confidence: "convention",
			}]);
		}
	});

	test("does not treat test data or test-like substrings as test files", () => {
		const source = "void helper() {}\n";
		for (const path of [
			"tests/fixtures/parser.cpp",
			"testdata/parser.c",
			"src/contest.cpp",
			"src/latest.cpp",
			"src/testing_utils.cpp",
			"docs/test_parser.md",
		]) {
			expect(classifyCFamilyTestRanges(path, source, undefined)).toEqual([]);
		}
	});

	test("classifies GTest macros only with GTest include provenance", () => {
		const source = [
			"#include <gtest/gtest.h>",
			"TEST(Parser, accepts_input) {",
			"  EXPECT_TRUE(true);",
			"}",
			"void helper() {}",
		].join("\n");
		const items = [
			include("gtest/gtest.h"),
			functionItem("TEST", 2, 4),
			functionItem("helper", 5, 5),
		];

		expect(classifyCFamilyTestRanges(
			"src/parser_spec.cpp",
			source,
			outline("src/parser_spec.cpp", items),
		)).toEqual([{
			startLine: 2,
			endLine: 4,
			reason: "c-family-test-macro",
			confidence: "semantic",
		}]);
		expect(classifyCFamilyTestRanges(
			"src/parser_spec.cpp",
			source.replace("gtest/gtest.h", "project/test_helpers.h"),
			outline("src/parser_spec.cpp", items.slice(1)),
		)).toEqual([]);
	});

	test("supports Boost.Test and Criterion declaration macros", () => {
		const boostSource = [
			"#include <boost/test/unit_test.hpp>",
			"BOOST_AUTO_TEST_CASE(parses) {",
			"  BOOST_TEST(true);",
			"}",
		].join("\n");
		expect(classifyCFamilyTestRanges(
			"src/parser_spec.cpp",
			boostSource,
			outline("src/parser_spec.cpp", [
				include("boost/test/unit_test.hpp"),
				functionItem("BOOST_AUTO_TEST_CASE", 2, 4),
			]),
		)).toEqual([
			expect.objectContaining({
				startLine: 2,
				endLine: 4,
				reason: "c-family-test-macro",
			}),
		]);

		const criterionSource = [
			"#include <criterion/criterion.h>",
			"Test(parser, accepts_input) {",
			"  cr_assert(true);",
			"}",
			"Theory((int value), parser, values) {}",
		].join("\n");
		expect(classifyCFamilyTestRanges(
			"src/parser_spec.c",
			criterionSource,
			outline("src/parser_spec.c", [
				include("criterion/criterion.h"),
				functionItem("Test", 2, 4),
				functionItem("Theory", 5, 5),
			], "C"),
		)).toEqual([
			expect.objectContaining({ startLine: 2, endLine: 4 }),
			expect.objectContaining({ startLine: 5, endLine: 5 }),
		]);
	});

	test("uses ast-grep outline ranges for Catch2 and doctest", () => {
		const source = [
			"#include <catch2/catch_test_macros.hpp>",
			'TEST_CASE("parses") {',
			"  REQUIRE(true);",
			"}",
			'SECTION("not a top-level test") {}',
		].join("\n");
		expect(classifyCFamilyTestRanges(
			"src/parser_spec.cpp",
			source,
			outline("src/parser_spec.cpp", [
				include("catch2/catch_test_macros.hpp"),
				functionItem("TEST_CASE", 2, 4),
			]),
		)).toEqual([{
			startLine: 2,
			endLine: 4,
			reason: "c-family-test-macro",
			confidence: "semantic",
		}]);

		const doctestSource = [
			"#include <doctest/doctest.h>",
			'DOCTEST_TEST_CASE("parses") {',
			"  DOCTEST_CHECK(true);",
			"}",
		].join("\n");
		expect(classifyCFamilyTestRanges(
			"src/parser_spec.cpp",
			doctestSource,
			outline("src/parser_spec.cpp", [
				include("doctest/doctest.h"),
				functionItem("DOCTEST_TEST_CASE", 2, 4),
			]),
		)).toEqual([
			expect.objectContaining({ startLine: 2, endLine: 4 }),
		]);
	});

	test("classifies Unity test functions but not lifecycle or helper functions", () => {
		const source = [
			"#include <unity.h>",
			"void setUp(void) {}",
			"void test_parser_accepts_input(void) {",
			"  TEST_ASSERT_TRUE(1);",
			"}",
			"void testing_helper(void) {}",
		].join("\n");
		expect(classifyCFamilyTestRanges(
			"src/parser_spec.c",
			source,
			outline("src/parser_spec.c", [
				include("unity.h"),
				functionItem("setUp", 2, 2),
				functionItem("test_parser_accepts_input", 3, 5),
				functionItem("testing_helper", 6, 6),
			], "C"),
		)).toEqual([{
			startLine: 3,
			endLine: 5,
			reason: "c-family-test-function",
			confidence: "semantic",
		}]);
	});

	test("does not classify framework-like names without exact range evidence", () => {
		const source = [
			"#include <gtest/gtest.h>",
			"void TESTING_HELPER() {}",
			"void helper() {",
			"  TEST(Parser, dynamic_registration);",
			"}",
		].join("\n");
		expect(classifyCFamilyTestRanges(
			"src/parser_spec.cpp",
			source,
			outline("src/parser_spec.cpp", [
				include("gtest/gtest.h"),
				functionItem("TESTING_HELPER", 2, 2),
				functionItem("helper", 3, 5),
			]),
		)).toEqual([]);
	});
});
