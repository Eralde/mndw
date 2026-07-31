const DASH = '—';

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

export function formatUptime(seconds: number | null | undefined): string {
  if (!finite(seconds) || seconds < 0) {
    return DASH;
  }

  let remaining = Math.trunc(seconds);
  const units: Array<[string, number]> = [
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
    ['s', 1],
  ];
  const parts: string[] = [];

  for (const [label, size] of units) {
    const amount = Math.floor(remaining / size);

    remaining %= size;

    if (amount > 0 || (parts.length === 0 && label === 's')) {
      parts.push(`${amount}${label}`);
    }

    if (parts.length === 2) {
      break;
    }
  }

  return parts.join(' ');
}

export function formatMemory(used: number | null | undefined, total: number | null | undefined): string {
  if (!finite(used) || !finite(total)) {
    return DASH;
  }

  const usedMiB = used / 1024;
  const totalMiB = Math.round(total / 1024);
  const usedText = Math.abs(usedMiB) < 10 ? usedMiB.toFixed(1) : String(Math.round(usedMiB));

  return `${usedText} / ${totalMiB} MiB`;
}

export function formatCpuLoad(value: number | null | undefined): string {
  if (!finite(value)) {
    return DASH;
  }

  return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}

export function formatRssi(value: number | null | undefined): string {
  if (!finite(value)) {
    return DASH;
  }

  const rounded = Math.round(value);
  const prefix = rounded < 0 ? '−' : '';

  return `${prefix}${Math.abs(rounded)} dBm`;
}

export function formatRate(value: number | null | undefined): string {
  if (!finite(value) || value <= 0) {
    return DASH;
  }

  if (value >= 1000) {
    const gigabits = Math.round((value / 1000) * 10) / 10;

    return `${gigabits.toFixed(1).replace(/\.0$/, '')} Gbit/s`;
  }

  return `${Math.round(value)} Mbit/s`;
}

export function formatSpeed(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return DASH;
  }

  const parsed = Number(value.trim());

  return formatRate(parsed);
}
