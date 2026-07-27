import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createAtlasRepositoryFingerprint } from "./atlas-snapshot-cache";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const FINGERPRINT_SAMPLE_BYTES = 8 * 1024;

const EXCLUDED_DIRECTORIES = new Set([
	".cache",
	".git",
	".hg",
	".next",
	".nuxt",
	".parcel-cache",
	".plannotator",
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

function isRepositoryCandidate(filePath: string): boolean {
	const normalized = normalizeRepositoryPath(filePath);
	return (
		!normalized.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment)) &&
		!EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
	);
}

async function gitRepositoryCandidates(
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
			.filter(isRepositoryCandidate)
			.slice(0, limit)
			.sort();
	} catch {
		return null;
	}
}

async function filesystemRepositoryCandidates(
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
			} else if (entry.isFile() && isRepositoryCandidate(repositoryPath)) {
				results.push(repositoryPath);
				if (results.length >= limit) break;
			}
		}
	}
	return results.sort();
}

async function sampleFileFingerprint(
	absolutePath: string,
	fileBytes: number,
): Promise<string> {
	const handle = await open(absolutePath, "r");
	try {
		const firstLength = Math.min(fileBytes, FINGERPRINT_SAMPLE_BYTES);
		const lastLength = Math.min(
			Math.max(0, fileBytes - firstLength),
			FINGERPRINT_SAMPLE_BYTES,
		);
		const first = Buffer.alloc(firstLength);
		const last = Buffer.alloc(lastLength);
		if (firstLength > 0) await handle.read(first, 0, firstLength, 0);
		if (lastLength > 0) {
			await handle.read(last, 0, lastLength, fileBytes - lastLength);
		}
		return createHash("sha256")
			.update(`sample:${fileBytes}:`)
			.update(first)
			.update(last)
			.digest("hex");
	} finally {
		await handle.close();
	}
}

/**
 * Hash the bounded set of repository files that can affect an Atlas snapshot.
 *
 * Git repositories honor ignore rules. Other directories use a symlink-free
 * traversal with the same generated-path exclusions.
 */
export async function collectAtlasRepositoryFingerprint(
	rootPath: string,
	options: AtlasRepositoryFingerprintOptions = {},
): Promise<AtlasRepositoryFingerprint> {
	const canonicalRoot = await realpath(resolve(rootPath));
	const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
	const maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
	const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
	const discovered = await gitRepositoryCandidates(canonicalRoot, maxFiles + 1) ??
		await filesystemRepositoryCandidates(canonicalRoot, maxFiles + 1);
	const candidates = discovered.slice(0, maxFiles);
	const fingerprintEntries: Array<{ path: string; contentFingerprint: string }> = [{
		path: "\0atlas-fingerprint-options",
		contentFingerprint: `${maxFiles}:${maxFileBytes}:${maxTotalBytes}`,
	}];
	let bytes = 0;
	let fullyHashedBytes = 0;
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
			!fileStats.isFile()
		) continue;

		const hashEntireFile =
			fileStats.size <= maxFileBytes &&
			fullyHashedBytes + fileStats.size <= maxTotalBytes;
		let contentFingerprint: string;
		try {
			if (hashEntireFile) {
				const content = await readFile(absolutePath);
				fullyHashedBytes += content.length;
				contentFingerprint = createHash("sha256").update(content).digest("hex");
			} else {
				truncated = true;
				contentFingerprint = await sampleFileFingerprint(absolutePath, fileStats.size);
			}
		} catch {
			continue;
		}
		bytes += fileStats.size;
		files += 1;
		fingerprintEntries.push({
			path: repositoryPath,
			contentFingerprint,
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
