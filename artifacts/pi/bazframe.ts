import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	getAgentDir,
	loadSkillsFromDir,
	VERSION as PI_VERSION,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";

const MAX_INSTRUCTIONS_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 1024;
const MAX_REGISTRATION_BYTES = 64 * 1024;
const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_ALIAS_SUFFIX = "-x-bazframe";
const SOURCE_LIMITS = { depth: 8, entries: 256, skills: 64 } as const;
const UNKNOWN_SOURCE_ID = "<unknown-source>";
const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const GIT_ENVIRONMENT_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

interface LegacyRegistration {
	schemaVersion: 1;
	repository: string;
	mode: "adaptive-context";
	profile: "active";
}

interface DisabledOverride {
	schemaVersion: 2;
	repository: string;
	disabled: true;
}

interface EnabledOverride {
	schemaVersion: 3;
	repository: string;
	enabled: true;
}

interface DisabledGlobalPolicy {
	schemaVersion: 1;
	disabled: true;
}

type ProjectState = LegacyRegistration | DisabledOverride | EnabledOverride;
type GlobalPolicy = "enabled" | "disabled" | "unresolved";
type ProjectStateResolution =
	| "absent"
	| "legacy-inherit"
	| "disabled-override"
	| "enabled-override"
	| "unresolved";
type ProjectBehavior =
	| "outside-git"
	| "enabled-global"
	| "enabled-project"
	| "disabled-global"
	| "disabled-project"
	| "error";

interface InstructionFile {
	path: string;
	content: string;
}

interface SourceDescriptor {
	schemaVersion: 1;
	sourceId: string;
	sourceRoot: string;
	snapshotDigest: string;
	sourceUnitRoot: string;
}
interface DirectSourceUnit {
	schemaVersion: 1;
	sourceId: string;
	sourceRoot?: string;
	snapshotDigest?: string;
	sourceUnitRoot?: string;
	descriptorPath: string;
	preparationState: "ready" | "failed";
	rebuildAvailability: "available" | "unavailable";
}

interface DerivedSkill {
	name: string;
	baseDir: string;
	definitionPath: string;
	sourceId: string;
	sourceRoot: string;
	relativePath: string;
	skill: Skill;
}

interface SourceDiagnostic {
	category: "invalid-reference" | "invalid-source" | "broken-root" | "broken-snapshot" | "limit-exceeded" | "internal-symlink"
		| "unsupported-entry" | "mixed-root" | "invalid-definition" | "duplicate-name"
		| "pi-loader" | "io-error";
	sourceId: string;
	path: string;
	limit?: "depth" | "entries" | "skills";
	name?: string;
	diagnosticIndex?: number;
	message?: string;
}

interface ProfileState {
	id: string;
	directory: string;
	instructionsPath: string;
	instructions: string;
	flatSkills: Skill[];
	directSourceUnits: DirectSourceUnit[];
	derivedSkills: DerivedSkill[];
	sourceDiagnostics: SourceDiagnostic[];
	skills: Skill[];
	skillDirectories: string[];
	warnings: string[];
}

interface SkillAlias {
	originalName: string;
	aliasName: string;
	aliasPath: string;
}

interface AdapterState {
	cwd: string;
	bazframeHome: string;
	initialized: boolean;
	projectBehavior: ProjectBehavior;
	globalPolicy: GlobalPolicy;
	globalPolicyPath?: string;
	repository?: string;
	projectStatePath?: string;
	projectStateResolution?: ProjectStateResolution;
	projectState?: ProjectState;
	profile?: ProfileState;
	globalContext?: InstructionFile;
	skillAliases: SkillAlias[];
	error?: string;
}

interface GitResult {
	stdout: Uint8Array;
	stderr: Uint8Array;
	error?: Error;
}

function compatibilityFailure(): string | undefined {
	if (!/^0\.82\./.test(PI_VERSION)) {
		return `Bazframe supports Pi 0.82.x; this process is Pi ${PI_VERSION}.`;
	}
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 19)) {
		return `Bazframe requires Node 22.19 or newer; this process is Node ${process.versions.node}.`;
	}
	return undefined;
}

function isWithin(path: string, root: string): boolean {
	const pathFromRoot = relative(root, path);
	return pathFromRoot === ""
		|| (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function resolveBazframeHome(): string {
	const configured = process.env.BAZFRAME_HOME;
	if (configured === undefined) return join(homedir(), ".bazframe");
	if (configured.length === 0 || !isAbsolute(configured) || configured.includes("\0")) {
		throw new Error("BAZFRAME_HOME must be a non-empty absolute path without NUL bytes.");
	}
	return resolve(configured);
}

function runGit(cwd: string): Promise<GitResult> {
	const environment = { ...process.env, LANG: "C", LC_ALL: "C" };
	for (const variable of GIT_ENVIRONMENT_VARIABLES) delete environment[variable];
	return new Promise((resolveResult) => {
		execFile(
			"git",
			["-c", "core.quotePath=false", "rev-parse", "--path-format=absolute", "--show-toplevel"],
			{
				cwd,
				env: environment,
				encoding: "buffer",
				maxBuffer: 64 * 1024,
				timeout: 5000,
			},
			(error, stdout, stderr) => {
				resolveResult({
					stdout: Uint8Array.from(stdout),
					stderr: Uint8Array.from(stderr),
					...(error === null ? {} : { error }),
				});
			},
		);
	});
}

function isConfirmedOutsideGit(result: GitResult): boolean {
	if (result.error === undefined || !("code" in result.error) || result.error.code !== 128) {
		return false;
	}
	let diagnostic: string;
	try {
		diagnostic = decodeUtf8(result.stderr, "Git diagnostic").trim();
	} catch {
		return false;
	}
	return diagnostic.startsWith("fatal: not a git repository (or any of the parent directories): .git");
}

function gitFailureMessage(cwd: string, result: GitResult): string {
	const error = result.error;
	const details: string[] = [];
	if (error !== undefined && "code" in error && error.code !== undefined) {
		details.push(`code ${String(error.code)}`);
	}
	if (error !== undefined && "signal" in error && error.signal !== undefined) {
		details.push(`signal ${String(error.signal)}`);
	}
	if (error !== undefined && "killed" in error && error.killed === true) {
		details.push("killed");
	}
	try {
		const diagnostic = decodeUtf8(result.stderr, "Git diagnostic").trim();
		if (diagnostic.length > 0) details.push(diagnostic);
	} catch {
		details.push("Git diagnostic was not valid UTF-8");
	}
	return `Git worktree discovery failed in ${cwd}${details.length === 0 ? "" : ` (${details.join("; ")})`}.`;
}

async function findRepository(cwd: string): Promise<string | undefined> {
	let canonicalCwd: string;
	try {
		canonicalCwd = await realpath(cwd);
	} catch (error) {
		throw new Error(`Could not canonicalize working directory: ${cwd}`, { cause: error });
	}
	const result = await runGit(canonicalCwd);
	if (isConfirmedOutsideGit(result)) return undefined;
	if (result.error !== undefined) {
		throw new Error(gitFailureMessage(canonicalCwd, result), { cause: result.error });
	}
	const output = decodeUtf8(result.stdout, "Git worktree root").replace(/\r?\n$/, "");
	if (output.length === 0 || output.includes("\0") || !isAbsolute(output)) {
		throw new Error(`Git returned an invalid worktree root: ${JSON.stringify(output)}`);
	}
	let repository: string;
	try {
		repository = await realpath(output);
	} catch (error) {
		throw new Error(`Could not canonicalize Git worktree root: ${output}`, { cause: error });
	}
	if (!isWithin(canonicalCwd, repository)) {
		throw new Error(`Git worktree root does not contain the working directory: ${repository}`);
	}
	return repository;
}

function registrationPath(bazframeHome: string, repository: string): string {
	const projectId = createHash("sha256").update(repository).digest("hex");
	return join(bazframeHome, "projects", `${projectId}.json`);
}

function globalStatePath(bazframeHome: string): string {
	return join(bazframeHome, "global.json");
}

async function pathKind(path: string): Promise<"absent" | "file" | "directory" | "other"> {
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) return "other";
		if (metadata.isFile()) return "file";
		if (metadata.isDirectory()) return "directory";
		return "other";
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "absent";
		throw error;
	}
}

