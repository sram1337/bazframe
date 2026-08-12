import { renameSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { register } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [packageRootArgument, markerPath, scenario = 'graceful'] = process.argv.slice(2);
const scenarios = ['graceful', 'forced', 'fatal-render', 'unicode-width'];
if (packageRootArgument === undefined || markerPath === undefined || !scenarios.includes(scenario)) {
  console.error(`Usage: tui-blocking-mutation.mjs <installed-package-root> <pid-marker> <${scenarios.join('|')}>`);
  process.exit(2);
}

const packageRoot = await realpath(resolve(packageRootArgument));
const productionServiceUrl = pathToFileURL(
  join(packageRoot, 'dist/application/tui-service.js')
).href;
const productionAppUrl = pathToFileURL(join(packageRoot, 'dist/tui/app.js')).href;
const fixtureServiceUrl = new URL('./tui-service-fixture.mjs', import.meta.url).href;
process.env.BAZFRAME_TUI_FIXTURE_MARKER = markerPath;
register(new URL('./tui-service-loader.mjs', import.meta.url), {
  parentURL: import.meta.url,
  data: { productionServiceUrl, fixtureServiceUrl, productionAppUrl }
});

const { configureTuiServiceFixture, disposeTuiServiceFixture } = await import(fixtureServiceUrl);
configureTuiServiceFixture(scenario, markerPath);
const { runTui } = await import(pathToFileURL(join(packageRoot, 'dist/tui/run-tui.js')).href);

writeMarker(markerPath, `${process.pid}\n`);
const status = await runTui({
  bazframeHome: '/fixture/bazframe-home',
  bazframeVersion: 'terminal-fixture',
  cwd: '/fixture/cwd',
  environment: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  terminateProcess: (code) => process.exit(code)
});
disposeTuiServiceFixture();
process.exitCode = status;
writeMarker(`${markerPath}.tui-exit-code`, `${status}\n`);

function writeMarker(path, value) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, value, { flag: 'wx', mode: 0o600 });
  renameSync(temporaryPath, path);
}
