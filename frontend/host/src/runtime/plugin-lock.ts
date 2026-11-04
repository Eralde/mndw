import {SDK_VERSION} from '@mndw/sdk';
import {sharedDependencyVersions} from '@mndw/sdk-internal/shared-dependencies';

/** Supported lock schema version — mirrors CLI `lock.ts` `LOCK_VERSION`. */
export const SUPPORTED_LOCK_VERSION = 1;

/** The subset of `mndw.lock.json` the host reads for the load-time version check. */
export interface HostLock {
  readonly sdkVersion: string;
  readonly sharedDependencies: Record<string, string>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

/**
 * Fetches and parses a plugin's `mndw.lock.json`. Total: always resolves to a `HostLock`
 * or `null`, never rejects. A missing / unreachable / malformed / unsupported lock yields
 * `null` and is skipped silently — hand-assembled plugins are never penalized.
 */
export async function readPluginLock(dir: string, fetchImpl: typeof fetch = fetch): Promise<HostLock | null> {
  try {
    const response = await fetchImpl(`${dir}/mndw.lock.json`);

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as unknown;

    if (typeof data !== 'object' || data === null) {
      return null;
    }

    const objectData = data as {
      lockVersion?: unknown;
      sdkVersion?: unknown;
      sharedDependencies?: unknown;
    };

    if (objectData.lockVersion !== SUPPORTED_LOCK_VERSION) {
      return null;
    }

    const sdkVersion = objectData.sdkVersion;
    const sharedDependencies = objectData.sharedDependencies;

    if (typeof sdkVersion !== 'string' || !isStringRecord(sharedDependencies)) {
      return null;
    }

    return {sdkVersion, sharedDependencies};
  } catch {
    return null;
  }
}

/** Parses a numeric version prefix, retaining optional minor information for compatibility warnings. */
export function parseVersion(raw: string): {major: number; minor: number | null} | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const match = /^(\d+)(?:\.(\d+))?(?:[.+-]|$)/.exec(raw.trim());

  if (match === null) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? null : Number(match[2]),
  };
}

export type InstallVersionWarningKind = 'sdk-major' | 'sdk-newer-minor' | 'shared-major';

export interface InstallVersionWarning {
  readonly kind: InstallVersionWarningKind;
  readonly name: string;
  readonly pluginVersion: string;
  readonly hostVersion: string;
}

/** Collects non-blocking install warnings for SDK and host-provided shared dependency versions. */
export function getInstallVersionWarnings(
  lock: HostLock,
  hostVersions: Record<string, string> = sharedDependencyVersions(),
  hostSdkVersion: string = SDK_VERSION,
): InstallVersionWarning[] {
  const warnings: InstallVersionWarning[] = [];
  const pluginSdk = parseVersion(lock.sdkVersion);
  const hostSdk = parseVersion(hostSdkVersion);

  if (pluginSdk !== null && hostSdk !== null) {
    if (pluginSdk.major !== hostSdk.major) {
      warnings.push({
        kind: 'sdk-major',
        name: '@mndw/sdk',
        pluginVersion: lock.sdkVersion,
        hostVersion: hostSdkVersion,
      });
    } else if (pluginSdk.minor !== null && hostSdk.minor !== null && pluginSdk.minor > hostSdk.minor) {
      warnings.push({
        kind: 'sdk-newer-minor',
        name: '@mndw/sdk',
        pluginVersion: lock.sdkVersion,
        hostVersion: hostSdkVersion,
      });
    }
  }

  for (const [specifier, pluginVersion] of Object.entries(lock.sharedDependencies)) {
    const hostVersion = hostVersions[specifier];

    if (hostVersion === undefined) {
      continue;
    }

    const plugin = parseVersion(pluginVersion);
    const host = parseVersion(hostVersion);

    if (plugin !== null && host !== null && plugin.major !== host.major) {
      warnings.push({kind: 'shared-major', name: specifier, pluginVersion, hostVersion});
    }
  }

  return warnings;
}

/**
 * Collects non-fatal mismatches when a plugin's locked shared-dependency or SDK majors differ from
 * what the host provides. A comparison is skipped when the host lacks the specifier or either side
 * has no parseable major. The plugin still loads regardless.
 */
export function getPluginVersionMismatches(
  lock: HostLock,
  hostVersions: Record<string, string> = sharedDependencyVersions(),
  hostSdkVersion: string = SDK_VERSION,
): string[] {
  const mismatches: string[] = [];

  for (const [specifier, locked] of Object.entries(lock.sharedDependencies)) {
    const host = hostVersions[specifier];

    if (host === undefined) {
      continue;
    }

    const a = parseVersion(locked)?.major ?? null;
    const b = parseVersion(host)?.major ?? null;

    if (a === null || b === null) {
      continue;
    }

    if (a !== b) {
      mismatches.push(`${specifier} @${a} (host provides @${b})`);
    }
  }

  const sdkA = parseVersion(lock.sdkVersion)?.major ?? null;
  const sdkB = parseVersion(hostSdkVersion)?.major ?? null;

  if (sdkA !== null && sdkB !== null && sdkA !== sdkB) {
    mismatches.push(`@mndw/sdk @${sdkA} (host provides @${sdkB})`);
  }

  return mismatches;
}

export function checkPluginVersions(
  name: string,
  lock: HostLock,
  hostVersions: Record<string, string> = sharedDependencyVersions(),
  hostSdkVersion: string = SDK_VERSION,
): string[] {
  const mismatches = getPluginVersionMismatches(lock, hostVersions, hostSdkVersion);

  if (mismatches.length > 0) {
    console.warn(
      `[mndw] plugin "${name}" was built against ${mismatches.join(', ')}; `
        + 'it may misbehave with the versions this host provides',
    );
  }

  return mismatches;
}
