import type {RciQuery} from '@rci-tools/core';
import {normalizeMac} from './normalize';

export type MwsPortRole = 'disabled' | 'primary' | {segment: string};

const SAVE_QUERY: RciQuery = {path: 'system.configuration.save'};

function saved(query: RciQuery): RciQuery[] {
  return [query, SAVE_QUERY];
}

function normalizedMember(mac: string): string {
  return normalizeMac(mac);
}

export function buildSetNameQueries(mac: string, name: string | null): RciQuery[] {
  const trimmedName = name?.trim() ?? '';
  const data = trimmedName === ''
    ? {mac: normalizedMember(mac), no: true}
    : {mac: normalizedMember(mac), name: trimmedName};

  return saved({path: 'known.host', data});
}

export function buildSetStaticIpQueries(mac: string, ip: string | null): RciQuery[] {
  const data = ip === null || ip.trim() === ''
    ? {mac: normalizedMember(mac), no: true}
    : {mac: normalizedMember(mac), ip: ip.trim()};

  return saved({path: 'ip.dhcp.host', data});
}

export function buildSetUpdateChannelQueries(mac: string, channel: string | null): RciQuery[] {
  const member = normalizedMember(mac);
  const data = channel === null || channel.trim() === ''
    ? {member, update: {channel: {no: true}}}
    : {member, update: {channel: channel.trim()}};

  return saved({path: 'mws.member', data});
}

function assertPortRole(role: MwsPortRole): void {
  if (role === 'disabled' || role === 'primary') {
    return;
  }

  if (typeof role !== 'object' || role === null || typeof role.segment !== 'string' || role.segment.trim() === '') {
    throw new Error('invalid port role');
  }
}

function sameRole(left: MwsPortRole, right: MwsPortRole): boolean {
  if (left === right) {
    return true;
  }

  return typeof left === 'object'
    && left !== null
    && typeof right === 'object'
    && right !== null
    && left.segment.trim() === right.segment.trim();
}

export function buildSetPortRoleQueries(
  mac: string,
  port: string,
  previousRole: MwsPortRole,
  nextRole: MwsPortRole,
): RciQuery[] {
  const member = normalizedMember(mac);

  if (typeof port !== 'string' || !/^\d+$/.test(port)) {
    throw new Error('invalid port');
  }

  assertPortRole(previousRole);
  assertPortRole(nextRole);

  if (sameRole(previousRole, nextRole)) {
    return [];
  }

  const commands: RciQuery[] = [];
  const memberPort = (data: Record<string, unknown>): RciQuery => ({
    path: 'mws.member',
    data: {member, port: {port, ...data}},
  });

  if (nextRole === 'disabled') {
    if (previousRole !== 'disabled') {
      commands.push(memberPort({access: {no: true}}));
    }

    commands.push(memberPort({disable: {}}));
  } else {
    if (previousRole === 'disabled') {
      commands.push(memberPort({disable: {no: true}}));
    }

    const access = nextRole === 'primary'
      ? {no: true}
      : {interface: nextRole.segment.trim()};

    commands.push(memberPort({access}));
  }

  return [...commands, SAVE_QUERY];
}

export function buildSetBackhaulQueries(enabled: boolean): RciQuery[] {
  return saved({path: 'mws.backhaul', data: enabled ? {} : {shutdown: true}});
}

export function buildSetAutoApShutdownQueries(enabled: boolean): RciQuery[] {
  return saved({path: 'mws.auto-ap-shutdown', data: enabled ? {} : {no: true}});
}

export function buildSetAutoUpdateQueries(enabled: boolean): RciQuery[] {
  return saved({path: 'components.auto-update', data: {disable: !enabled}});
}

export function buildSetAutoUpdateScheduleQueries(schedule: string | null): RciQuery[] {
  return saved({
    path: 'components.auto-update',
    data: schedule === null || schedule.trim() === '' ? {schedule: {no: true}} : {schedule: schedule.trim()},
  });
}
