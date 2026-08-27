import {describe, expect, it} from 'vitest';
import {targetForDeviceArchitecture, validateExampleUploadTarget} from './upload-target.js';

describe('upload target guidance', () => {
  it('maps known device architecture values to bare targets', () => {
    expect(targetForDeviceArchitecture('aarch64')).toBe('aarch64');
    expect(targetForDeviceArchitecture('mips')).toBe('mips');
    expect(targetForDeviceArchitecture('mipsel')).toBe('mipsel');
  });

  it('skips preflight when architecture is unknown or missing', () => {
    expect(targetForDeviceArchitecture(undefined)).toBeUndefined();
    expect(targetForDeviceArchitecture('unknown-cpu')).toBeUndefined();
    expect(validateExampleUploadTarget('ping-widget-mips.zip', undefined)).toBeUndefined();
  });

  it('rejects a known ping archive for a different target', () => {
    expect(validateExampleUploadTarget('ping-widget-mipsel.zip', 'mips')).toContain('mipsel');
    expect(validateExampleUploadTarget('ping-widget-aarch64.zip', 'aarch64')).toBeUndefined();
    expect(validateExampleUploadTarget('device-traffic-widget.zip', 'mips')).toBeUndefined();
    expect(validateExampleUploadTarget('ping-widget.zip', 'mips')).toBeUndefined();
  });
});
