import type {MwsClient, MwsNode} from '../../domain/mws/mws.types';

export interface ClientRow {
  client: MwsClient;
  node: MwsNode;
}

export type SortKey = 'name' | 'node' | 'link' | 'ip' | 'mac' | 'uptime';
export type SortDir = 'asc' | 'desc';

type Ipv4 = readonly [number, number, number, number];

export function buildClientRows(roots: MwsNode[]): ClientRow[] {
  const rows: ClientRow[] = [];

  const visit = (node: MwsNode): void => {
    for (const client of node.clients) {
      rows.push({client, node});
    }

    for (const child of node.children) {
      visit(child.node);
    }
  };

  for (const root of roots) {
    visit(root);
  }

  return rows;
}

export function filterRows(rows: ClientRow[], query: string): ClientRow[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery === '') {
    return rows;
  }

  return rows.filter((row) => {
    const values = [row.client.name, row.client.ip, row.client.mac, row.node.name];

    return values.some((value) => value?.toLowerCase().includes(normalizedQuery) ?? false);
  });
}

export function sortRows(rows: ClientRow[], key: SortKey, dir: SortDir): ClientRow[] {
  const direction = dir === 'asc' ? 1 : -1;

  return rows
    .map((row, index) => ({row, index}))
    .sort((left, right) => {
      const leftIsNull = isNullSortValue(left.row, key);
      const rightIsNull = isNullSortValue(right.row, key);

      if (leftIsNull || rightIsNull) {
        if (leftIsNull && rightIsNull) {
          return left.index - right.index;
        }

        return leftIsNull ? 1 : -1;
      }

      const comparison = compareRows(left.row, right.row, key);

      return comparison === 0 ? left.index - right.index : comparison * direction;
    })
    .map(({row}) => row);
}

function isNullSortValue(row: ClientRow, key: SortKey): boolean {
  if (key === 'ip') {
    return parseIpv4(row.client.ip) === null;
  }

  return key === 'uptime' && row.client.uptime === null;
}

function compareRows(left: ClientRow, right: ClientRow, key: SortKey): number {
  if (key === 'ip') {
    const leftIp = parseIpv4(left.client.ip);
    const rightIp = parseIpv4(right.client.ip);

    if (leftIp === null || rightIp === null) {
      return compareNullsLast(leftIp, rightIp) ?? 0;
    }

    return compareIpv4(leftIp, rightIp);
  }

  if (key === 'uptime') {
    const leftUptime = left.client.uptime;
    const rightUptime = right.client.uptime;

    if (leftUptime === null || rightUptime === null) {
      return compareNullsLast(leftUptime, rightUptime) ?? 0;
    }

    return compareNumbers(leftUptime, rightUptime);
  }

  if (key === 'link') {
    return compareNumbers(Number(right.client.wired), Number(left.client.wired));
  }

  if (key === 'name') {
    return compareText(left.client.name, right.client.name);
  }

  if (key === 'node') {
    return compareText(left.node.name, right.node.name);
  }

  return compareText(left.client.mac, right.client.mac);
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

function compareNullsLast<T>(left: T | null, right: T | null): number | null {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return null;
}
