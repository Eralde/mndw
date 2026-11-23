import type {Switchport} from '@mndw/sdk';
import type {Translator} from '@mndw/sdk/svelte';
import {portWarning} from './health.js';
import {formatSpeed} from './speed.js';
import type {LinkInfo} from '../rci/parse-interface.js';

type Messages = Pick<Translator, 't' | 'formatNumber'>;

export function linkStatusText(link: LinkInfo | null, translator: Messages): string {
  if (link?.status === 'up') {
    return translator.t('link.up');
  }

  if (link?.status === 'down') {
    return translator.t('link.down');
  }

  return translator.t('link.unknown');
}

/** Short value for the details row, whose label already says "Link". */
export function speedPhrase(link: LinkInfo | null, translator: Messages): string | null {
  if (link === null) {
    return null;
  }

  const speed = link.speedMbps === null ? null : formatSpeed(link.speedMbps, translator);
  const duplex = link.duplex === null ? null : translator.t(`duplex.${link.duplex}`);

  if (speed !== null && duplex !== null) {
    return translator.t('speed.duplex', {speed, duplex});
  }

  return speed ?? duplex;
}

/** The focusable port's accessible name, including its current description and link warning. */
export function describePort(
  port: Switchport,
  link: LinkInfo | null,
  maxSpeedMbps: number | null,
  translator: Messages,
  description: string | null = null,
): string {
  const state: string[] = [linkStatusText(link, translator)];

  if (link?.status === 'up') {
    const speed = speedPhrase(link, translator);

    if (speed !== null) {
      state.push(speed);
    }

    const warning = portWarning(link, maxSpeedMbps);

    if (warning.slowerThanMaximum && maxSpeedMbps !== null) {
      state.push(translator.t('warning.slower', {max: formatSpeed(maxSpeedMbps, translator)}));
    }

    if (warning.halfDuplex) {
      state.push(translator.t('warning.halfDuplex'));
    }
  }

  return translator.t('port.aria', {
    label: port.label,
    group: port.group,
    description: description === null ? '' : `${description}, `,
    state: state.join(', '),
  });
}
