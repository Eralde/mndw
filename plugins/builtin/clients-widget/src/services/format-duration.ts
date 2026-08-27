/**
 * Every user-visible time string in this widget. Kept separate from the components so
 * the exact rendered text is unit-testable rather than asserted through a template.
 */

interface DurationUnit {
  readonly seconds: number;
  readonly short: string;
  readonly long: string;
}

const UNITS: readonly DurationUnit[] = [
  {seconds: 86_400, short: 'd', long: 'day'},
  {seconds: 3600, short: 'h', long: 'hour'},
  {seconds: 60, short: 'm', long: 'minute'},
  {seconds: 1, short: 's', long: 'second'},
];

function split(seconds: number): number[] {
  let remaining = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;

  return UNITS.map((unit) => {
    const value = Math.floor(remaining / unit.seconds);

    remaining -= value * unit.seconds;

    return value;
  });
}

export function formatCompactDuration(seconds: number): string {
  const parts = split(seconds);
  const shown: string[] = [];

  for (let index = 0; index < UNITS.length && shown.length < 2; index += 1) {
    if (parts[index] > 0) {
      shown.push(`${parts[index]}${UNITS[index].short}`);
    }
  }

  return shown.length > 0 ? shown.join(' ') : '0s';
}

export function formatElapsed(seconds: number): string {
  return `${formatCompactDuration(seconds)} ago`;
}

export function formatFullDuration(seconds: number): string {
  const parts = split(seconds);
  const shown: string[] = [];

  for (let index = 0; index < UNITS.length; index += 1) {
    const value = parts[index];

    if (value > 0) {
      shown.push(`${value} ${UNITS[index].long}${value === 1 ? '' : 's'}`);
    }
  }

  return shown.length > 0 ? shown.join(', ') : '0 seconds';
}
