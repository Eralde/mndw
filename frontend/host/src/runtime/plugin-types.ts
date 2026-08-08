import type {BackendRouteDescriptor, WidgetSize} from '@mndw/sdk';

/**
 * The runtime's view of a plugin, as delivered by the daemon's `GET /api/mgmt/list`.
 * This is a flattened list entry - NOT a full plugin manifest:
 * the daemon has already validated the manifest and merged builtin + uploaded plugins,
 * so the runtime consumes this trusted shape rather than re-validating manifests client-side.
 */

export type PluginSource = 'builtin' | 'registry' | 'upload';

/**
 * Dependency state surfaced by daemon. Package installation is explicit approval
 * work, so startup does not report background installation progress.
 */
export type DepsStatus = 'ready' | 'installing' | 'failed';

/** Approval states that can appear in the list (a denied plugin is removed, not listed). */
export type PluginApproval = 'pending' | 'approved';

/**
 * The client-facing backend capability snapshot (daemon `BackendDescriptor`). Always
 * present, even for a plugin with no backend.
 */
export interface PluginBackendDescriptor {
  routes: Record<string, BackendRouteDescriptor>;
}

export interface PluginRuntimeStatus {
  state: 'stopped' | 'capacity_blocked' | 'starting' | 'ready' | 'backoff' | 'failed';
  restartCount: number;
  consecutiveFailures: number;
  nextAttemptAt?: string;
  lastExit?: string;
  lastError?: string;
  recentStderr?: string[];
  requiredProtocol?: number;
  compatible?: boolean;
  supportedProtocols?: number[];
}

interface PluginListEntryBase {
  name: string;
  version: string;
  label: string;
  entry: string;
  icon?: string;
  source: PluginSource;
  approval: PluginApproval;
  enabled: boolean;
  depsStatus: DepsStatus;
  backend: PluginBackendDescriptor;
  runtime?: PluginRuntimeStatus;
}

export interface WidgetListEntry extends PluginListEntryBase {
  type: 'widget';
  size: WidgetSize;
  fixedHeight?: boolean;
}

export interface PageListEntry extends PluginListEntryBase {
  type: 'page';
  route: string;
}

export type PluginListEntry = WidgetListEntry | PageListEntry;
