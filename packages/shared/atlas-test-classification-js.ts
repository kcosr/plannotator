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
	"for",
	"runIf",
	"skipIf",
	"fixme",
	"parallel",
]);

const PARAMETERIZED_MODIFIERS = new Set(["each", "for", "runIf", "skipIf"]);
const CONTROL_HEAD_KEYWORDS = new Set([
	"catch",
	"for",
	"if",
	"switch",
	"while",
	"with",
]);
const REGEX_PREFIX_KEYWORDS = new Set([
	"await",
	"case",
	"delete",
	"do",
	"else",
	"in",
	"instanceof",
	"of",
	"return",
	"throw",
	"typeof",
	"void",
	"yield",
]);

interface MaskedJavaScript {
	content: string;
	templateEnds: Map<number, number>;
}

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

function quotedEnd(
	content: string,
	openingOffset: number,
	quote: "'" | '"',
): number | null {
	for (let index = openingOffset + 1; index < content.length; index += 1) {
		const character = content[index]!;
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (character === quote) return index;
		if (character === "\n" || character === "\r") return null;
	}
	return null;
}

function regexEnd(content: string, openingOffset: number): number | null {
	let inCharacterClass = false;
	for (let index = openingOffset + 1; index < content.length; index += 1) {
		const character = content[index]!;
		if (character === "\\" && index + 1 < content.length) {
			index += 1;
			continue;
		}
		if (character === "\n" || character === "\r") return null;
		if (character === "[") {
			inCharacterClass = true;
			continue;
		}
		if (character === "]") {
			inCharacterClass = false;
			continue;
		}
		if (character !== "/" || inCharacterClass) continue;
		let end = index;
		while (/[A-Za-z]/.test(content[end + 1] ?? "")) end += 1;
		return end;
	}
	return null;
}

function lineCommentEnd(content: string, openingOffset: number): number {
	const newline = content.indexOf("\n", openingOffset + 2);
	return newline < 0 ? content.length - 1 : newline - 1;
}

function blockCommentEnd(content: string, openingOffset: number): number {
	const closing = content.indexOf("*/", openingOffset + 2);
	return closing < 0 ? content.length - 1 : closing + 1;
}

