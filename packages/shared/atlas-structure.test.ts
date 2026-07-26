import { describe, expect, test } from "bun:test";
import {
	analyzeAtlasStructure,
	getManagedAstGrepBinaryPath,
	parseAstGrepVersion,
	parseOutlineStream,
	type AtlasStructureRuntime,
} from "./atlas-structure";

const outline = JSON.stringify({
	path: "src/main.ts",
	language: "TypeScript",
	items: [
		{
			role: "item",
			symbolType: "function",
			name: "main",
			range: {
				start: { line: 2, column: 7 },
				end: { line: 4, column: 1 },
			},
			signature: "export function main() {",
			astKind: "export_statement",
			isImport: false,
			isExported: true,
			members: [],
		},
	],
});

describe("Atlas ast-grep structure provider", () => {
	test("parses versions and validates the outline stream", () => {
		expect(parseAstGrepVersion("ast-grep 0.45.0\n")).toBe("0.45.0");
		expect(parseAstGrepVersion("sg 0.45.0\n")).toBeNull();
		expect(parseOutlineStream(`${outline}\n`)).toEqual([
			expect.objectContaining({
				path: "src/main.ts",
				language: "TypeScript",
				items: [
					expect.objectContaining({
						name: "main",
						range: {
							start: { line: 2, column: 7 },
							end: { line: 4, column: 1 },
						},
					}),
				],
			}),
		]);
		expect(() => parseOutlineStream("{not-json}\n")).toThrow(
			"malformed outline JSON",
		);
	});

	test("uses an explicit validated analyzer and batches structured output", async () => {
		const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
		const runtime: AtlasStructureRuntime = {
			runCommand: async (command, args, options) => {
				calls.push({ command, args, cwd: options?.cwd });
				return args[0] === "--version"
					? { stdout: "ast-grep 0.45.0\n", stderr: "", exitCode: 0 }
					: { stdout: `${outline}\n`, stderr: "", exitCode: 0 };
			},
			fileExists: (path) => path === "/tools/ast-grep",
			env: { PLANNOTATOR_AST_GREP_PATH: "/tools/ast-grep" },
			dataDir: "/data",
			moduleDir: "/app/packages/shared",
			pathDelimiter: ":",
			platform: "linux",
		};

		const result = await analyzeAtlasStructure(
			"/repo",
			["src/main.ts"],
			runtime,
		);
		expect(result.analyzer).toEqual({
			name: "ast-grep",
			version: "0.45.0",
			source: "env",
			languages: ["TypeScript"],
		});
		expect(result.files.get("src/main.ts")?.items[0]?.name).toBe("main");
		expect(calls[1]).toEqual(expect.objectContaining({
			command: "/tools/ast-grep",
			cwd: "/repo",
		}));
		expect(calls[1]?.args).toContain("--json=stream");
	});

	test("keeps the managed analyzer under the Plannotator data directory", () => {
		expect(getManagedAstGrepBinaryPath("/data", "linux")).toBe(
			"/data/vendor/ast-grep/0.45.0/ast-grep",
		);
		expect(getManagedAstGrepBinaryPath("C:\\data", "win32")).toEndWith(
			"ast-grep.exe",
		);
	});
});
