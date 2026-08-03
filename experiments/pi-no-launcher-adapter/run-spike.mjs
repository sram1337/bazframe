import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const experimentDirectory = dirname(fileURLToPath(import.meta.url));
const piExecutable = process.env.PI_BIN ?? "pi";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function write(path, content) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

function git(repository, args) {
	const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout;
}

async function createRepository(root, name) {
	const repository = join(root, name);
	await mkdir(repository, { recursive: true });
	git(repository, ["init", "--quiet"]);
	return realpath(repository);
}

async function registerRepository(bazframeHome, repository) {
	const canonicalRepository = await realpath(repository);
	const projectId = createHash("sha256").update(canonicalRepository).digest("hex");
	await write(
		join(bazframeHome, "projects", `${projectId}.json`),
		`${JSON.stringify({ repository: canonicalRepository, mode: "adaptive-context", profile: "active" }, null, 2)}\n`,
	);
}

async function createProfile(bazframeHome, id, instructionMarker, skillName) {
	const profile = join(bazframeHome, "profiles", id);
	await write(join(profile, "instructions.md"), `${instructionMarker}\n`);
	await write(
		join(profile, "skills", skillName, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: Probe skill for ${id}.\n---\n\n# ${skillName}\n`,
	);
}

async function snapshot(root) {
	const records = [];
	async function visit(directory, prefix = "") {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name === ".git") continue;
			const path = join(directory, entry.name);
			const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				records.push(`d ${relativePath}`);
				await visit(path, relativePath);
			} else {
				const metadata = await stat(path);
				const bytes = await readFile(path);
				const hash = createHash("sha256").update(bytes).digest("hex");
				records.push(`f ${relativePath} ${metadata.mode.toString(8)} ${hash}`);
			}
		}
	}
	await visit(root);
	return records.join("\n");
}

class RpcClient {
	constructor(cwd, environment, extraArgs = []) {
		this.events = [];
		this.stderr = "";
		this.pending = new Map();
		this.waiters = [];
		this.nextId = 1;
		this.child = spawn(
			piExecutable,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--offline",
				"--provider",
				"bazframe-probe",
				"--model",
				"probe",
				"--thinking",
				"off",
				...extraArgs,
			],
			{ cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] },
		);
		this.exitPromise = new Promise((resolveExit) => {
			this.child.on("exit", (code, signal) => resolveExit({ code, signal }));
		});
		this.child.on("error", (error) => this.fail(error));
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		this.attachJsonl(this.child.stdout);
	}

	attachJsonl(stream) {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		stream.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.length > 0) this.receive(JSON.parse(line));
			}
		});
		stream.on("end", () => {
			buffer += decoder.end();
			if (buffer.length > 0) this.receive(JSON.parse(buffer));
		});
	}

	receive(event) {
		this.events.push(event);
		if (event.type === "response" && event.id !== undefined) {
			const pending = this.pending.get(event.id);
			if (pending !== undefined) {
				this.pending.delete(event.id);
				pending.resolve(event);
			}
		}
		for (const waiter of [...this.waiters]) {
			if (waiter.predicate(event)) {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				waiter.resolve(event);
			}
		}
	}

	fail(error) {
		for (const pending of this.pending.values()) pending.reject(error);
		for (const waiter of this.waiters) waiter.reject(error);
		this.pending.clear();
		this.waiters = [];
	}

	request(command) {
		const id = `spike-${this.nextId++}`;
		const request = { id, ...command };
		return new Promise((resolveRequest, rejectRequest) => {
			this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
			this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
				if (error) {
					this.pending.delete(id);
					rejectRequest(error);
				}
			});
		});
	}

	waitFor(predicate, startIndex = 0) {
		const existing = this.events.slice(startIndex).find(predicate);
		if (existing !== undefined) return Promise.resolve(existing);
		return new Promise((resolveEvent, rejectEvent) => {
			this.waiters.push({ predicate, resolve: resolveEvent, reject: rejectEvent });
		});
	}

	async prompt(message) {
		const startIndex = this.events.length;
		const response = await this.request({ type: "prompt", message });
		assert(response.success === true, `RPC prompt failed: ${JSON.stringify(response)}`);
		await this.waitFor((event) => event.type === "agent_settled", startIndex);
	}

	async explain() {
		const startIndex = this.events.length;
		const response = await this.request({ type: "prompt", message: "/bzf-explain" });
		assert(response.success === true, `bzf-explain failed: ${JSON.stringify(response)}`);
		const notification = await this.waitFor(
			(event) => event.type === "extension_ui_request"
				&& event.method === "notify"
				&& event.message.startsWith("Bazframe Pi adapter"),
			startIndex,
		);
		return notification.message;
	}

	async commands() {
		const response = await this.request({ type: "get_commands" });
		assert(response.success === true, `get_commands failed: ${JSON.stringify(response)}`);
		return response.data.commands;
	}

	async reload() {
		const response = await this.request({ type: "prompt", message: "/bzf-reload" });
		assert(response.success === true, `bzf-reload failed: ${JSON.stringify(response)}`);
	}

	async close() {
		this.child.stdin.end();
		const timeout = setTimeout(() => this.child.kill("SIGTERM"), 5000);
		const result = await this.exitPromise;
		clearTimeout(timeout);
		return result;
	}
}

