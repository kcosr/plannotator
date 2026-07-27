import { describe, expect, test } from "bun:test";
import type { StructuralFileOutline, StructuralItem } from "./atlas-structure";
import { classifyConventionalTestRanges } from "./atlas-test-classification-conventions";

function item(
	name: string,
	startLine: number,
	endLine: number,
	symbolType = "function",
	options: {
		signature?: string;
		astKind?: string;
		isImport?: boolean;
	} = {},
): StructuralItem {
	return {
		role: "item",
		symbolType,
		name,
		range: {
			start: { line: startLine - 1, column: 0 },
			end: { line: endLine - 1, column: 1 },
		},
		signature: options.signature ?? name,
		astKind: options.astKind ?? "function",
		isImport: options.isImport ?? false,
		isExported: false,
	};
}

function outline(language: string, items: StructuralItem[]): StructuralFileOutline {
	return { path: "source", language, items };
}

describe("conventional Atlas test classification", () => {
	test("classifies Python test files without treating production names as tests", () => {
		expect(
			classifyConventionalTestRanges(
				"python",
				"tests/test_service.py",
				"def helper():\n    pass\n",
				undefined,
			),
		).toEqual([expect.objectContaining({
			startLine: 1,
			endLine: 2,
			reason: "python-test-file",
			confidence: "convention",
		})]);

		expect(
			classifyConventionalTestRanges(
				"python",
				"src/service.py",
				"def live():\n    pass\n\ndef test_inline():\n    pass\n",
				outline("python", [item("live", 1, 2), item("test_inline", 4, 5)]),
			),
		).toEqual([]);
	});

	test("does not classify Python and Ruby production symbols by name alone", () => {
		expect(
			classifyConventionalTestRanges(
				"python",
				"src/service.py",
				"class TestService:\n    pass\n\ndef TestFactory():\n    pass\n",
				outline("python", [
					item("TestService", 1, 2, "class"),
					item("TestFactory", 4, 5),
				]),
			),
		).toEqual([]);

		expect(
			classifyConventionalTestRanges(
				"ruby",
				"lib/service.rb",
				"class test_helper\nend\n\ndef test_inline\nend\n",
				outline("ruby", [
					item("test_helper", 1, 2, "class"),
					item("test_inline", 4, 5, "method"),
				]),
			),
		).toEqual([]);
	});

	test("classifies Python tests grounded in unittest and pytest context", () => {
		const unittestSource = [
			"import unittest",
			"class ServiceChecks(ServiceMixin, unittest.TestCase):",
			"    def test_works(self):",
			"        pass",
			"    def helper(self):",
			"        pass",
		].join("\n");
		expect(classifyConventionalTestRanges(
			"python",
			"src/service_checks.py",
			unittestSource,
			outline("python", [
				item("unittest", 1, 1, "module", {
					signature: "import unittest",
					astKind: "import_statement",
					isImport: true,
				}),
				item("ServiceChecks", 2, 6, "class", {
					signature: "class ServiceChecks(ServiceMixin, unittest.TestCase):",
					astKind: "class_definition",
				}),
			]),
		)).toEqual([expect.objectContaining({
			startLine: 2,
			endLine: 6,
			reason: "python-test-symbol",
			confidence: "semantic",
		})]);

		const pytestSource = [
			"import pytest",
			"def live():",
			"    pass",
			"def test_inline():",
			"    assert True",
			"class Service:",
			"    def test_connection(self):",
			"        return True",
		].join("\n");
		expect(classifyConventionalTestRanges(
			"python",
			"src/service.py",
			pytestSource,
			outline("python", [
				item("pytest", 1, 1, "module", {
					signature: "import pytest",
					astKind: "import_statement",
					isImport: true,
				}),
				item("live", 2, 3),
				item("test_inline", 4, 5),
				item("Service", 6, 8, "class", {
					signature: "class Service:",
					astKind: "class_definition",
				}),
			]),
		)).toEqual([expect.objectContaining({
			startLine: 4,
			endLine: 5,
			reason: "python-test-symbol",
		})]);
	});

	test("classifies Ruby test-case subclasses but not unrelated methods", () => {
		const source = [
			"require 'minitest/autorun'",
			"class ServiceChecks < Minitest::Test",
			"  def test_works",
			"  end",
			"  def helper",
			"  end",
			"end",
			"class Service",
			"  def test_connection",
			"  end",
			"end",
		].join("\n");
		expect(classifyConventionalTestRanges(
			"ruby",
			"lib/service_checks.rb",
			source,
			outline("ruby", [
				item("ServiceChecks", 2, 7, "class", {
					signature: "class ServiceChecks < Minitest::Test",
					astKind: "class",
				}),
				item("Service", 8, 11, "class", {
					signature: "class Service",
					astKind: "class",
				}),
			]),
		)).toEqual([expect.objectContaining({
			startLine: 2,
			endLine: 7,
			reason: "ruby-test-symbol",
			confidence: "semantic",
		})]);
	});

	test("classifies Go test files", () => {
		expect(
			classifyConventionalTestRanges(
				"go",
				"internal/service_test.go",
				"package internal\n\nfunc TestService(t *testing.T) {}\n",
				undefined,
			),
		).toEqual([expect.objectContaining({
			startLine: 1,
			endLine: 3,
			reason: "go-test-file",
		})]);
		expect(
			classifyConventionalTestRanges(
				"go",
				"internal/service.go",
				"package internal\n",
				undefined,
			),
		).toEqual([]);
	});

	test("classifies Java test paths and annotated methods", () => {
		expect(
			classifyConventionalTestRanges(
				"java",
				"src/test/java/example/ServiceChecks.java",
				"class ServiceChecks {}\n",
				undefined,
			),
		).toEqual([expect.objectContaining({ reason: "java-test-file" })]);

		for (const path of [
			"src/main/java/example/Latest.java",
			"src/main/java/example/Contest.java",
		]) {
			expect(
				classifyConventionalTestRanges(
					"java",
					path,
					"class Production {}\n",
					undefined,
				),
			).toEqual([]);
		}

		expect(
			classifyConventionalTestRanges(
				"java",
				"src/main/java/example/Service.java",
				"class Service {\n  @Test\n  void works() {}\n}\n",
				outline("java", [item("works", 3, 3)]),
			),
		).toEqual([expect.objectContaining({
			startLine: 2,
			endLine: 3,
			reason: "java-test-annotation",
			confidence: "semantic",
		})]);
	});

	test("classifies Ruby spec files without treating production names as tests", () => {
		expect(
			classifyConventionalTestRanges(
				"ruby",
				"spec/service_spec.rb",
				"describe Service do\nend\n",
				undefined,
			),
		).toEqual([expect.objectContaining({ reason: "ruby-test-file" })]);

		expect(
			classifyConventionalTestRanges(
				"ruby",
				"lib/service.rb",
				"def live\nend\n\ndef test_inline\nend\n",
				outline("ruby", [item("live", 1, 2), item("test_inline", 4, 5)]),
			),
		).toEqual([]);
	});
});
