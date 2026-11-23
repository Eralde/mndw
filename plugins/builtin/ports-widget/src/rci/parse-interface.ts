import {isRecord, toNumber, toOnOff} from './value.js';

export type LinkStatus = 'up' | 'down' | 'unknown';
export type Duplex = 'full' | 'half';

/** One port's link state from `show interface name=<id>`. */
export interface LinkInfo {
  readonly status: LinkStatus;
  readonly speedMbps: number | null;
  readonly duplex: Duplex | null;
  readonly autoNegotiation: boolean | null;
  readonly flowControl: boolean | null;
  readonly eee: boolean | null;
  readonly lastChangeSeconds: number | null;
  /** An `sfp` object means the port is drawn with link state only. */
  readonly hasSfp: boolean;
  readonly role: 'inet' | null;
  readonly activeMedium: 'ethernet' | 'sfp' | '';
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

export function parseInterface(reply: unknown): LinkInfo | null {
  if (!isRecord(reply)) {
    return null;
  }

  const link = reply.link;
  const roles = Array.isArray(reply.role) ? reply.role : [reply.role];
  const active = reply.active ?? reply['active-medium'] ?? reply['active-medium-type'];

  return {
    status: link === 'up' || link === 'down' ? link : 'unknown',
    speedMbps: positive(toNumber(reply.speed)),
    duplex: reply.duplex === 'full' || reply.duplex === 'half' ? reply.duplex : null,
    autoNegotiation: toOnOff(reply['auto-negotiation']),
    flowControl: toOnOff(reply['flow-control']),
    eee: toOnOff(reply.eee),
    lastChangeSeconds: toNumber(reply['last-change']),
    hasSfp: isRecord(reply.sfp),
    role: roles.some((role) => role === 'inet' || (isRecord(role) && role.role === 'inet')) ? 'inet' : null,
    activeMedium: active === 'ethernet' || active === 'sfp' ? active : '',
  };
}
