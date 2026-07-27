import { posix } from "node:path";
import type {
	StructuralFileOutline,
	StructuralItem,
} from "./atlas-structure";

export type JavaScriptTestRangeReason = "js-test-file" | "js-test-call";

export interface JavaScriptTestRange {
	startLine: number;
	endLine: number;
	reason: JavaScriptTestRangeReason;
	confidence: "semantic" | "convention";
}

export interface JavaScriptTestSourceFile {
	path: string;
	content: string;
	outline: StructuralFileOutline | undefined;
}

type ApiKind = "test" | "suite" | "hook";

interface Framework {
	defaultApi?: ApiKind;
}

interface Binding {
	direct?: ApiKind;
	namespace: boolean;
}

const FRAMEWORKS = new Map<string, Framework>([
	["vitest", {}],
	["@jest/globals", {}],
	["@playwright/test", {}],
	["bun:test", {}],
	["node:test", { defaultApi: "test" }],
	["node:test/promises", { defaultApi: "test" }],
	["mocha", {}],
	["ava", { defaultApi: "test" }],
]);

const API_KINDS = new Map<string, ApiKind>([
	["test", "test"],
	["it", "test"],
	["specify", "test"],
	["describe", "suite"],
	["suite", "suite"],
	["context", "suite"],
	["before", "hook"],
	["after", "hook"],
	["beforeAll", "hook"],
	["afterAll", "hook"],
	["beforeEach", "hook"],
	["afterEach", "hook"],
	["setup", "hook"],
	["teardown", "hook"],
]);

const MODIFIERS = new Set([
	"only",
	"skip",
	"todo",
	"concurrent",
	"serial",
	"fails",
	"failing",
	"each",
	"runIf",
	"skipIf",
	"fixme",
	"parallel",
]);

function lineCount(content: string): number {
	if (content.length === 0) return 0;
	const newlines = content.match(/\r\n|\r|\n/g)?.length ?? 0;
	return newlines + (/(?:\r\n|\r|\n)$/.test(content) ? 0 : 1);
}

function isConventionalTestPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const segments = normalized.split("/");
	if (
		segments
			.slice(0, -1)
			.some((segment) => ["__tests__", "test", "tests", "spec"].includes(segment))
	) return true;

	const basename = posix.basename(normalized);
	return /(?:^|[._-])(?:test|spec|cy)\.[cm]?[jt]sx?$/i.test(basename);
}

function sourceForItem(content: string, item: StructuralItem): string {
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

function setBinding(
	bindings: Map<string, Binding>,
	localName: string,
	binding: Binding,
): void {
	if (!/^[A-Za-z_$][\w$]*$/.test(localName)) return;
	const previous = bindings.get(localName);
	bindings.set(localName, {
		direct: binding.direct ?? previous?.direct,
		namespace: binding.namespace || previous?.namespace === true,
	});
}

function bindNamedImports(
	clause: string,
	bindings: Map<string, Binding>,
): void {
	const body = clause.match(/\{([\s\S]*?)\}/)?.[1];
	if (!body) return;
	for (const specifier of body.split(",")) {
		const match = specifier
			.trim()
			.replace(/^type\s+/, "")
			.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
		if (!match) continue;
		const kind = API_KINDS.get(match[1]!);
		if (!kind) continue;
		setBinding(bindings, match[2] ?? match[1]!, {
			direct: kind,
			namespace: false,
		});
	}
}

function bindEsmImport(
	source: string,
	bindings: Map<string, Binding>,
): void {
	const match = source.match(
		/^\s*import\s+(?!type\b)([\s\S]*?)\s+from\s*["']([^"']+)["']/,
	);
	if (!match) return;
	const clause = match[1]!.trim();
	const framework = FRAMEWORKS.get(match[2]!);
	if (!framework) return;

	const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
	if (namespace) {
		setBinding(bindings, namespace[1]!, { namespace: true });
	}
	bindNamedImports(clause, bindings);

	const defaultName = clause
		.replace(/\{[\s\S]*?\}/, "")
		.replace(/,\s*\*\s+as\s+[A-Za-z_$][\w$]*/, "")
		.replace(/^\*\s+as\s+[A-Za-z_$][\w$]*$/, "")
		.replace(/,\s*$/, "")
		.trim();
	if (/^[A-Za-z_$][\w$]*$/.test(defaultName)) {
		setBinding(bindings, defaultName, {
			direct: framework.defaultApi,
			namespace: framework.defaultApi === undefined,
		});
	}
}

function bindRequire(
	source: string,
	bindings: Map<string, Binding>,
): void {
	const match = source.match(
		/^\s*(?:const\s+|let\s+|var\s+)?([\s\S]*?)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)(?:\.([A-Za-z_$][\w$]*))?/,
	);
	if (!match) return;
	const target = match[1]!.trim();
	const framework = FRAMEWORKS.get(match[2]!);
	if (!framework) return;

	if (target.startsWith("{") && target.endsWith("}")) {
		for (const specifier of target.slice(1, -1).split(",")) {
			const named = specifier
				.trim()
				.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
			if (!named) continue;
			const kind = named[1] === "default"
				? framework.defaultApi
				: API_KINDS.get(named[1]!);
			if (!kind) continue;
			setBinding(bindings, named[2] ?? named[1]!, {
				direct: kind,
				namespace: false,
			});
		}
		return;
	}

	const member = match[3];
	if (member) {
		const kind = API_KINDS.get(member);
		if (kind) {
			setBinding(bindings, target, { direct: kind, namespace: false });
		}
		return;
	}
	setBinding(bindings, target, {
		direct: framework.defaultApi,
		namespace: framework.defaultApi === undefined,
	});
}

