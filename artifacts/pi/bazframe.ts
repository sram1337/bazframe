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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

interface Registration {
	schemaVersion: 1;
	repository: string;
	mode: "adaptive-context";
	profile: "active";
}

interface InstructionFile {
	path: string;
	content: string;
}

interface ProfileState {
	id: string;
	directory: string;
	instructionsPath: string;
	instructions: string;
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
	repository?: string;
	registrationPath?: string;
	registration?: Registration;
	profile?: ProfileState;
	globalContext?: InstructionFile;
	skillAliases: SkillAlias[];
	error?: string;
}

interface GitResult {
	stdout: Uint8Array;
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
	const environment = { ...process.env };
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
			(error, stdout) => {
				resolveResult({
					stdout: Uint8Array.from(stdout),
					...(error === null ? {} : { error }),
				});
			},
		);
	});
}

async function findRepository(cwd: string): Promise<string | undefined> {
	let canonicalCwd: string;
	try {
		canonicalCwd = await realpath(cwd);
	} catch {
		return undefined;
	}
	const result = await runGit(canonicalCwd);
	if (result.error !== undefined) return undefined;
	const output = decodeUtf8(result.stdout, "Git worktree root").replace(/\r?\n$/, "");
	if (output.length === 0 || output.includes("\0") || !isAbsolute(output)) {
		throw new Error(`Git returned an invalid worktree root: ${JSON.stringify(output)}`);
	}
	const repository = await realpath(output);
	if (!isWithin(canonicalCwd, repository)) {
		throw new Error(`Git worktree root does not contain the working directory: ${repository}`);
	}
	return repository;
}

function registrationPath(bazframeHome: string, repository: string): string {
	const projectId = createHash("sha256").update(repository).digest("hex");
	return join(bazframeHome, "projects", `${projectId}.json`);
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

async function parseRegistration(path: string, repository: string): Promise<Registration> {
	let value: unknown;
	try {
		value = JSON.parse(decodeUtf8(
			await readManagedFile(path, "Repository registration", MAX_REGISTRATION_BYTES),
			"Repository registration",
		));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in repository registration: ${path}`, { cause: error });
		}
		throw error;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid Bazframe repository registration: ${path}`);
	}
	const candidate = value as Partial<Registration>;
	if (
		candidate.schemaVersion !== 1
		|| candidate.repository !== repository
		|| candidate.mode !== "adaptive-context"
		|| candidate.profile !== "active"
	) {
		throw new Error(`Unsupported Bazframe repository registration: ${path}`);
	}
	return {
		schemaVersion: 1,
		repository,
		mode: "adaptive-context",
		profile: "active",
	};
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

async function loadProfile(bazframeHome: string): Promise<ProfileState> {
	const id = await readActiveProfileId(bazframeHome);
	const directory = join(bazframeHome, "profiles", id);
	const metadata = await stat(directory);
	if (!metadata.isDirectory()) throw new Error(`Profile is not a directory: ${directory}`);
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
	return {
		id,
		directory,
		instructionsPath,
		instructions,
		skills: loaded.skills,
		skillDirectories: [...new Set(loaded.skills.map((skill) => skill.baseDir))].sort(),
		warnings: loaded.warnings,
	};
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
			skillAliases: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const base: AdapterState = { cwd, bazframeHome, initialized: false, skillAliases: [] };
	let repository: string | undefined;
	try {
		repository = await findRepository(cwd);
	} catch (error) {
		return { ...base, initialized: true, error: error instanceof Error ? error.message : String(error) };
	}
	if (repository === undefined) return base;
	const projectRegistrationPath = registrationPath(bazframeHome, repository);
	let kind: Awaited<ReturnType<typeof pathKind>>;
	try {
		kind = await pathKind(projectRegistrationPath);
	} catch (error) {
		return {
			...base,
			initialized: true,
			repository,
			registrationPath: projectRegistrationPath,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (kind === "absent") return { ...base, repository };
	try {
		if (kind !== "file") throw new Error(`Invalid repository registration path: ${projectRegistrationPath}`);
		const compatibilityError = compatibilityFailure();
		if (compatibilityError !== undefined) throw new Error(compatibilityError);
		const registration = await parseRegistration(projectRegistrationPath, repository);
		return {
			...base,
			initialized: true,
			repository,
			registrationPath: projectRegistrationPath,
			registration,
			profile: await loadProfile(bazframeHome),
			globalContext: await loadGlobalContext(),
		};
	} catch (error) {
		return {
			...base,
			initialized: true,
			repository,
			registrationPath: projectRegistrationPath,
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

function formatList(paths: readonly string[]): string[] {
	return paths.length === 0 ? ["  (none)"] : paths.map((path) => `  - ${path}`);
}

function explain(state: AdapterState, ctx: ExtensionCommandContext): string {
	if (!state.initialized) {
		return [
			"Bazframe Pi adapter",
			"Status: inactive (repository is not registered)",
			`Working directory: ${state.cwd}`,
		].join("\n");
	}
	let loadedContext: string[] = [];
	let contextError: string | undefined;
	try {
		loadedContext = contextPaths(ctx.getSystemPromptOptions());
	} catch (error) {
		contextError = error instanceof Error ? error.message : String(error);
	}
	const restoresGlobalContext = loadedContext.length === 0;
	const reason = state.error ?? contextError;
	const activeMode = restoresGlobalContext ? "instruction-context replacement" : "additive context";
	return [
		"Bazframe Pi adapter",
		`Status: ${reason === undefined ? `active (${activeMode})` : "error"}`,
		`Repository: ${state.repository ?? "(none)"}`,
		`Registration: ${state.registrationPath ?? "(none)"}`,
		`Profile: ${state.profile?.id ?? "(unresolved)"}`,
		`Profile instructions: ${state.profile?.instructionsPath ?? "(unresolved)"}`,
		`Global context handling: ${restoresGlobalContext ? `restored by adapter from ${state.globalContext?.path ?? "(none)"}` : "left to Pi"}`,
		"Profile skills:",
		...formatList(state.profile?.skillDirectories ?? []),
		"Skill collision aliases:",
		...formatList(state.skillAliases.map((alias) => `${alias.originalName} -> ${alias.aliasName} (${alias.aliasPath})`)),
		"Native context files loaded by Pi:",
		...formatList(loadedContext),
		"Pi-owned resources: settings, trust, tools, models, packages, extensions, prompts, themes, system prompts, and native skills.",
		...(state.profile?.warnings.length ? ["Profile skill warnings:", ...formatList(state.profile.warnings)] : []),
		...(reason === undefined ? [] : ["Failure:", reason]),
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

	pi.registerCommand("bzf-explain", {
		description: "Explain the active Bazframe context and profile resources",
		handler: (_args, ctx) => {
			const report = explain(state, ctx);
			ctx.ui.notify(report, report.includes("Status: error") ? "error" : "info");
		},
	});

	pi.registerCommand("bzf-reload", {
		description: "Reload Pi and re-resolve the active Bazframe profile",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});
}
