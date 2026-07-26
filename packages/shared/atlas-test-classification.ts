import type {
	StructuralFileOutline,
	StructuralItem,
	StructuralMember,
} from "./atlas-structure";
import { posix } from "node:path";

export type AtlasTestRangeReason =
	| "rust-test-attribute"
	| "rust-cfg-test"
	| "rust-integration-file"
	| "python-test-file"
	| "python-test-symbol"
	| "go-test-file"
	| "java-test-file"
	| "java-test-annotation"
	| "ruby-test-file"
	| "ruby-test-symbol"
	| "js-test-file"
	| "js-test-call"
	| "c-family-test-file"
	| "c-family-test-macro"
	| "c-family-test-function";

export interface AtlasTestRange {
	startLine: number;
	endLine: number;
	reason: AtlasTestRangeReason;
	confidence: "semantic" | "convention";
}

type StructuralEntry = StructuralItem | StructuralMember;

interface RustAttribute {
	startLine: number;
	body: string;
}

export interface RustTestSourceFile {
	path: string;
	content: string;
	outline: StructuralFileOutline | undefined;
}

interface PredicatePossibility {
	canBeFalse: boolean;
	canBeTrue: boolean;
}

const UNKNOWN_PREDICATE: PredicatePossibility = {
	canBeFalse: true,
	canBeTrue: true,
};

function lineCount(content: string): number {
	if (content.length === 0) return 0;
	const newlines = content.match(/\r\n|\r|\n/g)?.length ?? 0;
	return newlines + (/(?:\r\n|\r|\n)$/.test(content) ? 0 : 1);
}

function isCargoIntegrationTestPath(filePath: string): boolean {
	const segments = filePath.replace(/\\/g, "/").split("/");
	const testsIndex = segments.lastIndexOf("tests");
	return (
		testsIndex >= 0 &&
		!segments.slice(0, testsIndex).includes("src") &&
		!segments.includes("benches")
	);
}

function isTriviaLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === "" || trimmed.startsWith("//");
}

function findAttributeStart(lines: string[], endLine: number): number | null {
	let squareDepth = 0;
	let sawClosingBracket = false;
	for (let lineIndex = endLine; lineIndex >= 0; lineIndex -= 1) {
		const line = lines[lineIndex]!;
		for (let characterIndex = line.length - 1; characterIndex >= 0; characterIndex -= 1) {
			const character = line[characterIndex];
			if (character === "]") {
				squareDepth += 1;
				sawClosingBracket = true;
			} else if (character === "[") {
				squareDepth -= 1;
			}
		}
		if (
			sawClosingBracket &&
			squareDepth === 0 &&
			/^\s*#\s*\[/.test(line)
		) {
			return lineIndex;
		}
		if (squareDepth < 0) return null;
	}
	return null;
}

function leadingRustAttributes(lines: string[], itemStartLine: number): RustAttribute[] {
	const attributes: RustAttribute[] = [];
	let cursor = itemStartLine - 1;
	while (cursor >= 0) {
		while (cursor >= 0 && isTriviaLine(lines[cursor]!)) cursor -= 1;
		if (cursor < 0 || !lines[cursor]!.trimEnd().endsWith("]")) break;

		const startLine = findAttributeStart(lines, cursor);
		if (startLine === null) break;
		const source = lines.slice(startLine, cursor + 1).join("\n");
		const body = source
			.replace(/^\s*#\s*\[/, "")
			.replace(/\]\s*$/, "")
			.trim();
		attributes.unshift({ startLine, body });
		cursor = startLine - 1;
	}
	return attributes;
}

function tokenizePredicate(source: string): string[] {
	return source.match(
		/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z0-9_]*|[(),=]/g,
	) ?? [];
}

class PredicateParser {
	#index = 0;

	constructor(private readonly tokens: string[]) {}

	parse(): PredicatePossibility | null {
		const result = this.#parsePredicate();
		return result && this.#index === this.tokens.length ? result : null;
	}

