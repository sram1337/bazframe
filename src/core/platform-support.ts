import { BazframeError } from './errors.js';

export const WINDOWS_PLATFORM_UNSUPPORTED_CODE = 'WINDOWS_PLATFORM_UNSUPPORTED';
export const WINDOWS_PLATFORM_UNSUPPORTED_MESSAGE =
  'Native Windows support is not available in this Bazframe release. Use Bazframe on macOS or Linux; help and version output remain available.';

/**
 * Public Windows support stays closed until the complete installed-product
 * acceptance gate passes. The optional argument is an internal test seam;
 * production callers always use process.platform.
 */
export function assertBazframePlatformSupported(
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32') {
    throw new BazframeError(
      WINDOWS_PLATFORM_UNSUPPORTED_CODE,
      WINDOWS_PLATFORM_UNSUPPORTED_MESSAGE
    );
  }
}
