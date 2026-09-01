import type {Switchport, Switchports} from '@mndw/sdk';
import {z} from 'zod';

const switchportSchema: z.ZodType<Switchport> = z.object({
  id: z.string(),
  label: z.string(),
  index: z.number()
    .finite()
    .int()
    .nonnegative(),
  type: z.string(),
  group: z.string(),
  color: z.string(),
  interfaceId: z.string(),
});

const switchportsSchema: z.ZodType<Switchports> = z.object({
  list: z.array(switchportSchema),
  layout: z.array(z.array(z.string())),
  hasPortStats: z.boolean(),
});

const deviceHardwareResponseSchema = z.object({
  switchports: switchportsSchema,
  usbPortCount: z.number()
    .finite()
    .int()
    .nonnegative(),
});

export function emptySwitchports(): Switchports {
  return {list: [], layout: [], hasPortStats: false};
}

export function decodeDeviceHardware(json: unknown): {switchports: Switchports; usbPortCount: number} {
  return deviceHardwareResponseSchema.parse(json);
}
