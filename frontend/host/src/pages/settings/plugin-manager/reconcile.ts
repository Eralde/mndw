import type {PluginPermission} from '@mndw/sdk';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';

export type LifecycleOp =
  | {kind: 'delete'}
  | {kind: 'deny'}
  | {kind: 'enable'}
  | {kind: 'disable'}
  | {kind: 'approve'}
  | {kind: 'restart'}
  | {kind: 'permission'; permission: PluginPermission; enabled: boolean};

export type RowState =
  | 'working'
  | 'reconciling'
  | 'notice-finishing'
  | 'notice-rejected'
  | 'outcome-unknown'
  | 'error';

export interface PluginRowState {
  state: RowState;
  message: string;
  operation?: LifecycleOp;
}

export type ReconcileOutcome = 'ok' | 'notice-finishing' | 'outcome-unknown';

export function expectedStateReached(op: LifecycleOp, name: string, list: PluginListEntry[]): boolean {
  const entry = list.find((item) => item.name === name);

  switch (op.kind) {
    case 'delete':
    case 'deny':
      return entry === undefined;
    case 'enable':
      return entry?.enabled === true;
    case 'disable':
      return entry?.enabled === false;
    case 'approve':
      return entry?.approval === 'approved';
    case 'restart':
      return false;
    case 'permission':
      return entry?.permissionGrants?.[op.permission] === op.enabled;
  }
}

export async function reconcile(
  op: LifecycleOp,
  name: string,
  listPlugins: () => Promise<PluginListEntry[]>,
  options: {polls: number; intervalMs: number},
): Promise<ReconcileOutcome> {
  if (op.kind === 'restart') {
    return 'outcome-unknown';
  }

  for (let attempt = 0; attempt < options.polls; attempt += 1) {
    const list = await listPlugins();

    if (expectedStateReached(op, name, list)) {
      return 'ok';
    }

    if (attempt + 1 < options.polls && options.intervalMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, options.intervalMs));
    }
  }

  return 'notice-finishing';
}
