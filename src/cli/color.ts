export interface CliColors {
  enabled: boolean;
  heading: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
  command: (text: string) => string;
  muted: (text: string) => string;
}

export function shouldUseColor(
  environment: NodeJS.ProcessEnv,
  streamIsTty: boolean
): boolean {
  if (Object.hasOwn(environment, 'NO_COLOR')) return false;
  if (environment.FORCE_COLOR !== undefined) return environment.FORCE_COLOR !== '0';
  return streamIsTty;
}

export function createCliColors(enabled: boolean): CliColors {
  return {
    enabled,
    heading: style(enabled, '1;36'),
    success: style(enabled, '32'),
    warning: style(enabled, '33'),
    error: style(enabled, '31'),
    command: style(enabled, '36'),
    muted: style(enabled, '2')
  };
}

export function colorizeHelp(text: string, colors: CliColors): string {
  if (!colors.enabled) return text;
  return text
    .split('\n')
    .map((line) => {
      if (line === 'Bazframe' || /^[A-Z][^:]*:$/u.test(line)) {
        return colors.heading(line);
      }
      if (line.startsWith('Usage:')) {
        return `${colors.heading('Usage:')}${line.slice('Usage:'.length)}`;
      }
      return line;
    })
    .join('\n');
}

export function colorizeStatus(text: string, colors: CliColors): string {
  if (!colors.enabled) return text;
  return text
    .split('\n')
    .map((line, index) => {
      if (index === 0 || line === 'Launch:' || line === 'Corrective actions:') {
        return colors.heading(line);
      }
      if (line.startsWith('  - ')) return colors.warning(line);
      return line;
    })
    .join('\n');
}

function style(enabled: boolean, code: string): (text: string) => string {
  return enabled
    ? (text) => `\u001b[${code}m${text}\u001b[0m`
    : (text) => text;
}