async function readManagedFile(path: string, label: string, maxBytes: number): Promise<Uint8Array> {
	const metadata = await lstat(path);
	if (metadata.isSymbolicLink() || !metadata.isFile()) {
		throw new Error(`${label} must be a physical regular file: ${path}`);
	}
	if (metadata.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${path}`);
	const bytes = await readFile(path);
	if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${path}`);
	return bytes;
}

async function readUserFile(path: string, label: string, maxBytes: number): Promise<Uint8Array> {
	const metadata = await stat(path);
	if (!metadata.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
	if (metadata.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${path}`);
	const bytes = await readFile(path);
	if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${path}`);
	return bytes;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
	if (bytes.includes(0)) throw new Error(`${label} contains a NUL byte.`);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${label} is not valid UTF-8.`);
	}
}

async function parseGlobalPolicy(path: string): Promise<DisabledGlobalPolicy> {
	let value: unknown;
	try {
		value = JSON.parse(decodeUtf8(
			await readManagedFile(path, "Global policy", MAX_STATE_BYTES),
			"Global policy",
		));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in global policy: ${path}`, { cause: error });
		}
		throw error;
	}
	if (
		value === null
		|| typeof value !== "object"
		|| Array.isArray(value)
		|| !hasExactKeys(value as Record<string, unknown>, ["schemaVersion", "disabled"])
	) {
		throw new Error(`Invalid Bazframe global policy: ${path}`);
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.schemaVersion !== 1 || candidate.disabled !== true) {
		throw new Error(`Unsupported Bazframe global policy: ${path}`);
	}
	return { schemaVersion: 1, disabled: true };
}

async function parseProjectState(path: string, repository: string): Promise<ProjectState> {
	let value: unknown;
	try {
		value = JSON.parse(decodeUtf8(
			await readManagedFile(path, "Repository project state", MAX_REGISTRATION_BYTES),
			"Repository project state",
		));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in repository project state: ${path}`, { cause: error });
		}
		throw error;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid Bazframe repository project state: ${path}`);
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.repository !== repository) {
		throw new Error(`Bazframe repository project state does not match repository ${repository}: ${path}`);
	}
	if (
		candidate.schemaVersion === 1
		&& candidate.mode === "adaptive-context"
		&& candidate.profile === "active"
		&& hasExactKeys(candidate, ["schemaVersion", "repository", "mode", "profile"])
	) {
		return { schemaVersion: 1, repository, mode: "adaptive-context", profile: "active" };
	}
	if (
		candidate.schemaVersion === 2
		&& candidate.disabled === true
		&& hasExactKeys(candidate, ["schemaVersion", "repository", "disabled"])
	) {
		return { schemaVersion: 2, repository, disabled: true };
	}
	if (
		candidate.schemaVersion === 3
		&& candidate.enabled === true
		&& hasExactKeys(candidate, ["schemaVersion", "repository", "enabled"])
	) {
		return { schemaVersion: 3, repository, enabled: true };
	}
	throw new Error(`Unsupported Bazframe repository project state: ${path}`);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length
		&& actual.every((key, index) => key === expected[index]);
}

async function readActiveProfileId(bazframeHome: string): Promise<string> {
	const path = join(bazframeHome, "active-profile");
	const id = decodeUtf8(
		await readManagedFile(path, "Active-profile state", MAX_STATE_BYTES),
		"Active-profile state",
	).replace(/\r?\n$/, "");
	if (!PROFILE_ID.test(id) || id.length > 64) {
		throw new Error(`Invalid active profile ID in ${path}`);
	}
	return id;
}

async function loadProfileSkills(skillsRoot: string): Promise<{ skills: Skill[]; warnings: string[] }> {
	let rootMetadata;
	try {
		rootMetadata = await stat(skillsRoot);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { skills: [], warnings: [] };
		}
		throw error;
	}
	if (!rootMetadata.isDirectory()) throw new Error(`Profile skills path is not a directory: ${skillsRoot}`);

	const skills: Skill[] = [];
	const warnings: string[] = [];
	for (const entry of (await readdir(skillsRoot)).sort()) {
		const candidate = join(skillsRoot, entry);
		let metadata;
		try {
			metadata = await stat(candidate);
		} catch (error) {
			throw new Error(`Could not inspect profile skill candidate ${candidate}: ${String(error)}`, {
				cause: error,
			});
		}
		if (!metadata.isDirectory()) continue;
		try {
			const definition = await stat(join(candidate, "SKILL.md"));
			if (!definition.isFile()) continue;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		const loaded = loadSkillsFromDir({ dir: candidate, source: "bazframe-profile" });
		const errors = loaded.diagnostics.filter((diagnostic) => diagnostic.type === "error");
		if (errors.length > 0 || loaded.skills.length !== 1) {
			throw new Error([
				`Invalid profile skill: ${candidate}`,
				...loaded.diagnostics.map((diagnostic) => diagnostic.message),
			].join("\n"));
		}
		warnings.push(...loaded.diagnostics.map((diagnostic) => diagnostic.message));
		skills.push(loaded.skills[0]);
	}
	return { skills, warnings };
}

class SourceResolutionFailure extends Error {
	constructor(readonly diagnostics: SourceDiagnostic[]) {
		super("source resolution failed");
	}
}

function safeSourceId(value: string): boolean {
	return value.length >= 1 && value.length <= 64 && SKILL_NAME.test(value);
}

function sourceDiagnostic(
	category: SourceDiagnostic["category"],
	sourceId: string,
	path: string,
	extra: Partial<SourceDiagnostic> = {},
): SourceDiagnostic {
	return { category, sourceId, path, ...extra };
}

function failSource(diagnostic: SourceDiagnostic | SourceDiagnostic[]): never {
	throw new SourceResolutionFailure(Array.isArray(diagnostic) ? diagnostic : [diagnostic]);
}

function sourceDescriptorId(name: string): string | undefined {
	if (!name.endsWith(".json")) return undefined;
	const id = name.slice(0, -5);
	return safeSourceId(id) ? id : undefined;
}

function portableSourceRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) return false;
	if (value === ".") return true;
	if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
	return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

class InvalidSourceReference extends Error {}
class InvalidGlobalSource extends Error {}

async function validateSourceReference(
	bazframeHome: string,
	profileId: string,
	sourceId: string,
	expectedReferenceIdentity: SourcePhysicalIdentity,
): Promise<void> {
	if (!PROFILE_ID.test(profileId) || profileId.length > 64 || !safeSourceId(sourceId)) {
		throw new InvalidSourceReference("Invalid profile source reference identity.");
	}
	const profilesPath = join(bazframeHome, "profiles");
	const profilePath = join(profilesPath, profileId);
	const sourcesPath = join(profilePath, "sources");
	const path = join(sourcesPath, `${sourceId}.json`);
	try {
		const value = await readStableSourceJson(
			[bazframeHome, profilesPath, profilePath, sourcesPath],
			path,
			"Profile source reference",
			expectedReferenceIdentity,
		);
		if (!hasExactKeys(value, ["schemaVersion", "source"])
			|| value.schemaVersion !== 1 || value.source !== sourceId) throw new Error("invalid reference fields");
	} catch (error) { throw new InvalidSourceReference(`Invalid profile source reference: ${path}`, { cause: error }); }
}

