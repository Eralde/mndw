import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {classifyMwsMemberEligibility, mwsMemberSchema} from './mws-member-schema.js';

const fixtureRoot = join(import.meta.dirname, '../../sdk/fixtures/mws-members');
const expectationPath = join(fixtureRoot, 'eligibility-expectations.json');

describe('mws member schema', () => {
  it('accepts mixed capability values and unknown legacy fields', () => {
    const result = mwsMemberSchema.parse({
      'cid': 'node-1',
      'mac': 'aa:bb:cc:dd:ee:ff',
      'ip': '192.0.2.1',
      'fqdn': 'node-1.keenetic.io',
      'fqdn-certificate-valid': true,
      'capabilities': {
        'auth-token': true,
        'security-level': {level: 'admin'},
      },
      'legacy': {firmware: 1},
    });

    expect(result.capabilities?.['security-level']).toEqual({level: 'admin'});
    expect(result.legacy).toEqual({firmware: 1});
  });

  it('accepts legacy payloads with optional focused fields absent', () => {
    expect(mwsMemberSchema.parse({cid: 'legacy-node', mac: 'aa:bb:cc:dd:ee:ff'})).toMatchObject({
      cid: 'legacy-node',
    });
  });

  it.each([
    ['cid', {cid: 42}],
    ['mac', {mac: 42}],
    ['ip', {ip: 42}],
    ['fqdn', {fqdn: 42}],
    ['fqdn-certificate-valid', {'fqdn-certificate-valid': 'true'}],
    ['capabilities', {capabilities: []}],
  ])('rejects invalid focused field type: %s', (_field, value) => {
    expect(() => mwsMemberSchema.parse(value)).toThrow();
  });
});

describe('mws member eligibility', () => {
  it('matches generated eligibility expectations for every fixture', () => {
    const expectations = JSON.parse(readFileSync(expectationPath, 'utf8')) as Record<string, {
      eligible: boolean;
      reason?: string;
    }>;

    const fixtureFiles = readdirSync(fixtureRoot).filter((entry) =>
      entry.endsWith('.json') && entry !== 'eligibility-expectations.json'
    );

    expect(Object.keys(expectations).sort()).toEqual(fixtureFiles.sort());

    for (const filename of fixtureFiles) {
      const parsed = JSON.parse(readFileSync(join(fixtureRoot, filename), 'utf8')) as unknown;
      const member = Array.isArray(parsed) ? parsed[0] : parsed;
      const expected = expectations[filename];

      expect(expected, filename).toBeDefined();
      expect(classifyMwsMemberEligibility(member), filename).toEqual(expected);
    }
  });

  it('uses missing FQDN, certificate, then capability precedence', () => {
    expect(classifyMwsMemberEligibility({
      'fqdn': ' ',
      'fqdn-certificate-valid': false,
      'capabilities': {'auth-token': false},
    })).toEqual({eligible: false, reason: 'missing-fqdn'});
    expect(classifyMwsMemberEligibility({
      'fqdn': 'node.keenetic.io',
      'fqdn-certificate-valid': false,
      'capabilities': {'auth-token': false},
    })).toEqual({eligible: false, reason: 'certificate-invalid'});
    expect(classifyMwsMemberEligibility({
      'fqdn': 'node.keenetic.io',
      'fqdn-certificate-valid': true,
      'capabilities': {'auth-token': false},
    })).toEqual({eligible: false, reason: 'no-auth-token'});
    expect(
      classifyMwsMemberEligibility({'fqdn': '192.0.2.1', 'fqdn-certificate-valid': true,
        'capabilities': {'auth-token': true}}),
    ).toEqual({
      eligible: false,
      reason: 'missing-fqdn',
    });
  });
});
