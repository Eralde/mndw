import {isRecord, toNumber} from './value.js';

/** The largest advertised `mdi.phy[].speed`, in Mbps. */
export function parseMaxSpeedMbps(reply: unknown): number | null {
  if (!isRecord(reply) || !isRecord(reply.mdi) || !Array.isArray(reply.mdi.phy)) {
    return null;
  }

  let maximum: number | null = null;

  for (const entry of reply.mdi.phy) {
    if (!isRecord(entry)) {
      continue;
    }

    const speed = toNumber(entry.speed);

    if (speed !== null && speed > 0 && (maximum === null || speed > maximum)) {
      maximum = speed;
    }
  }

  return maximum;
}
