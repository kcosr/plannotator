import { describe, expect, test } from "bun:test";
import type { StructuralFileOutline, StructuralItem } from "./atlas-structure";
import {
	classifyRustRepositoryTestRanges,
	classifyRustTestRanges,
} from "./atlas-test-classification";

function item(
	name: string,
	startLine: number,
	endLine: number,
	members: StructuralItem["members"] = [],
): StructuralItem {
	return {
		role: "item",
		symbolType: name === "unit" ? "module" : "function",
		name,
		range: {
			start: { line: startLine - 1, column: 0 },
			end: { line: endLine - 1, column: 1 },
		},
		signature: name === "unit" ? "mod unit" : `fn ${name}()`,
		astKind: name === "unit" ? "mod_item" : "function_item",
		isImport: false,
		isExported: false,
		members,
	};
}

function outline(items: StructuralItem[]): StructuralFileOutline {
	return { path: "src/lib.rs", language: "Rust", items };
}

function externalModule(name: string, line: number): StructuralItem {
	return {
		...item(name, line, line),
		symbolType: "module",
		signature: `mod ${name}`,
		astKind: "mod_item",
		range: {
			start: { line: line - 1, column: 0 },
			end: { line: line - 1, column: `mod ${name};`.length },
		},
	};
}

describe("classifyRustTestRanges", () => {
	test("classifies cfg-gated modules and test-like function attributes", () => {
		const source = [
			"pub fn live() {}",
			"",
			"#[cfg(all(test, unix))]",
			"mod unit {",
			"    fn helper() {}",
			"    #[tokio::test]",
			"    async fn works() {}",
			"}",
			"",
			'#[cfg(any(test, feature = "tools"))]',
			"fn optionally_built() {}",
			"#[cfg(any())]",
			"fn never_built() {}",
			"",
			"#[test_case]",
			"fn standalone() {}",
		].join("\n");
		const unit = item("unit", 4, 8, [{
			role: "member",
			symbolType: "function",
			name: "helper",
			range: {
				start: { line: 4, column: 4 },
				end: { line: 4, column: 18 },
			},
			signature: "fn helper()",
			astKind: "function_item",
			isPublic: false,
		}, {
			role: "member",
			symbolType: "function",
			name: "works",
			range: {
				start: { line: 6, column: 4 },
				end: { line: 6, column: 23 },
			},
			signature: "async fn works()",
			astKind: "function_item",
			isPublic: false,
		}]);

		expect(classifyRustTestRanges("src/lib.rs", source, outline([
			item("live", 1, 1),
			unit,
			item("optionally_built", 11, 11),
			item("never_built", 13, 13),
			item("standalone", 16, 16),
		]))).toEqual([
			{
				startLine: 3,
				endLine: 8,
				reason: "rust-cfg-test",
				confidence: "semantic",
			},
			{
				startLine: 15,
				endLine: 16,
				reason: "rust-test-attribute",
				confidence: "semantic",
			},
		]);
	});

	test("supports multiline attributes and double-negated test predicates", () => {
		const source = [
			"#[cfg(",
			"    not(not(test))",
			")]",
			"fn nested_cfg() {}",
			"",
			"#[async_std::test]",
			"async fn async_test() {}",
		].join("\n");

		expect(classifyRustTestRanges("src/lib.rs", source, outline([
			item("nested_cfg", 4, 4),
			item("async_test", 7, 7),
		]))).toEqual([
			expect.objectContaining({ startLine: 1, endLine: 4, reason: "rust-cfg-test" }),
			expect.objectContaining({ startLine: 6, endLine: 7, reason: "rust-test-attribute" }),
		]);
	});

	test("classifies Cargo integration files but not benchmarks by path alone", () => {
		const source = "fn helper() {}\n";
		expect(classifyRustTestRanges("crates/api/tests/http.rs", source, undefined)).toEqual([{
			startLine: 1,
			endLine: 1,
			reason: "rust-integration-file",
			confidence: "convention",
		}]);
		expect(classifyRustTestRanges("crates/api/benches/http.rs", source, undefined)).toEqual([]);
		expect(classifyRustTestRanges("crates/api/src/tests/http.rs", source, undefined)).toEqual([]);
	});

	test("preserves provenance for adjacent test items", () => {
		const source = [
			"#[test]",
			"fn first() {}",
			"#[cfg(test)]",
			"fn second() {}",
		].join("\n");

		expect(classifyRustTestRanges("src/lib.rs", source, outline([
			item("first", 2, 2),
			item("second", 4, 4),
		]))).toEqual([
			expect.objectContaining({
				startLine: 1,
				endLine: 2,
				reason: "rust-test-attribute",
			}),
			expect.objectContaining({
				startLine: 3,
				endLine: 4,
				reason: "rust-cfg-test",
			}),
		]);
	});

	test("propagates test status through resolved out-of-line modules", () => {
		const ranges = classifyRustRepositoryTestRanges([
			{
				path: "src/lib.rs",
				content: [
					"#[cfg(test)]",
					"mod tests;",
					"#[cfg(test)]",
					"mod suite;",
				].join("\n"),
				outline: outline([
					externalModule("tests", 2),
					externalModule("suite", 4),
				]),
			},
			{
				path: "src/tests.rs",
				content: "fn helper() {}\nmod support;",
				outline: outline([
					item("helper", 1, 1),
					externalModule("support", 2),
				]),
			},
			{
				path: "src/tests/support.rs",
				content: "fn nested_helper() {}",
				outline: outline([item("nested_helper", 1, 1)]),
			},
			{
				path: "src/suite/mod.rs",
				content: "fn alternate_layout() {}",
				outline: outline([item("alternate_layout", 1, 1)]),
			},
			{
				path: "src/orphan_tests.rs",
				content: "fn not_referenced() {}",
				outline: outline([item("not_referenced", 1, 1)]),
			},
		]);

		expect(ranges.get("src/tests.rs")).toEqual([
			expect.objectContaining({ startLine: 1, endLine: 2, reason: "rust-cfg-test" }),
		]);
		expect(ranges.get("src/tests/support.rs")).toEqual([
			expect.objectContaining({ startLine: 1, endLine: 1, reason: "rust-cfg-test" }),
		]);
		expect(ranges.get("src/suite/mod.rs")).toEqual([
			expect.objectContaining({ startLine: 1, endLine: 1, reason: "rust-cfg-test" }),
		]);
		expect(ranges.get("src/orphan_tests.rs")).toEqual([]);
	});
});
