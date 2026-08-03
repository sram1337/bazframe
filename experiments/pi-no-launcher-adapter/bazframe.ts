import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	getAgentDir,
	loadSkillsFromDir,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";

const MAX_INSTRUCTIONS_BYTES = 1024 * 1024;
const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_ALIAS_SUFFIX = "-x-bazframe";
const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

interface Registration {
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

function canonicalPath(path: string): string {
	return realpathSync(resolve(path));
}

function isWithin(path: string, root: string): boolean {
	const pathFromRoot = relative(root, path);
	return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function resolveBazframeHome(): string {
	const configured = process.env.BAZFRAME_HOME;
	if (configured === undefined) return join(homedir(), ".bazframe");
	if (!isAbsolute(configured) || configured.includes("\0")) {
		throw new Error("BAZFRAME_HOME must be an absolute path without NUL bytes.");
	}
	return resolve(configured);
}

function findRepository(cwd: string): string | undefined {
	try {
		const output = execFileSync(
			"git",
			["-C", cwd, "rev-parse", "--show-toplevel"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				env: {
					...process.env,
					GIT_DIR: undefined,
					GIT_WORK_TREE: undefined,
					GIT_COMMON_DIR: undefined,
					GIT_INDEX_FILE: undefined,
				},
			},
		).trim();
		return output.length === 0 ? undefined : canonicalPath(output);
	} catch {
		return undefined;
	}
}

function registrationPath(bazframeHome: string, repository: string): string {
	const projectId = createHash("sha256").update(repository).digest("hex");
	return join(bazframeHome, "projects", `${projectId}.json`);
}

function parseRegistration(path: string, repository: string): Registration {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid Bazframe project registration: ${path}`);
	}
	const candidate = value as Partial<Registration>;
	if (candidate.mode !== "adaptive-context" || candidate.profile !== "active") {
		throw new Error(`Unsupported Bazframe project registration at ${path}; expected adaptive-context/active.`);
	}
	if (typeof candidate.repository !== "string" || canonicalPath(candidate.repository) !== repository) {
		throw new Error(`Bazframe project registration does not match repository ${repository}: ${path}`);
	}
	return {
		repository: candidate.repository,
		mode: candidate.mode,
		profile: candidate.profile,
	};
}

function readInstructions(path: string): string {
	const metadata = statSync(path);
	if (!metadata.isFile()) throw new Error(`Instruction source is not a regular file: ${path}`);
	if (metadata.size > MAX_INSTRUCTIONS_BYTES) {
		throw new Error(`Instruction source exceeds ${MAX_INSTRUCTIONS_BYTES} bytes: ${path}`);
	}
	const bytes = readFileSync(path);
	if (bytes.includes(0)) throw new Error(`Instruction source contains a NUL byte: ${path}`);
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function loadGlobalContext(): InstructionFile | undefined {
	const agentDirectory = getAgentDir();
	for (const name of CONTEXT_FILE_NAMES) {
		const path = join(agentDirectory, name);
		if (!existsSync(path)) continue;
		return { path, content: readInstructions(path) };
	}
	return undefined;
}

function loadProfile(bazframeHome: string): ProfileState {
	const activePath = join(bazframeHome, "active-profile");
	const id = readFileSync(activePath, "utf8").trim();
	if (!PROFILE_ID.test(id) || id.length > 64) {
		throw new Error(`Invalid active profile ID in ${activePath}`);
	}
	const directory = canonicalPath(join(bazframeHome, "profiles", id));
	const expectedProfilesRoot = canonicalPath(join(bazframeHome, "profiles"));
	if (!isWithin(directory, expectedProfilesRoot)) {
		throw new Error(`Active profile resolves outside the profile store: ${directory}`);
	}
	const instructionsPath = join(directory, "instructions.md");
	const instructions = readInstructions(instructionsPath);
	const skillsRoot = join(directory, "skills");
	let skills: Skill[] = [];
	if (existsSync(skillsRoot)) {
		if (!statSync(skillsRoot).isDirectory()) {
			throw new Error(`Profile skills path is not a directory: ${skillsRoot}`);
		}
		skills = loadSkillsFromDir({ dir: skillsRoot, source: "bazframe-profile" }).skills;
	}
	const skillDirectories = [...new Set(skills.map((skill) => skill.baseDir))].sort();
	return { id, directory, instructionsPath, instructions, skills, skillDirectories };
}

function resolveState(cwd: string): AdapterState {
	const bazframeHome = resolveBazframeHome();
	const repository = findRepository(cwd);
	const base: AdapterState = { cwd, bazframeHome, initialized: false, repository, skillAliases: [] };
	if (repository === undefined) return base;
	const projectRegistrationPath = registrationPath(bazframeHome, repository);
	if (!existsSync(projectRegistrationPath)) return base;
	try {
		const registration = parseRegistration(projectRegistrationPath, repository);
		return {
			...base,
			initialized: true,
			registrationPath: projectRegistrationPath,
			registration,
			profile: loadProfile(bazframeHome),
			globalContext: loadGlobalContext(),
		};
	} catch (error) {
		return {
			...base,
			initialized: true,
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

function materializeSkillAlias(state: AdapterState, skill: Skill, aliasName: string): string {
	if (state.profile === undefined) throw new Error("Cannot alias a skill without an active profile.");
	const aliasDirectory = join(
		state.bazframeHome,
		"adapter-cache",
		"pi",
		"skill-aliases",
		state.profile.id,
		aliasName,
	);
	const aliasPath = join(aliasDirectory, "SKILL.md");
	mkdirSync(aliasDirectory, { recursive: true });
	writeFileSync(
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
			`This \`${aliasName}\` skill aliases \`${skill.name}\` because a native Pi skill already uses that name.`,
			`Read and follow the original skill file at ${JSON.stringify(skill.filePath)}.`,
			`Resolve its relative references against ${JSON.stringify(skill.baseDir)}.`,
			"",
		].join("\n"),
		"utf8",
	);
	return aliasPath;
}

