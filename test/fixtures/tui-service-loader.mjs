let productionServiceUrl;
let fixtureServiceUrl;
let productionAppUrl;

export function initialize(data) {
  productionServiceUrl = data.productionServiceUrl;
  fixtureServiceUrl = data.fixtureServiceUrl;
  productionAppUrl = data.productionAppUrl;
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url === productionServiceUrl) {
    return { url: fixtureServiceUrl, shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url !== productionAppUrl) return loaded;
  const source = String(loaded.source);
  const assignment = 'exitRequestedCode.current = code;';
  const callback = 'onExitCode?.(code);';
  if (!source.includes(assignment) || !source.includes(callback)) {
    throw new Error('TUI app fixture could not instrument exit state.');
  }
  return {
    ...loaded,
    source: [
      "import { renameSync as renameTuiFixtureMarker, writeFileSync as writeTuiFixtureMarkerFile } from 'node:fs';",
      "const writeTuiFixtureMarker = (path, value, options) => { const temporaryPath = `${path}.tmp`; writeTuiFixtureMarkerFile(temporaryPath, value, { ...options, flag: 'wx' }); renameTuiFixtureMarker(temporaryPath, path); };",
      source.replace(
        assignment,
        `${assignment}\n        if (process.env.BAZFRAME_TUI_FIXTURE_MARKER !== undefined) {\n            writeTuiFixtureMarker(\`${'${process.env.BAZFRAME_TUI_FIXTURE_MARKER}'}.exit-requested-code\`, \`${'${code}'}\\n\`, { mode: 0o600 });\n        }`
      ).replace(
        callback,
        `if (process.env.BAZFRAME_TUI_FIXTURE_MARKER !== undefined) {\n            writeTuiFixtureMarker(\`${'${process.env.BAZFRAME_TUI_FIXTURE_MARKER}'}.on-exit-code\`, \`${'${code}'}\\n\`, { flag: 'wx', mode: 0o600 });\n        }\n        ${callback}`
      )
    ].join('\n'),
    shortCircuit: true
  };
}
