import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createAtlasRepositoryFingerprint } from "./atlas-snapshot-cache";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

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
	excludedPaths?: string[];
	signal?: AbortSignal;
	contentCache?: AtlasRepositoryFingerprintCache;
}

export interface AtlasRepositoryFingerprint {
	fingerprint: string;
	files: number;
	bytes: number;
	truncated: boolean;
}

interface CachedContentFingerprint {
	signature: string;
	fingerprint: string;
	cachedAtMs: number;
}

export interface AtlasRepositoryFingerprintCacheStats {
	entries: number;
	hits: number;
	misses: number;
}

const RACY_FINGERPRINT_WINDOW_MS = 2_000;

/**
 * Reuses file-content hashes while stable identity metadata is unchanged.
 *
 * The cache is scoped to one Atlas index session. Candidate discovery and
 * metadata validation still run for every generation check, so additions,
 * removals, replacements, and in-place writes invalidate the cached result.
 */
export class AtlasRepositoryFingerprintCache {
	#entries = new Map<string, CachedContentFingerprint>();
	#hits = 0;
	#misses = 0;
	#now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	get(
		cacheKey: string,
		signature: string,
		latestChangeMs: number,
	): string | undefined {
		const entry = this.#entries.get(cacheKey);
		if (!entry || entry.signature !== signature) return undefined;
		// Coarse filesystems can report an unchanged stat within the write tick.
		if (
			latestChangeMs >=
			entry.cachedAtMs - RACY_FINGERPRINT_WINDOW_MS
		) return undefined;
		this.#hits += 1;
		return entry.fingerprint;
	}

	set(cacheKey: string, signature: string, fingerprint: string): void {
		this.#entries.set(cacheKey, {
			signature,
			fingerprint,
			cachedAtMs: this.#now(),
		});
		this.#misses += 1;
	}

	retain(cacheKeys: Set<string>): void {
		for (const cacheKey of this.#entries.keys()) {
			if (!cacheKeys.has(cacheKey)) this.#entries.delete(cacheKey);
		}
	}

	getStats(): AtlasRepositoryFingerprintCacheStats {
		return {
			entries: this.#entries.size,
			hits: this.#hits,
			misses: this.#misses,
		};
	}
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
	signal?: AbortSignal,
): Promise<string[] | null> {
	signal?.throwIfAborted();
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
				signal,
			},
		);
		signal?.throwIfAborted();
		return stdout
			.toString("utf8")
			.split("\0")
			.filter(Boolean)
			.map(normalizeRepositoryPath)
			.filter(isRepositoryCandidate)
			.slice(0, limit)
			.sort();
	} catch {
		signal?.throwIfAborted();
		return null;
	}
}

async function filesystemRepositoryCandidates(
	rootPath: string,
	limit: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const results: string[] = [];
	const pending = [rootPath];
	while (pending.length > 0 && results.length < limit) {
		signal?.throwIfAborted();
		const directory = pending.pop()!;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			signal?.throwIfAborted();
			continue;
		}
		entries.sort((first, second) => first.name.localeCompare(second.name));
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			signal?.throwIfAborted();
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

async function fileFingerprint(
	absolutePath: string,
	signal?: AbortSignal,
): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(absolutePath, { signal })) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

function fileSignature(stats: BigIntStats): string {
	return [
		stats.dev,
		stats.ino,
		stats.mode,
		stats.size,
		stats.mtimeNs,
		stats.ctimeNs,
	].join(":");
}

function latestFileChangeMs(stats: BigIntStats): number {
	return Number(
		(stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs) /
		1_000_000n,
	);
}

async function stableFileFingerprint(
	absolutePath: string,
	contentCache: AtlasRepositoryFingerprintCache | undefined,
	signal?: AbortSignal,
): Promise<{ bytes: number; fingerprint: string } | null> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		signal?.throwIfAborted();
		let before: BigIntStats;
		try {
			before = await lstat(absolutePath, { bigint: true });
		} catch {
			signal?.throwIfAborted();
			return null;
		}
		if (before.isSymbolicLink() || !before.isFile()) return null;
		const signature = fileSignature(before);
		const cached = contentCache?.get(
			absolutePath,
			signature,
			latestFileChangeMs(before),
		);
		if (cached) {
			return { bytes: Number(before.size), fingerprint: cached };
		}

		let fingerprint: string;
		try {
			fingerprint = await fileFingerprint(absolutePath, signal);
		} catch {
			signal?.throwIfAborted();
			try {
				const afterFailure = await lstat(absolutePath, { bigint: true });
				if (fileSignature(afterFailure) === signature) return null;
			} catch {
				signal?.throwIfAborted();
			}
			continue;
		}
		let after: BigIntStats;
		try {
			after = await lstat(absolutePath, { bigint: true });
		} catch {
			signal?.throwIfAborted();
			continue;
		}
		if (fileSignature(after) !== signature) continue;
		contentCache?.set(absolutePath, signature, fingerprint);
		return { bytes: Number(after.size), fingerprint };
	}
	throw new Error(`Repository file kept changing while hashing: ${absolutePath}`);
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
	options.signal?.throwIfAborted();
	const canonicalRoot = await realpath(resolve(rootPath));
	const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
	const maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
	const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
	const excludedPaths = new Set(
		(options.excludedPaths ?? []).flatMap((filePath) => {
			const repositoryPath = normalizeRepositoryPath(
				relative(canonicalRoot, resolve(canonicalRoot, filePath)),
			);
			if (
				!repositoryPath ||
				repositoryPath === ".." ||
				repositoryPath.startsWith("../")
			) return [];
			return [
				repositoryPath,
				`${repositoryPath}-journal`,
				`${repositoryPath}-shm`,
				`${repositoryPath}-wal`,
			];
		}),
	);
	const candidateLimit = maxFiles + excludedPaths.size + 1;
	const discovered = (await gitRepositoryCandidates(
		canonicalRoot,
		candidateLimit,
		options.signal,
	) ??
		await filesystemRepositoryCandidates(
			canonicalRoot,
			candidateLimit,
			options.signal,
		))
		.filter((repositoryPath) => !excludedPaths.has(repositoryPath));
	const candidates = discovered.slice(0, maxFiles);
	const fingerprintEntries: Array<{ path: string; contentFingerprint: string }> = [{
		path: "\0atlas-fingerprint-options",
		contentFingerprint: `${maxFiles}:${maxFileBytes}:${maxTotalBytes}`,
	}];
	let bytes = 0;
	let files = 0;
	let truncated = discovered.length > maxFiles;
	const retainedCacheKeys = new Set<string>();

	for (const repositoryPath of candidates) {
		options.signal?.throwIfAborted();
		const absolutePath = join(canonicalRoot, ...repositoryPath.split("/"));
		const file = await stableFileFingerprint(
			absolutePath,
			options.contentCache,
			options.signal,
		);
		if (!file) continue;
		retainedCacheKeys.add(absolutePath);
		if (
			file.bytes > maxFileBytes ||
			bytes + file.bytes > maxTotalBytes
		) truncated = true;
		bytes += file.bytes;
		files += 1;
		fingerprintEntries.push({
			path: repositoryPath,
			contentFingerprint: file.fingerprint,
		});
	}
	options.contentCache?.retain(retainedCacheKeys);
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
