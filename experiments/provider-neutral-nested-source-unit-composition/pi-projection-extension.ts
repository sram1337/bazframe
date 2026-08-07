import { appendFileSync, readFileSync } from "node:fs";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	loadSkillsFromDir,
	VERSION as PI_VERSION,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

interface EffectiveSkill {
	declaredName: string;
	skillRoot: string;
	definitionPath: string;
}

interface ProbeConfig {
	capturePath: string;
	scenario: string;
	sourceRoot: string;
	effectiveSkills: EffectiveSkill[];
}

function config(): ProbeConfig {
	const path = process.env.BAZFRAME_SOURCE_UNIT_PROBE_CONFIG;
	if (path === undefined) throw new Error("BAZFRAME_SOURCE_UNIT_PROBE_CONFIG is required.");
	return JSON.parse(readFileSync(path, "utf8")) as ProbeConfig;
}

function capture(value: object): void {
	appendFileSync(config().capturePath, `${JSON.stringify(value)}\n`);
}

function streamProbe(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	queueMicrotask(() => {
		try {
			const probeConfig = config();
			capture({
				type: "provider",
				scenario: probeConfig.scenario,
				cwd: process.cwd(),
				definitionPathsInPrompt: probeConfig.effectiveSkills.map((skill) => ({
					definitionPath: skill.definitionPath,
					present: context.systemPrompt.includes(skill.definitionPath),
				})),
			});
			stream.push({ type: "start", partial: output });
			const block = { type: "text" as const, text: "probe-ok" };
			output.content.push(block);
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	});
	return stream;
}

export default function sourceUnitProjectionProbe(pi: ExtensionAPI): void {
	if (!/^0\.82\./u.test(PI_VERSION)) {
		throw new Error(`Source-unit projection probe requires Pi 0.82.x; loaded ${PI_VERSION}.`);
	}

	pi.on("resources_discover", () => {
		const probeConfig = config();
		const loaded = probeConfig.effectiveSkills.map((expected) => {
			const result = loadSkillsFromDir({
				dir: expected.skillRoot,
				source: "bazframe-source-unit-probe",
			});
			return {
				expected,
				diagnostics: result.diagnostics,
				skills: result.skills.map(({ filePath, baseDir, name }) => ({ filePath, baseDir, name })),
			};
		});
		const compatible = loaded.every(({ expected, diagnostics, skills }) =>
			diagnostics.length === 0
			&& skills.length === 1
			&& skills[0]?.filePath === expected.definitionPath
			&& skills[0]?.baseDir === expected.skillRoot
			&& skills[0]?.name === expected.declaredName
		);
		const skillPaths = compatible
			? probeConfig.effectiveSkills.map((skill) => skill.definitionPath)
			: [];
		if (skillPaths.includes(probeConfig.sourceRoot)) {
			throw new Error("Grouping root must never be returned to Pi.");
		}
		capture({
			type: "resources-discover",
			scenario: probeConfig.scenario,
			cwd: process.cwd(),
			piVersion: PI_VERSION,
			loaded,
			compatible,
			skillPaths,
			groupingRootRequested: false,
		});
		return skillPaths.length === 0 ? undefined : { skillPaths };
	});

	pi.registerProvider("bazframe-source-unit-probe", {
		name: "Bazframe source-unit projection probe",
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "probe",
		api: "openai-completions",
		models: [{
			id: "probe",
			name: "Bazframe source-unit projection probe",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1024,
		}],
		streamSimple: streamProbe,
	});
}
