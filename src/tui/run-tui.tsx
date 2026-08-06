import { render } from 'ink';
import { EXIT_STATUS } from '../core/exit-status.js';
import { createBazframeTuiService } from '../application/tui-service.js';
import { TuiApp } from './app.js';

export interface RunTuiOptions {
  bazframeHome: string;
  bazframeVersion: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  userHome?: string;
  adapterArtifactUrl?: URL;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  terminateProcess: (status: number) => void;
}

export async function runTui(options: RunTuiOptions): Promise<number> {
  const screenReader = options.environment.INK_SCREEN_READER === 'true';
  let exitCode: number = EXIT_STATUS.success;
  let forceExitWarning = false;
  let instance: ReturnType<typeof render> | undefined;

  try {
    instance = render(
      <TuiApp
      service={createBazframeTuiService({
        bazframeHome: options.bazframeHome,
        bazframeVersion: options.bazframeVersion,
        cwd: options.cwd,
        environment: options.environment,
        ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
        ...(options.adapterArtifactUrl === undefined
          ? {}
          : { adapterArtifactUrl: options.adapterArtifactUrl })
      })}
      onExitCode={(code) => {
        exitCode = code;
      }}
      onForceExit={() => {
        forceExitWarning = true;
      }}
    />,
    {
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
      alternateScreen: !screenReader,
      debug: screenReader,
      incrementalRendering: !screenReader,
      isScreenReaderEnabled: screenReader,
      exitOnCtrlC: false
      }
    );

    await instance.waitUntilExit();
    unmountInstance();
    if (forceExitWarning) {
      // Ink cleanup completed above; flush the warning before abandoning live mutation handles.
      await writeAndFlush(
        options.stderr,
        'warning: forced exit; the in-flight operation outcome may be unknown.\n'
      );
      options.terminateProcess(EXIT_STATUS.interrupted);
    }
    return exitCode;
  } catch (error) {
    unmountInstance();
    const message = error instanceof Error ? error.message : String(error);
    options.stderr.write(`error: ${message}\n`);
    return EXIT_STATUS.failure;
  }

  function unmountInstance(): void {
    const mountedInstance = instance;
    instance = undefined;
    mountedInstance?.unmount();
  }
}

function writeAndFlush(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
