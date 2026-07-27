import { posix } from "node:path";
import type { AtlasTestRange } from "./atlas-test-classification";
import type {
	StructuralFileOutline,
	StructuralItem,
	StructuralMember,
} from "./atlas-structure";

type ConventionalTestLanguage = "python" | "go" | "java" | "ruby";
type StructuralEntry = StructuralItem | StructuralMember;

function lineCount(content: string): number {
	if (content.length === 0) return 0;
	const newlines = content.match(/\r\n|\r|\n/g)?.length ?? 0;
	return newlines + (/(?:\r\n|\r|\n)$/.test(content) ? 0 : 1);
}

function pathSegments(filePath: string): string[] {
	return filePath.replaceAll("\\", "/").split("/").filter(Boolean);
}

function hasDirectory(filePath: string, names: Set<string>): boolean {
	const segments = pathSegments(filePath);
	return segments.slice(0, -1).some((segment) => names.has(segment.toLowerCase()));
}

function isConventionalTestFile(
	language: ConventionalTestLanguage,
	filePath: string,
): boolean {
	const basename = posix.basename(filePath);
	const name = basename.toLowerCase();
	switch (language) {
		case "python":
			return (
				hasDirectory(filePath, new Set(["test", "tests"])) ||
				/^test_.+\.py$/.test(name) ||
				/^.+_test\.py$/.test(name)
			);
		case "go":
			return /_test\.go$/.test(name);
		case "java":
			return (
				hasDirectory(filePath, new Set(["test", "tests"])) ||
				/(?:Test|Tests|TestCase)\.java$/.test(basename)
			);
		case "ruby":
			return (
				hasDirectory(filePath, new Set(["test", "tests", "spec", "specs"])) ||
				/(?:_test|_spec)\.rb$/.test(name)
			);
	}
}

function flattenEntries(outline: StructuralFileOutline | undefined): StructuralEntry[] {
	const entries: StructuralEntry[] = [];
	for (const item of outline?.items ?? []) {
		entries.push(item, ...(item.members ?? []));
	}
	return entries;
}

function entryRange(
	entry: StructuralEntry,
	reason: AtlasTestRange["reason"],
	startLine = entry.range.start.line + 1,
): AtlasTestRange {
	return {
		startLine,
		endLine: entry.range.end.line + 1,
		reason,
		confidence: "semantic",
	};
}

function itemSource(content: string, item: StructuralItem): string {
	const lines = content.split(/\r\n|\r|\n/);
	const { start, end } = item.range;
	if (start.line === end.line) {
		return (lines[start.line] ?? "").slice(start.column, end.column);
	}
	return [
		(lines[start.line] ?? "").slice(start.column),
		...lines.slice(start.line + 1, end.line),
		(lines[end.line] ?? "").slice(0, end.column),
	].join("\n");
}

function hasPytestImport(
	content: string,
	outline: StructuralFileOutline | undefined,
): boolean {
	return (outline?.items ?? []).some((item) => {
		if (!item.isImport) return false;
		if (item.name === "pytest") return true;
		const source = `${item.signature}\n${itemSource(content, item)}`;
		return (
			/^\s*import\s+pytest(?:\s+as\s+\w+)?\s*$/m.test(source) ||
			/^\s*from\s+pytest(?:\.\w+)*\s+import\b/m.test(source)
		);
	});
}

function pythonTestCaseClass(item: StructuralItem): boolean {
	if (item.symbolType !== "class") return false;
	return /(?:\(|,)\s*(?:[A-Za-z_]\w*\.)*(?:[A-Za-z_]\w*)?TestCase\s*(?:[,)\[])/.test(
		item.signature,
	);
}

function rubyTestCaseClass(item: StructuralItem): boolean {
	if (item.symbolType !== "class") return false;
	return /<\s*(?:(?:[A-Za-z_]\w*::)*(?:[A-Za-z_]\w*)?TestCase|Minitest::Test|ActionDispatch::IntegrationTest)\b/.test(
		item.signature,
	);
}

function leadingJavaTestAnnotationLine(
	lines: string[],
	entry: StructuralEntry,
): number | null {
	let cursor = entry.range.start.line - 1;
	let annotationLine: number | null = null;
	while (cursor >= 0) {
		const source = lines[cursor]!.trim();
		if (source === "" || source.startsWith("//")) {
			cursor -= 1;
			continue;
		}
		if (!source.startsWith("@")) break;
		if (
			/^@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(source) ||
			/^@org\.junit\..*\.Test\b/.test(source)
		) {
			annotationLine = cursor;
		}
		cursor -= 1;
	}
	return annotationLine;
}

function normalizeRanges(ranges: AtlasTestRange[]): AtlasTestRange[] {
	const normalized: AtlasTestRange[] = [];
	for (const range of [...ranges].sort(
		(first, second) =>
			first.startLine - second.startLine ||
			second.endLine - first.endLine,
	)) {
		const previous = normalized.at(-1);
		if (!previous || range.startLine > previous.endLine) {
			normalized.push({ ...range });
		} else if (range.endLine > previous.endLine) {
			previous.endLine = range.endLine;
		}
	}
	return normalized;
}

export function classifyConventionalTestRanges(
	language: ConventionalTestLanguage,
	filePath: string,
	content: string,
	outline: StructuralFileOutline | undefined,
): AtlasTestRange[] {
	const totalLines = lineCount(content);
	if (totalLines === 0) return [];
	if (isConventionalTestFile(language, filePath)) {
		return [{
			startLine: 1,
			endLine: totalLines,
			reason: `${language}-test-file`,
			confidence: "convention",
		}];
	}

	const lines = content.split(/\r\n|\r|\n/);
	const ranges: AtlasTestRange[] = [];
	if (language === "python") {
		const pytestImported = hasPytestImport(content, outline);
		for (const item of outline?.items ?? []) {
			if (
				pythonTestCaseClass(item) ||
				(
					pytestImported &&
					item.symbolType === "class" &&
					/^Test[A-Z_]/.test(item.name)
				) ||
				(
					item.symbolType === "function" &&
					/^test_/.test(item.name) &&
					pytestImported
				)
			) {
				ranges.push(entryRange(item, "python-test-symbol"));
			}
		}
	}
	if (language === "ruby") {
		for (const item of outline?.items ?? []) {
			if (rubyTestCaseClass(item)) {
				ranges.push(entryRange(item, "ruby-test-symbol"));
			}
		}
	}
	for (const entry of flattenEntries(outline)) {
		if (language === "java") {
			const annotationLine = leadingJavaTestAnnotationLine(lines, entry);
			if (annotationLine !== null) {
				ranges.push(entryRange(entry, "java-test-annotation", annotationLine + 1));
			}
		}
	}
	return normalizeRanges(ranges);
}
