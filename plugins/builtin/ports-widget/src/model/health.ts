import type {LinkInfo} from '../rci/parse-interface.js';

export interface PortWarning {
  readonly slowerThanMaximum: boolean;
  readonly halfDuplex: boolean;
}

/** A link-up port is flagged when it runs below its maximum speed or at half duplex. */
export function portWarning(link: LinkInfo | null, maxSpeedMbps: number | null): PortWarning {
  if (link?.status !== 'up') {
    return {slowerThanMaximum: false, halfDuplex: false};
  }

  return {
    slowerThanMaximum: link.speedMbps !== null && maxSpeedMbps !== null && link.speedMbps < maxSpeedMbps,
    halfDuplex: link.duplex === 'half',
  };
}

export function hasWarning(warning: PortWarning): boolean {
  return warning.slowerThanMaximum || warning.halfDuplex;
}
