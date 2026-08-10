import type {MwsNode} from '../../domain/mws/mws.types';

export interface NodeRow {
  id: string;
  node: MwsNode;
}

export type NodeSortKey = 'name' | 'clients' | 'uptime' | 'ip' | 'via' | 'firmware';
export type NodeSortDir = 'asc' | 'desc';

type Ipv4 = readonly [number, number, number, number];

export function buildNodeRows(roots: MwsNode[]): NodeRow[] {
  const rows: NodeRow[] = [];

  const visit = (node: MwsNode): void => {
    rows.push({id: node.id, node});

    for (const child of node.children) {
      visit(child.node);
    }
  };

  for (const root of roots) {
    visit(root);
  }

  return rows;
}

export function filterNodeRows(rows: NodeRow[], query: string): NodeRow[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery === '') {
    return rows;
  }

  return rows.filter((row) => row.node.name.toLowerCase().includes(normalizedQuery));
}

export function reconcileNodeRows(previous: NodeRow[], next: NodeRow[], query: string): NodeRow[] {
  const nextById = new Map(next.map((row) => [row.id, row]));
  const visibleNext = filterNodeRows(next, query);
  const visibleIds = new Set(visibleNext.map((row) => row.id));
  const result: NodeRow[] = [];
  const retainedIds = new Set<string>();

  for (const row of previous) {
    const replacement = nextById.get(row.id);

    if (replacement !== undefined && visibleIds.has(row.id)) {
      result.push(replacement);
      retainedIds.add(row.id);
    }
  }

  for (const row of visibleNext) {
    if (!retainedIds.has(row.id)) {
      result.push(row);
    }
  }

  return result;
}

function compareText(left: string, right: string): number {
  const leftNormalized = left.toLowerCase();
  const rightNormalized = right.toLowerCase();

  return leftNormalized < rightNormalized ? -1 : leftNormalized > rightNormalized ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseIpv4(value: string | null): Ipv4 | null {
  if (value === null) {
    return null;
  }

  const parts = value.split('.');

  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return null;
  }

  const octets = parts.map((part) => Number(part));

  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }

  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function compareIpv4(left: Ipv4, right: Ipv4): number {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = compareNumbers(left[index], right[index]);

    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

function sortValue(row: NodeRow, key: NodeSortKey): string | number | Ipv4 | null {
  if (key === 'name') {
    return row.node.name;
  }

  if (key === 'clients') {
    return row.node.clients.length;
  }

  if (key === 'uptime') {
    return row.node.system?.uptime ?? null;
  }

  if (key === 'ip') {
    return parseIpv4(row.node.ip);
  }

  if (key === 'via') {
    return row.node.parent?.node.name ?? null;
  }

  return row.node.fw;
}

function compareSortValues(
  left: string | number | Ipv4,
  right: string | number | Ipv4,
): number {
  if (typeof left === 'string' && typeof right === 'string') {
    return compareText(left, right);
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return compareNumbers(left, right);
  }

  return compareIpv4(left as Ipv4, right as Ipv4);
}

export function sortNodeRows(rows: NodeRow[], key: NodeSortKey, dir: NodeSortDir): NodeRow[] {
  const direction = dir === 'asc' ? 1 : -1;

  return rows
    .map((row, index) => ({row, index}))
    .sort((left, right) => {
      const leftValue = sortValue(left.row, key);
      const rightValue = sortValue(right.row, key);

      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) {
          return left.index - right.index;
        }

        return leftValue === null ? 1 : -1;
      }

      const comparison = compareSortValues(leftValue, rightValue);

      return comparison === 0 ? left.index - right.index : comparison * direction;
    })
    .map(({row}) => row);
}