async function readSourceDescriptor(
	sourceId: string,
	bazframeHome: string,
): Promise<SourceDescriptor> {
	if (!safeSourceId(sourceId)) throw new InvalidGlobalSource("Invalid global source identity.");
	const globalPath = join(bazframeHome, "sources", `${sourceId}.json`);
	let candidate: Record<string, unknown>;
	try {
		candidate = await readStableSourceJson(
			[bazframeHome, join(bazframeHome, "sources")],
			globalPath,
			"Global source",
		);
		if (!hasExactKeys(candidate, ["schemaVersion", "source", "root", "digest", "sourceUnitRoot"])
			|| candidate.schemaVersion !== 1 || candidate.source !== sourceId
			|| typeof candidate.root !== "string" || !isAbsolute(candidate.root) || candidate.root.includes("\0") || resolve(candidate.root) !== candidate.root
			|| basename(candidate.root) !== sourceId
			|| typeof candidate.digest !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.digest)
			|| !portableSourceRelativePath(candidate.sourceUnitRoot)) throw new Error("invalid global source fields");
	} catch (error) { throw new InvalidGlobalSource(`Invalid global source: ${globalPath}`, { cause: error }); }
	return { schemaVersion: 1, sourceId, sourceRoot: candidate.root as string, snapshotDigest: candidate.digest as string, sourceUnitRoot: candidate.sourceUnitRoot as string };
}

async function readStableSourceJson(
	directoryPaths: string[],
	path: string,
	label: string,
	expectedIdentity?: SourcePhysicalIdentity,
): Promise<Record<string, unknown>> {
	const directories: SourceOpenDirectory[] = [];
	let handle: FileHandle | undefined;
	try {
		for (const directoryPath of directoryPaths) directories.push(await openExistingSourceDirectory(directoryPath));
		const before = await lstat(path, { bigint: true });
		if (before.isSymbolicLink() || !before.isFile()
			|| (expectedIdentity !== undefined && !sameSourceIdentity(sourceIdentity(before), expectedIdentity))) throw new Error("not the expected physical file");
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat({ bigint: true });
		const bytes = await handle.readFile();
		const [after, current] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
		const identityBefore = sourceIdentity(before);
		if (!opened.isFile() || !after.isFile() || current.isSymbolicLink() || !current.isFile()
			|| !sameSourceIdentity(sourceIdentity(opened), identityBefore)
			|| !sameSourceIdentity(sourceIdentity(after), identityBefore)
			|| !sameSourceIdentity(sourceIdentity(current), identityBefore)) throw new Error("file identity changed");
		for (const directory of [...directories].reverse()) await assertSourceDirectoryStable(directory);
		return JSON.parse(decodeUtf8(bytes, label)) as Record<string, unknown>;
	} finally {
		await handle?.close().catch(() => undefined);
		for (const directory of [...directories].reverse()) await directory.handle.close().catch(() => undefined);
	}
}

async function openExistingSourceDirectory(path: string): Promise<SourceOpenDirectory> {
	const metadata = await lstat(path, { bigint: true });
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`Source namespace path is not a physical directory: ${path}`);
	return openSourceDirectory(path, sourceIdentity(metadata));
}

interface SourcePhysicalIdentity {
	device: bigint;
	inode: bigint;
}

interface SourceOpenDirectory {
	path: string;
	handle: FileHandle;
	identity: SourcePhysicalIdentity;
}

