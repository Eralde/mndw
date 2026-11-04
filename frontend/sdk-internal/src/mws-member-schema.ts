import {z} from 'zod';

const mwsMemberFocusedSchema = z.object({
  'cid': z.string().optional(),
  'mac': z.string().optional(),
  'ip': z.string().optional(),
  'fqdn': z.string().optional(),
  'fqdn-certificate-valid': z.boolean().optional(),
  'capabilities': z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const mwsMemberSchema = mwsMemberFocusedSchema;

export type MwsMember = z.infer<typeof mwsMemberSchema>;

export type MwsMemberEligibilityReason = 'certificate-invalid' | 'no-auth-token' | 'missing-fqdn';

export interface MwsMemberEligibility {
  readonly eligible: boolean;
  readonly reason?: MwsMemberEligibilityReason;
}

export function normalizeMwsMemberFqdn(value: string | undefined): string {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '');

  if (
    normalized === ''
    || normalized.length > 253
    || normalized.includes(':')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)
  ) {
    return '';
  }

  const labels = normalized.split('.');

  if (
    labels.length < 2
    || labels.some((label) =>
      label === '' || label.length > 63 || label.startsWith('-') || label.endsWith('-') || !/^[a-z0-9-]+$/.test(label)
    )
  ) {
    return '';
  }

  return normalized;
}

export function classifyMwsMemberEligibility(member: unknown): MwsMemberEligibility {
  const value = member !== null && typeof member === 'object' && !Array.isArray(member)
    ? member as Record<string, unknown>
    : {};
  const fqdn = typeof value.fqdn === 'string' ? value.fqdn : undefined;

  if (normalizeMwsMemberFqdn(fqdn) === '') {
    return {eligible: false, reason: 'missing-fqdn'};
  }

  if (value['fqdn-certificate-valid'] !== true) {
    return {eligible: false, reason: 'certificate-invalid'};
  }

  const capabilities =
    value.capabilities !== null && typeof value.capabilities === 'object' && !Array.isArray(value.capabilities)
      ? value.capabilities as Record<string, unknown>
      : undefined;

  if (capabilities?.['auth-token'] !== true) {
    return {eligible: false, reason: 'no-auth-token'};
  }

  return {eligible: true};
}

export function createMwsMemberSchemaDocument(): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(mwsMemberSchema, {unrepresentable: 'any'});

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://mndw/mws-member.schema.json',
    title: 'mndw mesh member',
    description: 'Focused mesh member shape generated from the Zod schema — do not edit by hand.',
    ...jsonSchema,
  };
}
