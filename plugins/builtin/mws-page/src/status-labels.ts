import type {MwsNode} from './domain/mws/mws.types';

export type TranslatorFn = (key: string, values?: Record<string, unknown>) => string;

export interface NodeStatusLabels {
  online: string;
  telemetry: string;
  remoteControl: string;
  clients: string;
}

export function getNodeStatusLabels(node: MwsNode, t: TranslatorFn): NodeStatusLabels {
  return {
    online: t(node.isOnline ? 'status.online' : 'status.offline'),
    telemetry: telemetryLabel(node, t),
    remoteControl: remoteControlLabel(node, t),
    clients: t('status.clients', {count: node.clients.length}),
  };
}

export function getPowerDisabledHint(
  extraFeaturesActive: boolean,
  node: MwsNode,
  powerAvailable: boolean,
  pending: boolean,
  t: TranslatorFn,
): string | null {
  if (!extraFeaturesActive) {
    return t('status.power-disabled-extra-features');
  }

  if (node.persistentSession !== true) {
    return t('status.power-disabled-session');
  }

  if (!powerAvailable) {
    return t('status.power-disabled-unavailable');
  }

  if (pending) {
    return t('status.power-disabled-pending');
  }

  return null;
}

function telemetryLabel(node: MwsNode, t: TranslatorFn): string {
  if (node.isController) {
    return t('status.no-telemetry');
  }

  const state = node.mwsdStatus?.state;

  return state === undefined || state === 'unavailable'
    ? t('status.telemetry-not-available')
    : t(`status.telemetry-${state}`);
}

function remoteControlLabel(node: MwsNode, t: TranslatorFn): string {
  if (node.persistentSession === true) {
    return t('status.remote-control-connected');
  }

  if (node.persistentSession === false) {
    return t('status.remote-control-disconnected');
  }

  return t('status.remote-control-not-available');
}