function commandNames(commands) {
	return commands.map((command) => command.name);
}

async function readCaptures(path) {
	try {
		return (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

async function main() {
	const root = await mkdtemp(join(tmpdir(), "bazframe-pi-adapter-spike-"));
	const bazframeHome = join(root, "bazframe-home");
	const agentDirectory = join(root, "pi-agent");
	const capturePath = join(root, "probe-captures.jsonl");
	await mkdir(join(agentDirectory, "extensions"), { recursive: true });
	await copyFile(join(experimentDirectory, "bazframe.ts"), join(agentDirectory, "extensions", "00-bazframe.ts"));
	await copyFile(join(experimentDirectory, "probe-provider.ts"), join(agentDirectory, "extensions", "99-probe-provider.ts"));
	await write(join(agentDirectory, "settings.json"), `${JSON.stringify({ quietStartup: true, enableInstallTelemetry: false })}\n`);
	await write(join(agentDirectory, "AGENTS.md"), "GLOBAL_PI_CONTEXT_RESTORED\n");
	await write(join(root, "AGENTS.md"), "ANCESTOR_CONTEXT_MUST_NOT_LOAD\n");
	await createProfile(bazframeHome, "focused", "FOCUSED_PROFILE_INSTRUCTION", "focused-probe");
	await createProfile(bazframeHome, "reviewer", "REVIEWER_PROFILE_INSTRUCTION", "reviewer-probe");
	await write(join(bazframeHome, "active-profile"), "focused\n");

	const environment = {
		...process.env,
		BAZFRAME_HOME: bazframeHome,
		BAZFRAME_PI_PROBE_CAPTURE: capturePath,
		PI_CODING_AGENT_DIR: agentDirectory,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	};

	const registeredRepository = await createRepository(root, "registered-repository");
	const registeredCwd = join(registeredRepository, "packages", "api");
	await mkdir(registeredCwd, { recursive: true });
	await write(join(registeredRepository, "AGENTS.md"), "REPOSITORY_ROOT_CONTEXT_MUST_NOT_LOAD\n");
	await write(join(registeredCwd, "CLAUDE.md"), "REPOSITORY_NESTED_CONTEXT_MUST_NOT_LOAD\n");
	await write(
		join(registeredCwd, ".pi", "extensions", "repository-probe.ts"),
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nexport default function (pi: ExtensionAPI) {\n\tpi.registerCommand("repository-extension-probe", { description: "Native project extension probe", handler: () => {} });\n}\n`,
	);
	await write(join(registeredCwd, ".pi", "prompts", "repository-prompt.md"), "Repository prompt\n");
	await write(
		join(registeredCwd, ".pi", "skills", "repository-native", "SKILL.md"),
		"---\nname: repository-native\ndescription: Native project skill intentionally remains active.\n---\n",
	);
	await write(
		join(registeredCwd, ".pi", "skills", "reviewer-collision", "SKILL.md"),
		"---\nname: reviewer-probe\ndescription: Native skill intentionally colliding with the reviewer profile.\n---\n",
	);
	await registerRepository(bazframeHome, registeredRepository);
	const registeredBefore = await snapshot(registeredRepository);
	const registeredStatusBefore = git(registeredRepository, ["status", "--short"]);
	const registeredClient = new RpcClient(registeredCwd, environment, ["-nc", "--approve"]);
	await registeredClient.prompt("first profile probe");
	const focusedCommands = commandNames(await registeredClient.commands());
	const focusedExplain = await registeredClient.explain();
	await write(join(bazframeHome, "active-profile"), "reviewer\n");
	await registeredClient.reload();
	await registeredClient.prompt("second profile probe");
	const reviewerCommands = commandNames(await registeredClient.commands());
	const reviewerExplain = await registeredClient.explain();
	const registeredExit = await registeredClient.close();
	const registeredAfter = await snapshot(registeredRepository);
	const registeredStatusAfter = git(registeredRepository, ["status", "--short"]);
	const registeredCaptures = await readCaptures(capturePath);

	assert(registeredExit.code === 0, `registered repository Pi exited ${JSON.stringify(registeredExit)}: ${registeredClient.stderr}`);
	assert(registeredCaptures.length === 2, `expected two registered captures, got ${registeredCaptures.length}`);
	assert(registeredCaptures[0].systemPrompt.includes("GLOBAL_PI_CONTEXT_RESTORED"), "global context was not restored");
	assert(registeredCaptures[0].systemPrompt.match(/GLOBAL_PI_CONTEXT_RESTORED/g)?.length === 1, "global context was restored more than once");
	assert(registeredCaptures[0].systemPrompt.includes("FOCUSED_PROFILE_INSTRUCTION"), "focused instructions were not sent");
	assert(registeredCaptures[0].systemPrompt.includes("focused-probe"), "focused skill was not sent");
	assert(registeredCaptures[0].systemPrompt.includes("repository-native"), "native project skill was not retained");
	assert(!registeredCaptures[0].systemPrompt.includes("REVIEWER_PROFILE_INSTRUCTION"), "reviewer instructions leaked before reload");
	for (const capture of registeredCaptures) {
		assert(!capture.systemPrompt.includes("REPOSITORY_ROOT_CONTEXT_MUST_NOT_LOAD"), "repository root context reached the provider");
		assert(!capture.systemPrompt.includes("REPOSITORY_NESTED_CONTEXT_MUST_NOT_LOAD"), "nested repository context reached the provider");
		assert(!capture.systemPrompt.includes("ANCESTOR_CONTEXT_MUST_NOT_LOAD"), "ancestor context reached the provider");
	}
	assert(registeredCaptures[1].systemPrompt.includes("GLOBAL_PI_CONTEXT_RESTORED"), "global context was not restored after reload");
	assert(registeredCaptures[1].systemPrompt.includes("REVIEWER_PROFILE_INSTRUCTION"), "reviewer instructions were not sent after reload");
	assert(registeredCaptures[1].systemPrompt.includes("reviewer-probe-x-bazframe"), "aliased reviewer skill was not sent after reload");
	assert(!registeredCaptures[1].systemPrompt.includes("FOCUSED_PROFILE_INSTRUCTION"), "focused instructions remained after reload");
	assert(focusedCommands.includes("skill:focused-probe"), "focused skill command was not loaded");
	assert(focusedCommands.includes("skill:reviewer-probe"), "native colliding skill was not loaded");
	assert(!focusedCommands.includes("skill:reviewer-probe-x-bazframe"), "reviewer alias loaded before profile switch");
	assert(reviewerCommands.includes("skill:reviewer-probe"), "native colliding skill disappeared after reload");
	assert(reviewerCommands.includes("skill:reviewer-probe-x-bazframe"), "reviewer profile collision was not aliased");
	assert(!reviewerCommands.includes("skill:focused-probe"), "focused skill command remained after reload");
	for (const commands of [focusedCommands, reviewerCommands]) {
		assert(commands.includes("skill:repository-native"), "native project skill command was not retained");
		assert(commands.includes("repository-prompt"), "native project prompt was not retained");
		assert(commands.includes("repository-extension-probe"), "native project extension was not retained");
	}
	assert(focusedExplain.includes("Status: active (instruction-context replacement)") && focusedExplain.includes("Profile: focused"), "focused explain was incomplete");
	assert(reviewerExplain.includes("Status: active (instruction-context replacement)") && reviewerExplain.includes("Profile: reviewer"), "reviewer explain was incomplete");
	assert(reviewerExplain.includes("reviewer-probe -> reviewer-probe-x-bazframe"), "reviewer explain omitted the skill alias");
	assert(registeredClient.events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message.includes("reviewer-probe -> reviewer-probe-x-bazframe")), "reviewer skill alias was not logged");
	assert(registeredClient.events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message.includes("Pi supplied no native context")), "replacement context mode was not logged");
	assert(focusedExplain.includes("Native context files loaded by Pi:\n  (none)"), "-nc was not reflected in diagnostics");
	assert(focusedExplain.includes("Global context handling: restored by adapter"), "-nc mode did not report global restoration");
	assert(registeredBefore === registeredAfter && registeredStatusBefore === registeredStatusAfter, "registered repository changed");

	const additiveClient = new RpcClient(registeredCwd, environment, ["--approve"]);
	const additiveExplain = await additiveClient.explain();
	await additiveClient.prompt("additive context probe");
	const additiveExit = await additiveClient.close();
	const capturesAfterAdditive = await readCaptures(capturePath);
	const additiveCapture = capturesAfterAdditive.at(-1);
	assert(additiveExit.code === 0, `additive registered Pi exited ${JSON.stringify(additiveExit)}: ${additiveClient.stderr}`);
	assert(capturesAfterAdditive.length === 3, `expected three captures after additive run, got ${capturesAfterAdditive.length}`);
	assert(additiveExplain.includes("Status: active (additive context)"), "additive diagnostics did not report their mode");
	assert(additiveExplain.includes("Global context handling: left to Pi"), "additive diagnostics did not leave global context to Pi");
	assert(additiveExplain.includes("AGENTS.md") && additiveExplain.includes("CLAUDE.md"), "additive diagnostics did not list native context");
	assert(additiveClient.events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message.includes("Pi owns native global/project context")), "additive context mode was not logged");
	assert(additiveCapture.systemPrompt.match(/GLOBAL_PI_CONTEXT_RESTORED/g)?.length === 1, "additive mode duplicated global context");
	assert(additiveCapture.systemPrompt.includes("ANCESTOR_CONTEXT_MUST_NOT_LOAD"), "additive mode omitted ancestor context");
	assert(additiveCapture.systemPrompt.includes("REPOSITORY_ROOT_CONTEXT_MUST_NOT_LOAD"), "additive mode omitted repository root context");
	assert(additiveCapture.systemPrompt.includes("REPOSITORY_NESTED_CONTEXT_MUST_NOT_LOAD"), "additive mode omitted nested repository context");
	assert(additiveCapture.systemPrompt.includes("REVIEWER_PROFILE_INSTRUCTION"), "additive mode omitted profile instructions");
	assert(additiveCapture.systemPrompt.includes("reviewer-probe-x-bazframe"), "additive mode omitted the aliased profile skill");
	assert(additiveCapture.systemPrompt.includes("repository-native"), "additive mode omitted native project skills");
	assert(registeredBefore === await snapshot(registeredRepository), "additive run changed the registered repository");
	assert(registeredStatusBefore === git(registeredRepository, ["status", "--short"]), "additive run changed Git status");

	const nativeRepository = await createRepository(root, "unregistered-repository");
	await write(join(nativeRepository, "AGENTS.md"), "UNREGISTERED_NATIVE_CONTEXT\n");
	await write(join(nativeRepository, ".pi", "prompts", "native-prompt.md"), "Native prompt\n");
	await write(
		join(nativeRepository, ".pi", "skills", "native-skill", "SKILL.md"),
		"---\nname: native-skill\ndescription: Native unregistered project skill.\n---\n",
	);
	const nativeBefore = await snapshot(nativeRepository);
	const nativeStatusBefore = git(nativeRepository, ["status", "--short"]);
	const nativeClient = new RpcClient(nativeRepository, environment, ["--approve"]);
	const nativeCommands = commandNames(await nativeClient.commands());
	const nativeExplain = await nativeClient.explain();
	await nativeClient.prompt("native behavior probe");
	const nativeExit = await nativeClient.close();
	const nativeAfter = await snapshot(nativeRepository);
	const nativeStatusAfter = git(nativeRepository, ["status", "--short"]);
	const finalCaptures = await readCaptures(capturePath);
	const nativeCapture = finalCaptures.at(-1);

	assert(nativeExit.code === 0, `unregistered repository Pi exited ${JSON.stringify(nativeExit)}: ${nativeClient.stderr}`);
	assert(finalCaptures.length === 4, `expected four final captures, got ${finalCaptures.length}`);
	assert(nativeCommands.includes("skill:native-skill"), "unregistered project skill did not retain native behavior");
	assert(nativeCommands.includes("native-prompt"), "unregistered project prompt did not retain native behavior");
	assert(nativeExplain.includes("Status: inactive"), "unregistered repository was not reported inactive");
	assert(nativeCapture.systemPrompt.includes("GLOBAL_PI_CONTEXT_RESTORED"), "global context did not retain native behavior");
	assert(nativeCapture.systemPrompt.includes("UNREGISTERED_NATIVE_CONTEXT"), "unregistered AGENTS.md did not retain native behavior");
	assert(nativeCapture.systemPrompt.includes("native-skill"), "unregistered skill was absent from native prompt");
	assert(!nativeCapture.systemPrompt.includes("REVIEWER_PROFILE_INSTRUCTION"), "Bazframe profile leaked into unregistered repository");
	assert(nativeBefore === nativeAfter && nativeStatusBefore === nativeStatusAfter, "unregistered repository changed");

	const result = {
		piExecutable,
		piVersion: spawnSync(piExecutable, ["--version"], { encoding: "utf8" }).stdout.trim(),
		registeredInvocations: ["pi -nc", "pi"],
		registeredRepository: {
			replacementModeRestoredGlobalContext: true,
			replacementModeExcludedRepositoryAndAncestorContext: true,
			additiveModeRetainedNativeContextWithoutDuplicatingGlobalContext: true,
			profileSwitchObserved: true,
			profileSkillsObserved: ["focused-probe", "reviewer-probe-x-bazframe"],
			collidingSkillAliasObserved: "reviewer-probe -> reviewer-probe-x-bazframe",
			nativeProjectResourcesRetained: true,
			repositoryUnchanged: true,
		},
		unregisteredRepository: {
			nativeContextSkillAndPromptObserved: true,
			repositoryUnchanged: true,
		},
		decision: "supported adaptively: pi adds the profile alongside native context, while pi -nc restores global context plus the profile",
	};
	console.log(JSON.stringify(result, null, 2));
	if (process.env.BAZFRAME_KEEP_SPIKE === "1") console.error(`Spike fixtures retained at ${root}`);
	else await rm(root, { recursive: true, force: true });
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
});