async function sourceNamespace(profileDirectory: string): Promise<{
	descriptors: { sourceId: string; path: string; identity: SourcePhysicalIdentity }[];
	diagnostics: SourceDiagnostic[];
}> {
	const rootPath = join(profileDirectory, "sources");
	let rootMetadata;
	try {
		rootMetadata = await lstat(rootPath, { bigint: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { descriptors: [], diagnostics: [] };
		}
		return invalidSourceNamespaceRoot();
	}
	if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return invalidSourceNamespaceRoot();

	let root: SourceOpenDirectory | undefined;
	try {
		root = await openSourceDirectory(rootPath, sourceIdentity(rootMetadata));
		const diagnostics: SourceDiagnostic[] = [];
		const descriptors: { sourceId: string; path: string; identity: SourcePhysicalIdentity }[] = [];
		for (const name of await enumerateSourceDirectory(root)) {
			const sourceId = sourceDescriptorId(name);
			const childPath = join(rootPath, name);
			let child;
			try { child = await lstat(childPath, { bigint: true }); } catch {
				diagnostics.push(sourceDiagnostic("invalid-reference", sourceId ?? UNKNOWN_SOURCE_ID, name));
				continue;
			}
			if (sourceId === undefined || child.isSymbolicLink() || !child.isFile()) {
				diagnostics.push(sourceDiagnostic("invalid-reference", sourceId ?? UNKNOWN_SOURCE_ID, name));
				continue;
			}
			descriptors.push({ sourceId, path: childPath, identity: sourceIdentity(child) });
		}
		for (const descriptor of descriptors) {
			try {
				const metadata = await lstat(descriptor.path, { bigint: true });
				if (metadata.isSymbolicLink() || !metadata.isFile()
					|| !sameSourceIdentity(sourceIdentity(metadata), descriptor.identity)) {
					throw new Error("descriptor namespace entry changed");
				}
			} catch {
				diagnostics.push(sourceDiagnostic("invalid-reference", descriptor.sourceId, `${descriptor.sourceId}.json`));
			}
		}
		await assertSourceDirectoryStable(root);
		return { descriptors, diagnostics };
	} catch {
		return invalidSourceNamespaceRoot();
	} finally {
		await root?.handle.close().catch(() => undefined);
	}
}

function invalidSourceNamespaceRoot(): {
	descriptors: { sourceId: string; path: string; identity: SourcePhysicalIdentity }[];
	diagnostics: SourceDiagnostic[];
} {
	return {
		descriptors: [],
		diagnostics: [sourceDiagnostic("invalid-reference", UNKNOWN_SOURCE_ID, ".")],
	};
}

async function openSourceDirectory(
	path: string,
	expectedIdentity: SourcePhysicalIdentity,
): Promise<SourceOpenDirectory> {
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat({ bigint: true });
		if (!metadata.isDirectory() || !sameSourceIdentity(sourceIdentity(metadata), expectedIdentity)) {
			throw new Error("directory identity changed");
		}
		const directory = { path, handle, identity: expectedIdentity };
		await assertSourceDirectoryStable(directory);
		return directory;
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function enumerateSourceDirectory(directory: SourceOpenDirectory): Promise<string[]> {
	await assertSourceDirectoryStable(directory);
	const names = (await readdir(directory.path)).sort(codeUnitCompare);
	await assertSourceDirectoryStable(directory);
	return names;
}

async function assertSourceDirectoryStable(directory: SourceOpenDirectory): Promise<void> {
	const [openedMetadata, pathMetadata] = await Promise.all([
		directory.handle.stat({ bigint: true }),
		lstat(directory.path, { bigint: true }),
	]);
	if (!openedMetadata.isDirectory() || pathMetadata.isSymbolicLink() || !pathMetadata.isDirectory()
		|| !sameSourceIdentity(sourceIdentity(openedMetadata), directory.identity)
		|| !sameSourceIdentity(sourceIdentity(pathMetadata), directory.identity)) {
		throw new Error("directory identity changed");
	}
}

function sourceIdentity(metadata: { dev: bigint; ino: bigint }): SourcePhysicalIdentity {
	return { device: metadata.dev, inode: metadata.ino };
}

function sameSourceIdentity(
	left: SourcePhysicalIdentity | undefined,
	right: SourcePhysicalIdentity | undefined,
): boolean {
	return left !== undefined && right !== undefined
		&& left.device === right.device && left.inode === right.inode;
}

function sourcePathWithin(path: string, root: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot === ""
		|| (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

interface ArtifactEntry { path: string; type: "directory" | "file"; executable?: boolean; sha256?: string }
interface SnapshotIdentity { device: bigint; inode: bigint; mode: number }
interface SnapshotOpenDirectory { path: string; handle: FileHandle; identity: SnapshotIdentity }
const SNAPSHOT_MODES_SUPPORTED = process.platform !== "win32";

function validSnapshotEntryPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0")
		&& (value === "." || value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."));
}

async function snapshotDirectoryIdentity(path: string): Promise<SnapshotIdentity> {
	const metadata = await lstat(path, { bigint: true });
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("invalid snapshot directory");
	return { device: metadata.dev, inode: metadata.ino, mode: Number(metadata.mode) };
}

async function assertSnapshotDirectoryIdentity(path: string, expected: SnapshotIdentity): Promise<void> {
	const metadata = await lstat(path, { bigint: true });
	if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.dev !== expected.device || metadata.ino !== expected.inode) throw new Error("snapshot directory identity changed");
}

async function openSnapshotDirectory(path: string): Promise<SnapshotOpenDirectory> {
	let handle: FileHandle | undefined;
	try {
		const identity = await snapshotDirectoryIdentity(path);
		handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const opened = await handle.stat({ bigint: true });
		if (!opened.isDirectory() || opened.dev !== identity.device || opened.ino !== identity.inode) throw new Error("snapshot directory identity changed");
		const result = { path, handle, identity };
		await assertOpenSnapshotDirectory(result);
		return result;
	} catch (error) {
		await handle?.close().catch(() => undefined);
		throw error;
	}
}

async function assertOpenSnapshotDirectory(directory: SnapshotOpenDirectory): Promise<void> {
	const [opened, current] = await Promise.all([
		directory.handle.stat({ bigint: true }),
		lstat(directory.path, { bigint: true }),
	]);
	if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
		|| opened.dev !== directory.identity.device || opened.ino !== directory.identity.inode
		|| current.dev !== directory.identity.device || current.ino !== directory.identity.inode) throw new Error("snapshot directory identity changed");
}

async function readSnapshotFile(path: string): Promise<{ bytes: Buffer; mode: number }> {
	let handle: FileHandle | undefined;
	try {
		const before = await lstat(path, { bigint: true });
		if (before.isSymbolicLink() || !before.isFile()) throw new Error("invalid snapshot file");
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat({ bigint: true }); const bytes = await handle.readFile(); const after = await lstat(path, { bigint: true });
		if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()
			|| before.dev !== opened.dev || before.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("snapshot file identity changed");
		return { bytes, mode: Number(opened.mode) };
	} finally { await handle?.close().catch(() => undefined); }
}

function assertSnapshotMode(mode: number, expected: number): void {
	if (SNAPSHOT_MODES_SUPPORTED && (mode & 0o777) !== expected) throw new Error("snapshot mode drift");
}

async function verifiedSnapshotSourceRoot(bazframeHome: string, digest: string, sourceUnitRoot: string): Promise<string> {
	const snapshot = join(bazframeHome, "source-snapshots", "sha256", digest);
	let openedSnapshot: SnapshotOpenDirectory | undefined;
	let openedArtifact: SnapshotOpenDirectory | undefined;
	try {
		openedSnapshot = await openSnapshotDirectory(snapshot); assertSnapshotMode(openedSnapshot.identity.mode, 0o500);
		const physicalSnapshot = await realpath(snapshot); await assertOpenSnapshotDirectory(openedSnapshot);
		const names = (await readdir(snapshot)).sort(sourceManifestCompare); await assertOpenSnapshotDirectory(openedSnapshot);
		if (names.join(",") !== "artifact,manifest.json") throw new Error("invalid snapshot root");
		const manifest = await readSnapshotFile(join(snapshot, "manifest.json")); assertSnapshotMode(manifest.mode, 0o400);
		const manifestBytes = manifest.bytes;
		if (createHash("sha256").update(manifestBytes).digest("hex") !== digest) throw new Error("snapshot digest mismatch");
		const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as { schemaVersion?: unknown; entries?: unknown };
		if (Object.keys(parsed).join(",") !== "schemaVersion,entries" || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)
			|| Buffer.from(`${JSON.stringify(parsed)}\n`).compare(manifestBytes) !== 0) throw new Error("invalid snapshot manifest");
		let previous: string | undefined;
		for (const raw of parsed.entries) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid snapshot entry");
			const item = raw as Record<string, unknown>;
			if (!validSnapshotEntryPath(item.path) || (previous !== undefined && sourceManifestCompare(previous, item.path) >= 0)) throw new Error("invalid snapshot entry path");
			previous = item.path;
			const keys = Object.keys(item).join(",");
			if (item.type === "directory" ? keys !== "path,type" : item.type === "file"
				? keys !== "path,type,executable,sha256" || typeof item.executable !== "boolean" || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256)
				: true) throw new Error("invalid snapshot entry");
		}
		const artifactPath = join(snapshot, "artifact"); openedArtifact = await openSnapshotDirectory(artifactPath); assertSnapshotMode(openedArtifact.identity.mode, 0o500);
		const artifact = await realpath(artifactPath);
		if (artifact === physicalSnapshot || !sourcePathWithin(artifact, physicalSnapshot)) throw new Error("snapshot artifact escape");
		await assertOpenSnapshotDirectory(openedSnapshot); await assertOpenSnapshotDirectory(openedArtifact);
		const actual: ArtifactEntry[] = [{ path: ".", type: "directory" }];
		await collectArtifactEntries(artifact, ".", actual, openedArtifact);
		actual.sort((a, b) => sourceManifestCompare(a.path, b.path));
		if (JSON.stringify(actual) !== JSON.stringify(parsed.entries)) throw new Error("snapshot artifact mismatch");
		await assertOpenSnapshotDirectory(openedArtifact); await assertOpenSnapshotDirectory(openedSnapshot);
		if (await realpath(snapshot) !== physicalSnapshot || await realpath(artifactPath) !== artifact) throw new Error("snapshot canonical identity changed");
		let root = artifact;
		if (sourceUnitRoot !== ".") for (const segment of sourceUnitRoot.split("/")) {
			const next = join(root, segment); const metadata = await lstat(next);
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("invalid source-unit root");
			root = await realpath(next); if (!sourcePathWithin(root, artifact)) throw new Error("source-unit root escape");
		}
		await assertOpenSnapshotDirectory(openedArtifact); await assertOpenSnapshotDirectory(openedSnapshot);
		return root;
	} finally {
		await openedArtifact?.handle.close().catch(() => undefined);
		await openedSnapshot?.handle.close().catch(() => undefined);
	}
}