function prepareProfileSkillPaths(state: AdapterState, pi: ExtensionAPI): { paths: string[]; aliases: SkillAlias[] } {
	if (state.profile === undefined) return { paths: [], aliases: [] };
	const occupiedNames = new Set(
		pi.getCommands()
			.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
			.map((command) => command.name.slice("skill:".length)),
	);
	const profileNames = new Set<string>();
	for (const skill of state.profile.skills) {
		if (profileNames.has(skill.name)) throw new Error(`Duplicate profile skill name: ${skill.name}`);
		profileNames.add(skill.name);
	}
	const aliasNames = new Set<string>();
	const aliases: SkillAlias[] = [];
	const paths = state.profile.skills.map((skill) => {
		if (!occupiedNames.has(skill.name)) return skill.filePath;
		const aliasName = aliasSkillName(skill.name);
		if (occupiedNames.has(aliasName) || profileNames.has(aliasName) || aliasNames.has(aliasName)) {
			throw new Error(`Bazframe skill alias also collides: ${skill.name} -> ${aliasName}`);
		}
		aliasNames.add(aliasName);
		const aliasPath = materializeSkillAlias(state, skill, aliasName);
		aliases.push({ originalName: skill.name, aliasName, aliasPath });
		return aliasPath;
	});
	return { paths, aliases };
}

function contextPaths(options: BuildSystemPromptOptions): string[] {
	return (options.contextFiles ?? []).map((file) => file.path);
}

function failureReason(state: AdapterState): string | undefined {
	return state.error;
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
	const options = ctx.getSystemPromptOptions();
	const loadedContext = contextPaths(options);
	const restoresGlobalContext = loadedContext.length === 0;
	const reason = failureReason(state);
	const activeMode = restoresGlobalContext ? "instruction-context replacement" : "additive context";
	return [
		"Bazframe Pi adapter",
		`Status: ${reason === undefined ? `active (${activeMode})` : "error"}`,
		`Repository: ${state.repository ?? "(none)"}`,
		`Registration: ${state.registrationPath ?? "(none)"}`,
		`Profile: ${state.profile?.id ?? "(unresolved)"}`,
		`Profile instructions: ${state.profile?.instructionsPath ?? "(unresolved)"}`,
		`Global context handling: ${restoresGlobalContext ? `restored by adapter from ${state.globalContext?.path ?? "(none)"}` : "left to Pi"}`,
		"Profile skills (additive):",
		...formatList(state.profile?.skillDirectories ?? []),
		"Skill collision aliases:",
		...formatList(state.skillAliases.map((alias) => `${alias.originalName} -> ${alias.aliasName} (${alias.aliasPath})`)),
		"Native context files loaded by Pi:",
		...formatList(loadedContext),
		"Project settings, extensions, prompts, themes, and native skills remain Pi-owned.",
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
	let state = resolveState(process.cwd());
	let contextModeNotified = false;

	pi.on("session_start", (_event, ctx) => {
		state = resolveState(ctx.cwd);
		contextModeNotified = false;
	});

	pi.on("resources_discover", (event, ctx) => {
		state = resolveState(event.cwd);
		if (!state.initialized || state.error !== undefined || state.profile === undefined) return;
		try {
			const prepared = prepareProfileSkillPaths(state, pi);
			state = { ...state, skillAliases: prepared.aliases };
			if (prepared.aliases.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`Bazframe skill aliases: ${prepared.aliases.map((alias) => `${alias.originalName} -> ${alias.aliasName}`).join(", ")}`,
					"warning",
				);
			}
			if (prepared.paths.length === 0) return;
			return { skillPaths: prepared.paths };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state = { ...state, error: message, skillAliases: [] };
			if (ctx.hasUI) ctx.ui.notify(`Bazframe skill preparation failed: ${message}`, "error");
			return;
		}
	});

	pi.on("input", (_event, ctx) => {
		if (!state.initialized) return { action: "continue" };
		const reason = failureReason(state);
		if (reason === undefined) return { action: "continue" };
		showFailure(ctx, reason);
		return { action: "handled" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!state.initialized || state.profile === undefined) return;
		const reason = failureReason(state);
		if (reason !== undefined) {
			showFailure(ctx, reason);
			return {
				systemPrompt: `Bazframe Pi adapter failed before agent start. Do not act on the user request.\n\n${reason}`,
			};
		}
		const restoreGlobalContext = contextPaths(event.systemPromptOptions).length === 0;
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
		description: "Explain the active Bazframe instruction-context adapter state",
		handler: (_args, ctx) => {
			const report = explain(state, ctx);
			ctx.ui.notify(report, report.includes("Status: error") ? "error" : "info");
		},
	});

	pi.registerCommand("bzf-reload", {
		description: "Reload Pi and re-resolve the active Bazframe profile",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
}