function collectBindings(
	content: string,
	outline: StructuralFileOutline | undefined,
): Map<string, Binding> {
	const bindings = new Map<string, Binding>();
	for (const item of outline?.items ?? []) {
		const source = sourceForItem(content, item);
		if (item.isImport) bindEsmImport(source, bindings);
		if (item.astKind === "variable_declarator") bindRequire(source, bindings);
	}
	return bindings;
}

function calleeParts(callee: string): string[] {
	const withoutArguments = callee
		.replace(/\?\./g, ".")
		.replace(/\s+/g, "")
		.split("(", 1)[0];
	if (!withoutArguments) return [];
	const parts = withoutArguments.split(".");
	return parts.every((part) => /^[A-Za-z_$][\w$]*$/.test(part))
		? parts
		: [];
}

function semanticCallee(
	callee: string,
	bindings: Map<string, Binding>,
): ApiKind | null {
	const parts = calleeParts(callee);
	if (parts.length === 0) return null;

	if (parts[0] === "Deno" && parts[1] === "test") {
		return parts.slice(2).every((part) => MODIFIERS.has(part)) ? "test" : null;
	}

	const binding = bindings.get(parts[0]!);
	if (!binding) return null;
	let kind = binding.direct;
	let remainder = parts.slice(1);
	if (binding.namespace) {
		kind = API_KINDS.get(remainder[0] ?? "");
		remainder = remainder.slice(1);
	}
	if (remainder.length > 0) {
		const memberKind = API_KINDS.get(remainder[0]!);
		if (memberKind) {
			kind = memberKind;
			remainder = remainder.slice(1);
		}
	}
	return kind && remainder.every((part) => MODIFIERS.has(part)) ? kind : null;
}

function normalizeRanges(ranges: JavaScriptTestRange[]): JavaScriptTestRange[] {
	const result: JavaScriptTestRange[] = [];
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
		if (range.endLine > previous.endLine) previous.endLine = range.endLine;
	}
	return result;
}

function inlineTestRanges(
	content: string,
	bindings: Map<string, Binding>,
): JavaScriptTestRange[] {
	const ranges: JavaScriptTestRange[] = [];
	for (const match of content.matchAll(
		/^\s*(?:await\s+)?([A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*)\s*(?:\([^{}\n;]*\)\s*)?\(/gm,
	)) {
		if (!semanticCallee(match[1]!, bindings)) continue;
		const startOffset = match.index;
		const openingOffset = startOffset + match[0].lastIndexOf("(");
		ranges.push({
			startLine: lineAtOffset(content, startOffset),
			endLine: lineAtOffset(content, matchingCallEnd(content, openingOffset)),
			reason: "js-test-call",
			confidence: "semantic",
		});
	}
	return ranges;
}

function lineAtOffset(content: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < Math.min(offset, content.length); index += 1) {
		if (content[index] === "\n") line += 1;
	}
	return line;
}

function matchingCallEnd(content: string, openingOffset: number): number {
	let depth = 0;
	let quote: "'" | '"' | "`" | null = null;
	let lineComment = false;
	let blockComment = false;
	for (let index = openingOffset; index < content.length; index += 1) {
		const character = content[index]!;
		const next = content[index + 1];
		if (lineComment) {
			if (character === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (character === "\\") {
				index += 1;
				continue;
			}
			if (character === quote) quote = null;
			continue;
		}
		if (character === "/" && next === "/") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (character === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (character === "(") depth += 1;
		if (character !== ")") continue;
		depth -= 1;
		if (depth === 0) return index;
	}
	return openingOffset;
}

/**
 * Classify JavaScript and TypeScript tests without changing source coordinates.
 *
 * Test/spec files are classified by convention. In mixed files, imports and
 * require bindings come from ast-grep outline items, while source lines identify
 * declarations through those proven bindings. Ranges are 1-based and inclusive.
 */
export function classifyJavaScriptTestRanges(
	filePath: string,
	content: string,
	outline: StructuralFileOutline | undefined,
): JavaScriptTestRange[] {
	const totalLines = lineCount(content);
	if (totalLines === 0) return [];
	if (isConventionalTestPath(filePath)) {
		return [{
			startLine: 1,
			endLine: totalLines,
			reason: "js-test-file",
			confidence: "convention",
		}];
	}

	const bindings = collectBindings(content, outline);
	return normalizeRanges(inlineTestRanges(content, bindings));
}
