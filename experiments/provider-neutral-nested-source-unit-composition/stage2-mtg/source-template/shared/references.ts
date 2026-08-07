import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const approved = [
  "card-evaluation-framework.md",
  "synergy-support-math.md"
] as const;

export async function loadApprovedReferences(): Promise<Array<{
  path: string;
  sha256: string;
}>> {
  return Promise.all(approved.map(async (name) => {
    const bytes = await readFile(new URL(`./references/${name}`, import.meta.url));
    return {
      path: `shared/references/${name}`,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }));
}

export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}