async function collectArtifactEntries(root: string, relativePath: string, entries: ArtifactEntry[], heldRoot: SnapshotOpenDirectory): Promise<void> {
	await assertOpenSnapshotDirectory(heldRoot);
	const directory = relativePath === "." ? root : join(root, ...relativePath.split("/"));
	const identity = await snapshotDirectoryIdentity(directory); assertSnapshotMode(identity.mode, 0o500);
	for (const name of (await readdir(directory)).sort(sourceManifestCompare)) {
		const path = relativePath === "." ? name : `${relativePath}/${name}`; const absolute = join(directory, name); const metadata = await lstat(absolute);
		if (metadata.isSymbolicLink()) throw new Error("snapshot link");
		if (metadata.isDirectory()) { entries.push({ path, type: "directory" }); await collectArtifactEntries(root, path, entries, heldRoot); }
		else if (metadata.isFile()) { const physical = await readSnapshotFile(absolute); const executable = SNAPSHOT_MODES_SUPPORTED && (physical.mode & 0o111) !== 0; assertSnapshotMode(physical.mode, executable ? 0o500 : 0o400); entries.push({ path, type: "file", executable, sha256: createHash("sha256").update(physical.bytes).digest("hex") }); }
		else throw new Error("snapshot special entry");
	}
	await assertSnapshotDirectoryIdentity(directory, identity);
	await assertOpenSnapshotDirectory(heldRoot);
}

function sourceManifestCompare(left: string, right: string): number {
	const a = [...left]; const b = [...right];
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

async function resolveDirectSource(direct: DirectSourceUnit, bazframeHome: string): Promise<DerivedSkill[]> {
	let root: string;
	if (direct.snapshotDigest === undefined || direct.sourceUnitRoot === undefined) {
		failSource(sourceDiagnostic("invalid-source", direct.sourceId, `${direct.sourceId}.json`));
	}
	try { root = await verifiedSnapshotSourceRoot(bazframeHome, direct.snapshotDigest, direct.sourceUnitRoot); }
	catch { failSource(sourceDiagnostic("broken-snapshot", direct.sourceId, ".")); }
	try {
		const metadata = await lstat(root);
		if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(root) !== root) {
			failSource(sourceDiagnostic("broken-root", direct.sourceId, "."));
		}
	} catch (error) {
		if (error instanceof SourceResolutionFailure) throw error;
		failSource(sourceDiagnostic("broken-root", direct.sourceId, "."));
	}
	let entryCount = 0;
	let skillCount = 0;
	const rootDefinition = await physicalSourceRootDefinition(direct, root);
	const derived: DerivedSkill[] = [];
	const diagnostic = (category: SourceDiagnostic["category"], path: string, extra = {}) =>
		sourceDiagnostic(category, direct.sourceId, path, extra);

	async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
		let names: string[];
		try { names = (await readdir(directory)).sort(); } catch {
			failSource(diagnostic("io-error", relativeDirectory));
		}
		for (const name of names) {
			const path = relativeDirectory === "." ? name : `${relativeDirectory}/${name}`;
			const absolute = join(directory, name);
			let metadata;
			try { metadata = await lstat(absolute); } catch {
				failSource(diagnostic("io-error", path));
			}
			if ((name === ".git" || name === "node_modules")
				&& (metadata.isDirectory() || metadata.isSymbolicLink())) continue;
			entryCount += 1;
			if (entryCount > SOURCE_LIMITS.entries) {
				failSource(diagnostic("limit-exceeded", path, { limit: "entries" }));
			}
			if (metadata.isDirectory() && depth + 1 > SOURCE_LIMITS.depth) {
				failSource(diagnostic("limit-exceeded", path, { limit: "depth" }));
			}
			if (metadata.isSymbolicLink()) failSource(diagnostic("internal-symlink", path));
			if (!metadata.isDirectory() && !metadata.isFile()) {
				failSource(diagnostic("unsupported-entry", path));
			}
			try {
				const canonical = await realpath(absolute);
				if (canonical !== resolve(absolute) || !sourcePathWithin(canonical, root)) {
					failSource(diagnostic("io-error", path));
				}
			} catch (error) {
				if (error instanceof SourceResolutionFailure) throw error;
				failSource(diagnostic("io-error", path));
			}
			if (metadata.isDirectory()) {
				await visit(absolute, path, depth + 1);
				continue;
			}
			if (name !== "SKILL.md") continue;
			skillCount += 1;
			if (skillCount > SOURCE_LIMITS.skills) {
				failSource(diagnostic("limit-exceeded", path, { limit: "skills" }));
			}
			if (relativeDirectory !== "." && rootDefinition) {
				failSource(diagnostic("mixed-root", path));
			}
			const loaded = loadSkillsFromDir({ dir: directory, source: "bazframe-source-unit" });
			const errors = loaded.diagnostics.filter((item) => item.type === "error");
			const matching = loaded.skills.filter((skill) =>
				skill.baseDir === directory && skill.filePath === absolute);
			const exact = matching.length === 1 && safeSourceId(matching[0]?.name ?? "");
			if (errors.length > 0 || !exact) {
				const returned = loaded.diagnostics.length === 0
					? [{ message: "Pi loader rejected definition without a diagnostic" }]
					: loaded.diagnostics;
				failSource(returned.map((item, diagnosticIndex) => diagnostic("pi-loader", path, {
					diagnosticIndex,
					message: item.message,
				})));
			}
			const skill = matching[0];
			derived.push({
				name: skill.name,
				baseDir: skill.baseDir,
				definitionPath: skill.filePath,
				sourceId: direct.sourceId,
				sourceRoot: root,
				relativePath: path,
				skill,
			});
		}
	}
	await visit(root, ".", 0);
	const descendant = derived.find((skill) => skill.relativePath !== "SKILL.md");
	if (rootDefinition && descendant !== undefined) {
		failSource(diagnostic("mixed-root", descendant.relativePath));
	}
	return derived;
}

function codeUnitCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

async function physicalSourceRootDefinition(direct: DirectSourceUnit, root: string): Promise<boolean> {
	try {
		const metadata = await lstat(join(root, "SKILL.md"));
		return !metadata.isSymbolicLink() && metadata.isFile();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		failSource(sourceDiagnostic("io-error", direct.sourceId, "SKILL.md"));
	}
}

function sortSourceDiagnostics(diagnostics: SourceDiagnostic[]): SourceDiagnostic[] {
	return diagnostics.sort((left, right) => codeUnitCompare(left.sourceId, right.sourceId)
		|| codeUnitCompare(left.path, right.path)
		|| codeUnitCompare(left.category, right.category)
		|| (left.diagnosticIndex ?? 0) - (right.diagnosticIndex ?? 0)
		|| codeUnitCompare(left.message ?? "", right.message ?? ""));
}