function templateExpressionEnd(
	content: string,
	openingOffset: number,
): number | null {
	let depth = 1;
	let canStartRegex = true;
	let propertyAccess = false;
	let pendingControlParen = false;
	let statementStart = false;
	const controlParens: boolean[] = [];
	const blockBraces: boolean[] = [];
	for (let index = openingOffset + 1; index < content.length; index += 1) {
		const character = content[index]!;
		const next = content[index + 1];
		if (/\s/.test(character)) continue;
		if (character === "'" || character === '"') {
			const end = quotedEnd(content, index, character);
			if (end === null) return null;
			index = end;
			canStartRegex = false;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (character === "`") {
			const end = templateEnd(content, index);
			if (end === null) return null;
			index = end;
			canStartRegex = false;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (character === "/" && next === "/") {
			index = lineCommentEnd(content, index);
			continue;
		}
		if (character === "/" && next === "*") {
			index = blockCommentEnd(content, index);
			continue;
		}
		if (character === "/" && canStartRegex) {
			const end = regexEnd(content, index);
			if (end !== null) {
				index = end;
				canStartRegex = false;
				propertyAccess = false;
				pendingControlParen = false;
				statementStart = false;
				continue;
			}
		}
		if (/[A-Za-z_$]/.test(character)) {
			let end = index + 1;
			while (/[\w$]/.test(content[end] ?? "")) end += 1;
			const word = content.slice(index, end);
			canStartRegex = !propertyAccess && REGEX_PREFIX_KEYWORDS.has(word);
			pendingControlParen = !propertyAccess && CONTROL_HEAD_KEYWORDS.has(word);
			propertyAccess = false;
			statementStart = false;
			index = end - 1;
			continue;
		}
		if (character === ".") {
			canStartRegex = false;
			propertyAccess = true;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (character === "(") {
			controlParens.push(pendingControlParen);
			canStartRegex = true;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (character === ")") {
			const controlHead = controlParens.pop() ?? false;
			canStartRegex = controlHead;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = controlHead;
			continue;
		}
		if (character === "{") {
			blockBraces.push(statementStart);
			depth += 1;
			canStartRegex = true;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = true;
			continue;
		}
		if (character === "}") {
			depth -= 1;
			if (depth === 0) return index;
			const statementBlock = blockBraces.pop() ?? false;
			canStartRegex = statementBlock;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = statementBlock;
			continue;
		}
		if (character === ";") {
			canStartRegex = true;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = true;
			continue;
		}
		canStartRegex = !/[\w)\].]/.test(character);
		propertyAccess = false;
		pendingControlParen = false;
		statementStart = false;
	}
	return null;
}

function templateEnd(content: string, openingOffset: number): number | null {
	for (let index = openingOffset + 1; index < content.length; index += 1) {
		const character = content[index]!;
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (character === "`") return index;
		if (character !== "$" || content[index + 1] !== "{") continue;
		const end = templateExpressionEnd(content, index + 1);
		if (end === null) return null;
		index = end;
	}
	return null;
}

function maskRange(masked: string[], content: string, start: number, end: number): void {
	for (let index = start; index <= end; index += 1) {
		if (content[index] !== "\n" && content[index] !== "\r") masked[index] = " ";
	}
}

function maskNonCode(content: string): MaskedJavaScript {
	const masked = content.split("");
	const templateEnds = new Map<number, number>();
	let canStartRegex = true;
	let propertyAccess = false;
	let pendingControlParen = false;
	let statementStart = true;
	const controlParens: boolean[] = [];
	const blockBraces: boolean[] = [];
	for (let index = 0; index < content.length; index += 1) {
		const character = content[index]!;
		const next = content[index + 1];
		if (/\s/.test(character)) continue;
		if (character === "/" && next === "/") {
			const end = lineCommentEnd(content, index);
			maskRange(masked, content, index, end);
			index = end;
			continue;
		}
		if (character === "/" && next === "*") {
			const end = blockCommentEnd(content, index);
			maskRange(masked, content, index, end);
			index = end;
			continue;
		}
		if (character === "'" || character === '"') {
			const end = quotedEnd(content, index, character);
			if (end !== null) {
				maskRange(masked, content, index, end);
				index = end;
			}
			canStartRegex = false;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (character === "`") {
			const end = templateEnd(content, index);
			if (end !== null) {
				templateEnds.set(index, end);
				maskRange(masked, content, index, end);
				index = end;
			}
			canStartRegex = false;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (character === "/" && canStartRegex) {
			const end = regexEnd(content, index);
			if (end !== null) {
				maskRange(masked, content, index, end);
				index = end;
				canStartRegex = false;
				propertyAccess = false;
				pendingControlParen = false;
				statementStart = false;
				continue;
			}
		}
		if (/[A-Za-z_$]/.test(character)) {
			let end = index + 1;
			while (/[\w$]/.test(content[end] ?? "")) end += 1;
			const word = content.slice(index, end);
			canStartRegex = !propertyAccess && REGEX_PREFIX_KEYWORDS.has(word);
			pendingControlParen = !propertyAccess && CONTROL_HEAD_KEYWORDS.has(word);
			propertyAccess = false;
			statementStart = false;
			index = end - 1;
			continue;
		}
		if (/\d/.test(character)) {
			let end = index + 1;
			while (/[\w.]/.test(content[end] ?? "")) end += 1;
			index = end - 1;
			canStartRegex = false;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (
			(character === "+" && next === "+") ||
			(character === "-" && next === "-")
		) {
			index += 1;
			canStartRegex = false;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (character === ".") {
			canStartRegex = false;
			propertyAccess = true;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (character === "(") {
			controlParens.push(pendingControlParen);
			canStartRegex = true;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = false;
			continue;
		}
		if (character === ")") {
			const controlHead = controlParens.pop() ?? false;
			canStartRegex = controlHead;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = controlHead;
			continue;
		}
		if (character === "{") {
			blockBraces.push(statementStart);
			canStartRegex = true;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = true;
			continue;
		}
		if (character === "}") {
			const statementBlock = blockBraces.pop() ?? false;
			canStartRegex = statementBlock;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = statementBlock;
			continue;
		}
		if (character === ";") {
			canStartRegex = true;
			propertyAccess = false;
			pendingControlParen = false;
			statementStart = true;
			continue;
		}
		canStartRegex = !/[)\]}.]/.test(character);
		propertyAccess = false;
		pendingControlParen = false;
		statementStart = false;
	}
	return { content: masked.join(""), templateEnds };
}

function skipWhitespace(content: string, offset: number): number {
	let cursor = offset;
	while (cursor < content.length && /\s/.test(content[cursor]!)) cursor += 1;
	return cursor;
}

function skipMaskedTrivia(
	masked: MaskedJavaScript,
	offset: number,
): { offset: number; taggedTemplate: boolean } {
	let cursor = offset;
	let taggedTemplate = false;
	while (cursor < masked.content.length) {
		const templateEndOffset = masked.templateEnds.get(cursor);
		if (templateEndOffset !== undefined) {
			taggedTemplate = true;
			cursor = templateEndOffset + 1;
			continue;
		}
		if (!/\s/.test(masked.content[cursor]!)) break;
		cursor += 1;
	}
	return { offset: cursor, taggedTemplate };
}

function matchingCallEnd(content: string, openingOffset: number): number | null {
	let depth = 0;
	for (let index = openingOffset; index < content.length; index += 1) {
		if (content[index] === "(") depth += 1;
		if (content[index] !== ")") continue;
		depth -= 1;
		if (depth === 0) return index;
	}
	return null;
}

function inlineTestRanges(
	content: string,
	bindings: Map<string, Binding>,
): JavaScriptTestRange[] {
	const ranges: JavaScriptTestRange[] = [];
	const masked = maskNonCode(content);
	for (const match of masked.content.matchAll(
		/^[\t ]*(?:await[\t ]+)?([A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*)/gm,
	)) {
		const callee = match[1]!;
		if (!semanticCallee(callee, bindings)) continue;
		const startOffset = match.index;
		const firstCall = skipMaskedTrivia(
			masked,
			startOffset + match[0].length,
		);
		let openingOffset = firstCall.offset;
		if (masked.content[openingOffset] !== "(") continue;
		let closingOffset = matchingCallEnd(masked.content, openingOffset);
		if (closingOffset === null) continue;

		const lastPart = calleeParts(callee).at(-1);
		if (lastPart && PARAMETERIZED_MODIFIERS.has(lastPart)) {
			if (!firstCall.taggedTemplate) {
				openingOffset = skipWhitespace(masked.content, closingOffset + 1);
				if (masked.content[openingOffset] !== "(") continue;
				closingOffset = matchingCallEnd(masked.content, openingOffset);
				if (closingOffset === null) continue;
			}
		}
		ranges.push({
			startLine: lineAtOffset(content, startOffset),
			endLine: lineAtOffset(content, closingOffset),
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
