import type {WidgetSize} from '@mndw/sdk';

/**
 * The runtime's view of a plugin, as delivered by the daemon's `GET /api/mgmt/list`
 * (design §5.2). This is a flattened list entry — NOT a full plugin manifest: the
 * daemon has already validated the manifest and merged builtin + user plugins, so the
 * runtime consumes this trusted shape rather than re-validating manifests client-side.
 */

export type PluginSource = 'builtin' | 'user';

/** Approval states that can appear in the list (a denied plugin is removed, not listed). */
export type PluginApproval = 'pending' | 'approved';

/**
 * The client-facing backend capability snapshot (daemon `BackendDescriptor`). Always
 * present, even for a plugin with no backend (empty maps, `daemon`/`public` false).
 */
export interface PluginBackendDescriptor {
  endpoints: Record<string, {method: string; path: string}>;
  websockets: Record<string, {path: string; protocols?: string[]}>;
  opkg: string[];
  daemon: boolean;
  public: boolean;
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
  backend: PluginBackendDescriptor;
}

export interface WidgetListEntry extends PluginListEntryBase {
  type: 'widget';
  size: WidgetSize;
}

export interface PageListEntry extends PluginListEntryBase {
  type: 'page';
  route: string;
}

export type PluginListEntry = WidgetListEntry | PageListEntry;