async function loadProfileSources(
	profileDirectory: string,
	flatSkills: Skill[],
): Promise<{
	directSourceUnits: DirectSourceUnit[];
	derivedSkills: DerivedSkill[];
	diagnostics: SourceDiagnostic[];
}> {
	const namespace = await sourceNamespace(profileDirectory);
	const profileParent = resolve(profileDirectory, "..");
	const bazframeHome = profileParent.endsWith(`${sep}profiles`) ? resolve(profileParent, "..") : profileParent;
	const directSourceUnits: DirectSourceUnit[] = [];
	const candidates: { direct: DirectSourceUnit; skills: DerivedSkill[] }[] = [];
	const diagnostics: SourceDiagnostic[] = [...namespace.diagnostics];
	if (diagnostics.length > 0) {
		return { directSourceUnits: [], derivedSkills: [], diagnostics: sortSourceDiagnostics(diagnostics) };
	}
	const profileId = profileDirectory.split(sep).at(-1)!;
	for (const item of namespace.descriptors) {
		try { await validateSourceReference(bazframeHome, profileId, item.sourceId, item.identity); } catch {
			diagnostics.push(sourceDiagnostic("invalid-reference", item.sourceId, `${item.sourceId}.json`));
		}
	}
	if (diagnostics.length > 0) {
		return { directSourceUnits: [], derivedSkills: [], diagnostics: sortSourceDiagnostics(diagnostics) };
	}
	for (const item of namespace.descriptors) {
		const referenceDirect: DirectSourceUnit = {
			schemaVersion: 1,
			sourceId: item.sourceId,
			descriptorPath: item.path,
			preparationState: "failed",
			rebuildAvailability: "unavailable",
		};
		directSourceUnits.push(referenceDirect);
		let descriptor: SourceDescriptor;
		try { descriptor = await readSourceDescriptor(item.sourceId, bazframeHome); } catch {
			diagnostics.push(sourceDiagnostic("invalid-source", item.sourceId, `${item.sourceId}.json`));
			continue;
		}
		const direct: DirectSourceUnit = {
			...descriptor,
			descriptorPath: item.path,
			preparationState: "ready",
			rebuildAvailability: await sourceRebuildAvailability(descriptor.sourceRoot),
		};
		directSourceUnits[directSourceUnits.length - 1] = direct;
		try { candidates.push({ direct, skills: await resolveDirectSource(direct, bazframeHome) }); } catch (error) {
			direct.preparationState = "failed";
			if (error instanceof SourceResolutionFailure) diagnostics.push(...error.diagnostics);
			else diagnostics.push(sourceDiagnostic("io-error", item.sourceId, "."));
		}
	}
	const names = new Map<string, DerivedSkill[]>();
	for (const candidate of candidates) for (const skill of candidate.skills) {
		const group = names.get(skill.name) ?? [];
		group.push(skill);
		names.set(skill.name, group);
	}
	const flatNames = new Set(flatSkills.map((skill) => skill.name));
	const duplicateUnits = new Set<string>();
	for (const [name, skills] of [...names.entries()].sort(([left], [right]) => codeUnitCompare(left, right))) {
		if (!flatNames.has(name) && skills.length < 2) continue;
		for (const skill of skills) {
			duplicateUnits.add(skill.sourceId);
			diagnostics.push(sourceDiagnostic("duplicate-name", skill.sourceId, skill.relativePath, { name }));
		}
	}
	return {
		directSourceUnits,
		derivedSkills: candidates
			.filter(({ direct }) => !duplicateUnits.has(direct.sourceId))
			.flatMap((candidate) => candidate.skills),
		diagnostics: sortSourceDiagnostics(diagnostics),
	};
}

async function sourceRebuildAvailability(sourceRoot: string): Promise<"available" | "unavailable"> {
	try {
		const metadata = await lstat(sourceRoot);
		return !metadata.isSymbolicLink() && metadata.isDirectory() && await realpath(sourceRoot) === sourceRoot ? "available" : "unavailable";
	} catch { return "unavailable"; }
}

async function loadProfile(bazframeHome: string): Promise<ProfileState> {
	const id = await readActiveProfileId(bazframeHome);
	const profilesPath = join(bazframeHome, "profiles");
	const directory = join(profilesPath, id);
	const directories: SourceOpenDirectory[] = [];
	try {
		for (const directoryPath of [bazframeHome, profilesPath, directory]) {
			directories.push(await openExistingSourceDirectory(directoryPath));
		}
		const instructionsPath = join(directory, "AGENTS.md");
		const instructions = decodeUtf8(
			await readUserFile(instructionsPath, `Profile ${id} instructions`, MAX_INSTRUCTIONS_BYTES),
			`Profile ${id} instructions`,
		);
		const loaded = await loadProfileSkills(join(directory, "skills"));
		const names = new Set<string>();
		for (const skill of loaded.skills) {
			if (names.has(skill.name)) throw new Error(`Duplicate profile skill name: ${skill.name}`);
			names.add(skill.name);
		}
		const sources = await loadProfileSources(directory, loaded.skills);
		for (const openedDirectory of [...directories].reverse()) await assertSourceDirectoryStable(openedDirectory);
		const combined = [...loaded.skills, ...sources.derivedSkills.map((derived) => derived.skill)];
		return {
			id,
			directory,
			instructionsPath,
			instructions,
			flatSkills: loaded.skills,
			directSourceUnits: sources.directSourceUnits,
			derivedSkills: sources.derivedSkills,
			sourceDiagnostics: sources.diagnostics,
			skills: combined,
			skillDirectories: [...new Set(combined.map((skill) => skill.baseDir))].sort(),
			warnings: loaded.warnings,
		};
	} finally {
		for (const directory of [...directories].reverse()) await directory.handle.close().catch(() => undefined);
	}
}

async function loadGlobalContext(): Promise<InstructionFile | undefined> {
	const agentDirectory = getAgentDir();
	for (const name of CONTEXT_FILE_NAMES) {
		const path = join(agentDirectory, name);
		if (await pathKind(path) === "absent") continue;
		return {
			path,
			content: decodeUtf8(
				await readUserFile(path, "Global Pi context", MAX_INSTRUCTIONS_BYTES),
				"Global Pi context",
			),
		};
	}
	return undefined;
}

