import type {Switchport} from '@mndw/sdk';

export interface PortRow {
  readonly ports: readonly Switchport[];
}

function byIndex(left: Switchport, right: Switchport): number {
  return left.index - right.index;
}

/** Draws ports in their physical layout rows; ports missing from the layout get one extra row. */
export function buildRows(layout: readonly (readonly string[])[], list: readonly Switchport[]): PortRow[] {
  const byLabel = new Map(list.map((port) => [port.label, port]));
  const used = new Set<string>();
  const rows: PortRow[] = [];

  for (const labels of layout) {
    const ports: Switchport[] = [];

    for (const label of labels) {
      const port = byLabel.get(label);

      if (port !== undefined && !used.has(port.id)) {
        used.add(port.id);
        ports.push(port);
      }
    }

    if (ports.length > 0) {
      rows.push({ports});
    }
  }

  const leftovers = list.filter((port) => !used.has(port.id)).sort(byIndex);

  if (leftovers.length > 0) {
    rows.push({ports: leftovers});
  }

  return rows;
}