	#parsePredicate(): PredicatePossibility | null {
		const name = this.tokens[this.#index++];
		if (!name || !/^[A-Za-z_]/.test(name)) return null;

		if (this.tokens[this.#index] === "=") {
			this.#index += 1;
			if (!this.tokens[this.#index]) return null;
			this.#index += 1;
			return UNKNOWN_PREDICATE;
		}
		if (this.tokens[this.#index] !== "(") {
			return name === "test"
				? { canBeFalse: true, canBeTrue: false }
				: UNKNOWN_PREDICATE;
		}

		this.#index += 1;
		const operands: PredicatePossibility[] = [];
		while (this.tokens[this.#index] !== ")") {
			const operand = this.#parsePredicate();
			if (!operand) return null;
			operands.push(operand);
			if (this.tokens[this.#index] === ",") {
				this.#index += 1;
				if (this.tokens[this.#index] === ")") break;
			} else if (this.tokens[this.#index] !== ")") {
				return null;
			}
		}
		if (this.tokens[this.#index] !== ")") return null;
		this.#index += 1;

		switch (name) {
			case "all":
				return {
					canBeFalse: operands.some((operand) => operand.canBeFalse),
					canBeTrue: operands.every((operand) => operand.canBeTrue),
				};
			case "any":
				return {
					canBeFalse: operands.every((operand) => operand.canBeFalse),
					canBeTrue: operands.some((operand) => operand.canBeTrue),
				};
			case "not":
				return operands.length === 1
					? {
						canBeFalse: operands[0]!.canBeTrue,
						canBeTrue: operands[0]!.canBeFalse,
					}
					: null;
			default:
				return UNKNOWN_PREDICATE;
		}
	}
}

function cfgRequiresTest(attributeBody: string): boolean {
	const match = attributeBody.match(/^cfg\s*\(([\s\S]*)\)$/);
	if (!match) return false;
	const tokens = tokenizePredicate(match[1]!);
	if (!tokens.includes("test")) return false;
	const possibility = new PredicateParser(tokens).parse();
	return possibility !== null && !possibility.canBeTrue;
}

function isTestAttribute(attributeBody: string): boolean {
	const match = attributeBody.match(
		/^([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)(?:\s*\([\s\S]*\))?$/,
	);
	if (!match) return false;
	const finalSegment = match[1]!.split("::").at(-1);
	return finalSegment === "test" || finalSegment === "rstest" || finalSegment === "test_case";
}

function flattenEntries(outline: StructuralFileOutline | undefined): StructuralEntry[] {
	const entries: StructuralEntry[] = [];
	for (const item of outline?.items ?? []) {
		entries.push(item, ...(item.members ?? []));
	}
	return entries.sort(
		(first, second) =>
			first.range.start.line - second.range.start.line ||
			second.range.end.line - first.range.end.line,
	);
}

function normalizeRanges(ranges: AtlasTestRange[]): AtlasTestRange[] {
	const result: AtlasTestRange[] = [];
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

function entrySource(content: string, entry: StructuralEntry): string {
	const lines = content.split(/\r\n|\r|\n/);
	const start = entry.range.start;
	const end = entry.range.end;
	if (start.line === end.line) {
		return (lines[start.line] ?? "").slice(start.column, end.column);
	}
	return [
		(lines[start.line] ?? "").slice(start.column),
		...lines.slice(start.line + 1, end.line),
		(lines[end.line] ?? "").slice(0, end.column),
	].join("\n");
}

function isOutOfLineModule(content: string, item: StructuralItem): boolean {
	return item.astKind === "mod_item" && /;\s*$/.test(entrySource(content, item));
}

function isFullyTestClassified(content: string, ranges: AtlasTestRange[]): boolean {
	return ranges.reduce((total, range) => total + range.endLine - range.startLine + 1, 0) >=
		lineCount(content);
}

function isLikelyCrateRoot(filePath: string): boolean {
	const basename = posix.basename(filePath);
	if (["lib.rs", "main.rs", "mod.rs", "build.rs"].includes(basename)) return true;
	if (isCargoIntegrationTestPath(filePath)) return true;
	const parent = posix.basename(posix.dirname(filePath));
	return ["bin", "examples", "benches"].includes(parent);
}

function moduleDirectory(filePath: string): string {
	const directory = posix.dirname(filePath);
	if (isLikelyCrateRoot(filePath)) return directory;
	return posix.join(directory, posix.basename(filePath, ".rs"));
}

function resolveExternalModulePaths(
	filePath: string,
	moduleName: string,
	availablePaths: Set<string>,
): string[] {
	const base = moduleDirectory(filePath);
	return [
		posix.join(base, `${moduleName}.rs`),
		posix.join(base, moduleName, "mod.rs"),
	].filter((candidate) => availablePaths.has(candidate));
}

/**
 * Classify Rust test code without changing source coordinates.
 *
 * ast-grep supplies item/module boundaries; source attributes determine which
 * of those ranges are test-only. Ranges are 1-based and inclusive.
 */
export function classifyRustTestRanges(
	filePath: string,
	content: string,
	outline: StructuralFileOutline | undefined,
): AtlasTestRange[] {
	const totalLines = lineCount(content);
	if (totalLines === 0) return [];
	if (isCargoIntegrationTestPath(filePath)) {
		return [{
			startLine: 1,
			endLine: totalLines,
			reason: "rust-integration-file",
			confidence: "convention",
		}];
	}

	const lines = content.split(/\r\n|\r|\n/);
	const ranges: AtlasTestRange[] = [];
	for (const entry of flattenEntries(outline)) {
		const attributes = leadingRustAttributes(lines, entry.range.start.line);
		const cfgAttribute = attributes.find((attribute) => cfgRequiresTest(attribute.body));
		const testAttribute = attributes.find((attribute) => isTestAttribute(attribute.body));
		const attribute = cfgAttribute ?? testAttribute;
		if (!attribute) continue;
		ranges.push({
			startLine: attribute.startLine + 1,
			endLine: Math.min(totalLines, entry.range.end.line + 1),
			reason: cfgAttribute ? "rust-cfg-test" : "rust-test-attribute",
			confidence: "semantic",
		});
	}
	return normalizeRanges(ranges);
}

/**
 * Classify all Rust files together so cfg-gated out-of-line modules carry
 * their test-only status into the files that implement them.
 */
export function classifyRustRepositoryTestRanges(
	files: RustTestSourceFile[],
): Map<string, AtlasTestRange[]> {
	const filesByPath = new Map(files.map((file) => [file.path, file]));
	const availablePaths = new Set(filesByPath.keys());
	const rangesByPath = new Map(
		files.map((file) => [
			file.path,
			classifyRustTestRanges(file.path, file.content, file.outline),
		]),
	);
	const queue = [...files];
	const processedAsFull = new Set<string>();

	while (queue.length > 0) {
		const file = queue.shift()!;
		const ranges = rangesByPath.get(file.path)!;
		const fullyTest = isFullyTestClassified(file.content, ranges);
		if (fullyTest) {
			if (processedAsFull.has(file.path)) continue;
			processedAsFull.add(file.path);
		}

		for (const item of file.outline?.items ?? []) {
			if (!isOutOfLineModule(file.content, item)) continue;
			const declarationLine = item.range.start.line + 1;
			if (
				!fullyTest &&
				!ranges.some(
					(range) => declarationLine >= range.startLine && declarationLine <= range.endLine,
				)
			) continue;

			for (const targetPath of resolveExternalModulePaths(
				file.path,
				item.name,
				availablePaths,
			)) {
				const target = filesByPath.get(targetPath)!;
				if (isFullyTestClassified(target.content, rangesByPath.get(targetPath)!)) continue;
				const targetLines = lineCount(target.content);
				rangesByPath.set(targetPath, targetLines === 0 ? [] : [{
					startLine: 1,
					endLine: targetLines,
					reason: "rust-cfg-test",
					confidence: "semantic",
				}]);
				queue.push(target);
			}
		}
	}

	return rangesByPath;
}