async function resolveState(cwd: string): Promise<AdapterState> {
	let bazframeHome: string;
	try {
		bazframeHome = resolveBazframeHome();
	} catch (error) {
		return {
			cwd,
			bazframeHome: process.env.BAZFRAME_HOME ?? "(invalid)",
			initialized: true,
			projectBehavior: "error",
			globalPolicy: "unresolved",
			skillAliases: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const base: AdapterState = {
		cwd,
		bazframeHome,
		initialized: false,
		projectBehavior: "outside-git",
		globalPolicy: "enabled",
		skillAliases: [],
	};
	let repository: string | undefined;
	try {
		repository = await findRepository(cwd);
	} catch (error) {
		return {
			...base,
			initialized: true,
			projectBehavior: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const policyPath = globalStatePath(bazframeHome);
	const projectStatePath = repository === undefined
		? undefined
		: registrationPath(bazframeHome, repository);
	let globalPolicy: GlobalPolicy = "unresolved";
	let globalPolicyPath: string | undefined;
	let projectStateResolution: ProjectStateResolution = "unresolved";
	let projectState: ProjectState | undefined;
	let projectBehavior: ProjectBehavior = "error";
	try {
		const policyKind = await pathKind(policyPath);
		if (policyKind !== "absent" && policyKind !== "file") {
			throw new Error(`Invalid global policy path: ${policyPath}`);
		}
		if (policyKind === "file") {
			globalPolicyPath = policyPath;
			await parseGlobalPolicy(policyPath);
			globalPolicy = "disabled";
		} else {
			globalPolicy = "enabled";
		}

		if (projectStatePath !== undefined && repository !== undefined) {
			const kind = await pathKind(projectStatePath);
			if (kind === "absent") {
				projectStateResolution = "absent";
			} else {
				if (kind !== "file") throw new Error(`Invalid repository project-state path: ${projectStatePath}`);
				projectState = await parseProjectState(projectStatePath, repository);
				projectStateResolution = projectState.schemaVersion === 3
					? "enabled-override"
					: projectState.schemaVersion === 2
						? "disabled-override"
						: "legacy-inherit";
			}
		}

		const enabled = projectState?.schemaVersion === 3
			|| (projectState?.schemaVersion !== 2 && globalPolicy === "enabled");
		projectBehavior = projectState?.schemaVersion === 3
			? "enabled-project"
			: projectState?.schemaVersion === 2
				? "disabled-project"
				: globalPolicy === "enabled" ? "enabled-global" : "disabled-global";
		if (!enabled) {
			return {
				...base,
				globalPolicy,
				...(globalPolicyPath === undefined ? {} : { globalPolicyPath }),
				projectBehavior,
				...(repository === undefined ? {} : { repository }),
				...(projectStatePath === undefined ? {} : { projectStatePath }),
				...(repository === undefined ? {} : { projectStateResolution }),
				...(projectState === undefined ? {} : { projectState }),
			};
		}
		const compatibilityError = compatibilityFailure();
		if (compatibilityError !== undefined) throw new Error(compatibilityError);
		return {
			...base,
			initialized: true,
			globalPolicy,
			...(globalPolicyPath === undefined ? {} : { globalPolicyPath }),
			projectBehavior,
			...(repository === undefined ? {} : { repository }),
			...(projectStatePath === undefined ? {} : { projectStatePath }),
			...(repository === undefined ? {} : { projectStateResolution }),
			...(projectState === undefined ? {} : { projectState }),
			profile: await loadProfile(bazframeHome),
			globalContext: await loadGlobalContext(),
		};
	} catch (error) {
		return {
			...base,
			initialized: true,
			projectBehavior,
			globalPolicy,
			...(globalPolicyPath === undefined ? {} : { globalPolicyPath }),
			...(repository === undefined ? {} : { repository }),
			...(projectStatePath === undefined ? {} : { projectStatePath }),
			...(repository === undefined ? {} : { projectStateResolution }),
			...(projectState === undefined ? {} : { projectState }),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function aliasSkillName(name: string): string {
	if (!SKILL_NAME.test(name)) {
		throw new Error(`Cannot alias Agent Skills-incompatible profile skill name: ${name}`);
	}
	const maximumBaseLength = 64 - SKILL_ALIAS_SUFFIX.length;
	const base = name.slice(0, maximumBaseLength).replace(/-+$/, "");
	if (base.length === 0) throw new Error(`Cannot alias profile skill name: ${name}`);
	return `${base}${SKILL_ALIAS_SUFFIX}`;
}

async function ensureCacheDirectory(managedRoot: string, directory: string): Promise<void> {
	if (!isWithin(directory, managedRoot)) throw new Error(`Alias cache path escapes its root: ${directory}`);
	await mkdir(managedRoot, { recursive: true, mode: 0o700 });
	const pathFromRoot = relative(managedRoot, directory);
	let current = managedRoot;
	for (const segment of ["", ...pathFromRoot.split(sep).filter(Boolean)]) {
		if (segment !== "") {
			current = join(current, segment);
			try {
				await mkdir(current, { mode: 0o700 });
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			}
		}
		const metadata = await lstat(current);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw new Error(`Alias cache path must be a physical directory: ${current}`);
		}
		await chmod(current, 0o700);
	}
}

async function writeAliasAtomic(path: string, contents: string, managedRoot: string): Promise<void> {
	const parent = resolve(path, "..");
	await ensureCacheDirectory(managedRoot, parent);
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink() || !metadata.isFile()) {
			throw new Error(`Alias cache destination must be a physical file: ${path}`);
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		await handle.writeFile(contents, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, path);
	} catch (error) {
		if (handle !== undefined) {
			try { await handle.close(); } catch { /* preserve the write error */ }
		}
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

async function materializeSkillAlias(
	state: AdapterState,
	skill: Skill,
	aliasName: string,
): Promise<string> {
	if (state.profile === undefined) throw new Error("Cannot alias a skill without an active profile.");
	const cacheRoot = join(state.bazframeHome, "adapter-cache", "pi", "skill-aliases");
	const aliasDirectory = join(cacheRoot, state.profile.id, aliasName);
	const aliasPath = join(aliasDirectory, "SKILL.md");
	await writeAliasAtomic(
		aliasPath,
		[
			"---",
			`name: ${aliasName}`,
			`description: ${JSON.stringify(skill.description)}`,
			...(skill.disableModelInvocation ? ["disable-model-invocation: true"] : []),
			"---",
			"",
			`# Bazframe alias for ${skill.name}`,
			"",
			`Read and follow the original skill file at ${JSON.stringify(skill.filePath)}.`,
			`Resolve its relative references against ${JSON.stringify(skill.baseDir)}.`,
			"",
		].join("\n"),
		state.bazframeHome,
	);
	return aliasPath;
}

async function prepareProfileSkillPaths(
	state: AdapterState,
	pi: ExtensionAPI,
): Promise<{ paths: string[]; aliases: SkillAlias[] }> {
	if (state.profile === undefined) return { paths: [], aliases: [] };
	const occupiedNames = new Set(
		pi.getCommands()
			.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
			.map((command) => command.name.slice("skill:".length)),
	);
	const profileNames = new Set(state.profile.skills.map((skill) => skill.name));
	const aliasNames = new Set<string>();
	const aliases: SkillAlias[] = [];
	const paths: string[] = [];
	for (const skill of state.profile.skills) {
		if (!occupiedNames.has(skill.name)) {
			paths.push(skill.filePath);
			continue;
		}
		const aliasName = aliasSkillName(skill.name);
		if (occupiedNames.has(aliasName) || profileNames.has(aliasName) || aliasNames.has(aliasName)) {
			throw new Error(`Bazframe skill alias also collides: ${skill.name} -> ${aliasName}`);
		}
		aliasNames.add(aliasName);
		const aliasPath = await materializeSkillAlias(state, skill, aliasName);
		aliases.push({ originalName: skill.name, aliasName, aliasPath });
		paths.push(aliasPath);
	}
	return { paths, aliases };
}

function contextPaths(options: BuildSystemPromptOptions): string[] {
	if (!Array.isArray(options.contextFiles)) {
		throw new Error("Supported Pi structured contextFiles data is unavailable.");
	}
	return options.contextFiles.map((file) => file.path);
}

function formatSourceFailure(diagnostic: SourceDiagnostic): string {
	const identity = `${diagnostic.sourceId}:${diagnostic.path}`;
	if (diagnostic.category === "limit-exceeded") {
		return `${identity} ${diagnostic.category} (${diagnostic.limit})`;
	}
	if (diagnostic.category === "duplicate-name") {
		return `${identity} ${diagnostic.category} (${diagnostic.name})`;
	}
	if (diagnostic.category === "pi-loader") {
		return `${identity} ${diagnostic.category}[${diagnostic.diagnosticIndex}]: ${diagnostic.message}`;
	}
	return `${identity} ${diagnostic.category}`;
}

function sourceCorrectiveActions(profile: ProfileState | undefined): string[] {
	if (profile === undefined) return ["  (none)"];
	const builds = profile.directSourceUnits
		.filter((source) => source.preparationState === "failed" && source.rebuildAvailability === "available")
		.map((source) => `  - bazframe sources build ${source.sourceId}`);
	if (builds.length > 0) return builds;
	return profile.sourceDiagnostics.length > 0 ? ["  - Inspect referenced-source failures with `bazframe profile sources`."] : ["  (none)"];
}

function info(state: AdapterState, pi: ExtensionAPI, ctx: ExtensionCommandContext): string {
	let piContext: string[] = [];
	let structuredContextAvailable = true;
	try {
		piContext = contextPaths(ctx.getSystemPromptOptions());
	} catch {
		structuredContextAvailable = false;
	}

	const active = structuredContextAvailable && state.error === undefined && state.profile !== undefined;
	const contextEntries = piContext.map((path) => `  (pi) ${path}`);
	if (active) {
		if (piContext.length === 0 && state.globalContext !== undefined) {
			contextEntries.push(`  (bazframe) ${state.globalContext.path}`);
		}
		contextEntries.push(`  (bazframe) ${state.profile!.instructionsPath}`);
	}

	const skillNames = new Set(
		pi.getCommands()
			.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
			.map((command) => command.name.slice("skill:".length)),
	);
	const skills = [...skillNames].sort();
	const collisions = active
		? state.skillAliases
			.filter((alias) => skillNames.has(alias.aliasName))
			.map((alias) => `${alias.originalName} -> ${alias.aliasName}`)
			.sort()
		: [];

	const profile = active ? state.profile : undefined;
	return [
		`Profile: ${profile?.id ?? "(none)"}`,
		...(contextEntries.length === 0 ? ["Context: (none)"] : ["Context:", ...contextEntries]),
		`Flat direct skills: ${profile?.flatSkills.length ?? 0}`,
		...(profile === undefined || profile.flatSkills.length === 0
			? ["  (none)"]
			: profile.flatSkills.map((skill) => `  - ${skill.name} (${skill.filePath})`)),
		`Profile source references: ${profile?.directSourceUnits.length ?? 0}`,
		...(profile === undefined || profile.directSourceUnits.length === 0
			? ["  (none)"]
			: profile.directSourceUnits.map((source) => source.snapshotDigest === undefined
				? `  - ${source.sourceId} (failed; target unavailable)`
				: `  - ${source.sourceId} -> ${source.sourceRoot} (${source.preparationState}; rebuild:${source.rebuildAvailability}; sha256:${source.snapshotDigest}; root:${source.sourceUnitRoot})`)),
		`Derived effective skills: ${profile?.derivedSkills.length ?? 0}`,
		...(profile === undefined || profile.derivedSkills.length === 0
			? ["  (none)"]
			: profile.derivedSkills.map((skill) =>
				`  - ${skill.name} (${skill.sourceId}:${skill.relativePath})`)),
		`Source failures: ${profile?.sourceDiagnostics.length ?? 0}`,
		...(profile === undefined || profile.sourceDiagnostics.length === 0
			? ["  (none)"]
			: profile.sourceDiagnostics.map((diagnostic) => `  - ${formatSourceFailure(diagnostic)}`)),
		"Corrective actions:",
		...sourceCorrectiveActions(profile),
		`Skills: ${skills.length === 0 ? "(none)" : skills.join(", ")}`,
		...(collisions.length === 0 ? [] : [`Aliases: ${collisions.join(", ")}`]),
	].join("\n");
}

function escapeAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function injectedInstructions(state: AdapterState, restoreGlobalContext: boolean): string {
	if (state.profile === undefined) return "";
	const sections: string[] = [];
	if (restoreGlobalContext && state.globalContext !== undefined) {
		sections.push([
			`<bazframe_global_instructions path="${escapeAttribute(state.globalContext.path)}">`,
			state.globalContext.content,
			"</bazframe_global_instructions>",
		].join("\n"));
	}
	sections.push([
		`<bazframe_profile_instructions path="${escapeAttribute(state.profile.instructionsPath)}">`,
		state.profile.instructions,
		"</bazframe_profile_instructions>",
	].join("\n"));
	return sections.join("\n\n");
}

function showFailure(ctx: ExtensionContext, message: string): void {
	const text = `Bazframe Pi adapter failed explicitly.\n${message}`;
	if (ctx.hasUI) ctx.ui.notify(text, "error");
	else console.error(text);
	process.exitCode = 1;
}

export default function bazframePiAdapter(pi: ExtensionAPI): void {
	let state: AdapterState = {
		cwd: process.cwd(),
		bazframeHome: process.env.BAZFRAME_HOME ?? join(homedir(), ".bazframe"),
		initialized: false,
		projectBehavior: "outside-git",
		globalPolicy: "enabled",
		skillAliases: [],
	};
	let contextModeNotified = false;

	pi.on("session_start", async (_event, ctx) => {
		state = await resolveState(ctx.cwd);
		contextModeNotified = false;
		if (state.error !== undefined && ctx.hasUI) {
			ctx.ui.notify(`Bazframe profile failed to load: ${state.error}`, "error");
		}
	});

	pi.on("resources_discover", async (event, ctx) => {
		state = await resolveState(event.cwd);
		if (!state.initialized || state.error !== undefined || state.profile === undefined) return;
		try {
			const prepared = await prepareProfileSkillPaths(state, pi);
			state = { ...state, skillAliases: prepared.aliases };
			if (prepared.aliases.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`Bazframe skill aliases: ${prepared.aliases.map((alias) => `${alias.originalName} -> ${alias.aliasName}`).join(", ")}`,
					"warning",
				);
			}
			for (const warning of state.profile.warnings) {
				if (ctx.hasUI) ctx.ui.notify(`Bazframe profile skill warning: ${warning}`, "warning");
			}
			for (const diagnostic of state.profile.sourceDiagnostics) {
				if (ctx.hasUI) ctx.ui.notify(
					`Bazframe source-unit failure: ${formatSourceFailure(diagnostic)}`,
					"warning",
				);
			}
			return prepared.paths.length === 0 ? undefined : { skillPaths: prepared.paths };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state = { ...state, error: message, skillAliases: [] };
			if (ctx.hasUI) ctx.ui.notify(`Bazframe skill preparation failed: ${message}`, "error");
			return;
		}
	});

	pi.on("input", (_event, ctx) => {
		if (!state.initialized || state.error === undefined) return { action: "continue" };
		showFailure(ctx, state.error);
		return { action: "handled" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!state.initialized || state.profile === undefined) return;
		if (state.error !== undefined) {
			showFailure(ctx, state.error);
			return {
				systemPrompt: `Bazframe Pi adapter failed before agent start. Do not act on the user request.\n\n${state.error}`,
			};
		}
		let restoreGlobalContext: boolean;
		try {
			restoreGlobalContext = contextPaths(event.systemPromptOptions).length === 0;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state = { ...state, error: message };
			showFailure(ctx, message);
			return {
				systemPrompt: `Bazframe Pi adapter compatibility failure. Do not act on the user request.\n\n${message}`,
			};
		}
		if (!contextModeNotified && ctx.hasUI) {
			ctx.ui.notify(
				restoreGlobalContext
					? "Bazframe: Pi supplied no native context; restored global context and appended profile instructions."
					: "Bazframe: Pi owns native global/project context; appended profile instructions only.",
				"info",
			);
			contextModeNotified = true;
		}
		return {
			systemPrompt: [event.systemPrompt, injectedInstructions(state, restoreGlobalContext)].join("\n\n"),
		};
	});

	pi.registerCommand("bazframe", {
		description: "Inspect Bazframe or reload its Pi integration",
		getArgumentCompletions: (prefix) => {
			const argument = prefix.trimStart();
			if (argument.includes(" ")) return null;
			return ["info", "reload"]
				.filter((value) => value.startsWith(argument))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			switch (args.trim()) {
				case "info":
					ctx.ui.notify(info(state, pi, ctx), state.error === undefined ? "info" : "error");
					return;
				case "reload":
					await ctx.reload();
					return;
				default:
					ctx.ui.notify("Usage: /bazframe info | /bazframe reload", "warning");
					return;
			}
		},
	});
}
