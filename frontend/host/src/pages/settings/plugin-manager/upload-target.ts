export type ExampleTarget = 'aarch64' | 'mips' | 'mipsel';

const PING_ARCHIVE_TARGETS: Readonly<Record<string, ExampleTarget>> = {
  'ping-widget-aarch64.zip': 'aarch64',
  'ping-widget-mips.zip': 'mips',
  'ping-widget-mipsel.zip': 'mipsel',
};

export function targetForDeviceArchitecture(raw: string | undefined): ExampleTarget | undefined {
  switch (raw) {
    case 'aarch64':
      return 'aarch64';
    case 'mips':
      return 'mips';
    case 'mipsel':
      return 'mipsel';
    default:
      return undefined;
  }
}

export function validateExampleUploadTarget(
  filename: string,
  rawArchitecture: string | undefined,
): string | undefined {
  const deviceTarget = targetForDeviceArchitecture(rawArchitecture);
  const archiveTarget = PING_ARCHIVE_TARGETS[filename];

  if (deviceTarget === undefined || archiveTarget === undefined || deviceTarget === archiveTarget) {
    return undefined;
  }

  return `${filename} targets ${archiveTarget}, but this device reports ${deviceTarget}. Choose the matching archive.`;
}
