import type {DeviceHostRecord, MwsMemberRecord} from '../../api/rci.types';
import type {ControllerInfo, MwsClient, MwsNode} from './mws.types';

export function buildMap(
  members: MwsMemberRecord[],
  hosts: DeviceHostRecord[],
  controller: ControllerInfo,
): MwsNode[] {
  const controllerNode: MwsNode = {
    id: controller.mac,
    cid: null,
    name: controller.name,
    model: controller.model,
    ip: controller.ip,
    mac: controller.mac,
    isController: true,
    isOnline: controller.isOnline,
    fw: controller.firmware,
    fwAvailable: null,
    system: {cpuload: null, memoryUsed: null, memoryTotal: null, uptime: controller.interfaceUptime},
    backhaul: null,
    parent: null,
    children: [],
    clients: [],
  };

  const uniqueMembers: MwsMemberRecord[] = [];
  const seenMacs = new Set<string>([controller.mac]);

  for (const record of members) {
    if (!seenMacs.has(record.mac)) {
      seenMacs.add(record.mac);
      uniqueMembers.push(record);
    }
  }

  const pairs = uniqueMembers.map((record) => ({record, node: toMemberNode(record)}));
  const byMac = new Map<string, MwsNode>([[controllerNode.mac, controllerNode]]);

  for (const {node} of pairs) {
    byMac.set(node.mac, node);
  }

  const cidCounts = new Map<string, number>();

  for (const {record} of pairs) {
    cidCounts.set(record.cid, (cidCounts.get(record.cid) ?? 0) + 1);
  }

  const byUniqueCid = new Map<string, MwsNode>();

  for (const {record, node} of pairs) {
    if (cidCounts.get(record.cid) === 1) {
      byUniqueCid.set(record.cid, node);
    }
  }

  const roots: MwsNode[] = [controllerNode];

  for (const {record, node} of pairs) {
    const parentMac = record.backhaul?.parentMac ?? null;
    const parentNode = parentMac === null ? undefined : byMac.get(parentMac);

    if (record.backhaul === null || parentNode === undefined || parentNode === node) {
      roots.push(node);
      continue;
    }

    const type = record.backhaul.ap !== null ? 'wireless' as const : 'wired' as const;

    node.parent = {type, node: parentNode};
    parentNode.children.push({type, node});
  }

  detachCycles(pairs.map(({node}) => node), roots);

  for (const host of hosts) {
    const target = (host.mwsCid !== null ? byUniqueCid.get(host.mwsCid) : undefined) ?? controllerNode;

    target.clients.push(toClient(host));
  }

  return roots;
}

export function findNodeById(roots: MwsNode[], id: string): MwsNode | null {
  for (const root of roots) {
    const stack: MwsNode[] = [root];

    while (stack.length > 0) {
      const node = stack.pop();

      if (node === undefined) {
        continue;
      }

      if (node.id === id) {
        return node;
      }

      for (const link of node.children) {
        stack.push(link.node);
      }
    }
  }

  return null;
}

function toMemberNode(record: MwsMemberRecord): MwsNode {
  return {
    id: record.mac,
    cid: record.cid,
    name: record.knownHost ?? record.model ?? record.mac,
    model: record.model,
    ip: record.ip,
    mac: record.mac,
    isController: false,
    isOnline: record.backhaul !== null,
    fw: record.fw,
    fwAvailable: record.fwAvailable,
    system: record.system,
    backhaul: record.backhaul,
    parent: null,
    children: [],
    clients: [],
  };
}

function toClient(host: DeviceHostRecord): MwsClient {
  return {mac: host.mac, name: host.name, ip: host.ip, uptime: host.uptime, lastSeen: host.lastSeen, wired: host.wired};
}

function detachCycles(nodes: MwsNode[], roots: MwsNode[]): void {
  for (const start of nodes) {
    const seen = new Set<MwsNode>();
    let current = start;

    while (current.parent !== null && !seen.has(current)) {
      seen.add(current);
      current = current.parent.node;
    }

    if (current.parent === null) {
      continue;
    }

    const cycle: MwsNode[] = [current];
    let walker = current.parent.node;

    while (walker !== current) {
      cycle.push(walker);

      if (walker.parent === null) {
        break;
      }

      walker = walker.parent.node;
    }

    for (const node of cycle) {
      const parent = node.parent?.node;

      if (parent !== undefined) {
        parent.children = parent.children.filter((link) => link.node !== node);
      }

      node.parent = null;

      if (!roots.includes(node)) {
        roots.push(node);
      }
    }
  }
}
