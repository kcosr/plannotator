import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createAtlasRepositoryFingerprint } from "./atlas-snapshot-cache";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

const SOURCE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cjs",
	".cpp",
	".cts",
	".cxx",
	".go",
	".h",
	".hh",
	".hpp",
	".hxx",
	".java",
	".js",
	".jsx",
	".mjs",
	".mts",
	".py",
	".pyi",
	".rake",
	".rb",
	".rs",
	".ts",
	".tsx",
]);

const EXCLUDED_DIRECTORIES = new Set([
	".cache",
	".git",
	".hg",
	".next",
	".nuxt",
	".parcel-cache",
	".pytest_cache",
	".svn",
	".turbo",
	".venv",
	"__pycache__",
	"bower_components",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
	"vendor",
	"vendors",
]);

const EXCLUDED_FILE_PATTERNS = [
	/(?:^|\/)(?:package-lock|npm-shrinkwrap|yarn|pnpm-lock|bun)\.lock$/i,
	/(?:^|\/)(?:composer\.lock|cargo\.lock|go\.sum)$/i,
	/\.min\.(?:js|css)$/i,
	/\.map$/i,
	/\.generated\.[^/]+$/i,
	/(?:^|\/)generated(?:\/|$)/i,
	/(?:^|\/)__generated__(?:\/|$)/i,
];

export interface AtlasRepositoryFingerprintOptions {
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

export interface AtlasRepositoryFingerprint {
	fingerprint: string;
	files: number;
	bytes: number;
	truncated: boolean;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function normalizeRepositoryPath(filePath: string): string {
	return filePath.split(sep).join("/").replace(/^\.\/+/, "");
}

function isSourceCandidate(filePath: string): boolean {
	const normalized = normalizeRepositoryPath(filePath);
	return (
		SOURCE_EXTENSIONS.has(extname(normalized).toLowerCase()) &&
		!normalized.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment)) &&
		!EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
	);
}

async function gitSourceCandidates(
	rootPath: string,
	limit: number,
): Promise<string[] | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			[
				"-C",
				rootPath,
				"ls-files",
				"--cached",
				"--others",
				"--exclude-standard",
				"-z",
			],
			{
				encoding: "buffer",
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				timeout: 15_000,
			},
		);
		return stdout
			.toString("utf8")
			.split("\0")
			.filter(Boolean)
			.map(normalizeRepositoryPath)
			.filter(isSourceCandidate)
			.slice(0, limit)
			.sort();
	} catch {
		return null;
	}
}

async function filesystemSourceCandidates(
	rootPath: string,
	limit: number,
): Promise<string[]> {
	const results: string[] = [];
	const pending = [rootPath];
	while (pending.length > 0 && results.length < limit) {
		const directory = pending.pop()!;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((first, second) => first.name.localeCompare(second.name));
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index]!;
			if (entry.isSymbolicLink()) continue;
			const absolutePath = join(directory, entry.name);
			const repositoryPath = normalizeRepositoryPath(relative(rootPath, absolutePath));
			if (
				entry.isDirectory() &&
				!repositoryPath.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment))
			) {
				pending.push(absolutePath);
			} else if (entry.isFile() && isSourceCandidate(repositoryPath)) {
				results.push(repositoryPath);
				if (results.length >= limit) break;
			}
		}
	}
	return results.sort();
}

/**
 * Hash the bounded set of source files that can affect an Atlas snapshot.
 *
 * Git repositories honor ignore rules. Other directories use a symlink-free
 * traversal with the same source extension and generated-directory exclusions.
 */
export async function collectAtlasRepositoryFingerprint(
	rootPath: string,
	options: AtlasRepositoryFingerprintOptions = {},
): Promise<AtlasRepositoryFingerprint> {
	const canonicalRoot = await realpath(resolve(rootPath));
	const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
	const maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
	const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
	const discovered = await gitSourceCandidates(canonicalRoot, maxFiles + 1) ??
		await filesystemSourceCandidates(canonicalRoot, maxFiles + 1);
	const candidates = discovered.slice(0, maxFiles);
	const fingerprintEntries: Array<{ path: string; contentFingerprint: string }> = [{
		path: "\0atlas-fingerprint-options",
		contentFingerprint: `${maxFiles}:${maxFileBytes}:${maxTotalBytes}`,
	}];
	let bytes = 0;
	let files = 0;
	let truncated = discovered.length > maxFiles;

	for (const repositoryPath of candidates) {
		const absolutePath = join(canonicalRoot, ...repositoryPath.split("/"));
		let fileStats;
		try {
			fileStats = await lstat(absolutePath);
		} catch {
			continue;
		}
		if (
			fileStats.isSymbolicLink() ||
			!fileStats.isFile() ||
			fileStats.size > maxFileBytes
		) continue;
		if (bytes + fileStats.size > maxTotalBytes) {
			truncated = true;
			break;
		}
		let content: Buffer;
		try {
			content = await readFile(absolutePath);
		} catch {
			continue;
		}
		bytes += content.length;
		files += 1;
		fingerprintEntries.push({
			path: repositoryPath,
			contentFingerprint: createHash("sha256").update(content).digest("hex"),
		});
	}
	fingerprintEntries.push({
		path: "\0atlas-fingerprint-result",
		contentFingerprint: `${files}:${bytes}:${truncated ? 1 : 0}`,
	});
	return {
		fingerprint: createAtlasRepositoryFingerprint(fingerprintEntries),
		files,
		bytes,
		truncated,
	};
}
