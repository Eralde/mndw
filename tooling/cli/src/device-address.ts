import {CliError} from './errors.js';

const INVALID_ADDRESS = 'expected an IP, host[:port] or http(s) URL';

/** Normalizes a device address to an origin suitable for the daemon and Vite proxies. */
export function normalizeDeviceAddress(input: string): string {
  const value = input.trim();

  try {
    if (value === '') {
      throw new Error('empty address');
    }

    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    const url = new URL(candidate);

    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.hostname === ''
      || !['', '/'].includes(url.pathname)
      || url.search !== ''
      || url.hash !== ''
      || url.username !== ''
      || url.password !== ''
    ) {
      throw new Error('address must be an origin');
    }

    return url.origin;
  } catch {
    throw new CliError(`Invalid --addr "${input}": ${INVALID_ADDRESS}`);
  }
}
