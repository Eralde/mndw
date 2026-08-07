import {Subject} from 'rxjs';
import {describe, expect, it} from 'vitest';
import {normalizeMembers} from './api/normalize';
import {buildMap} from './domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from './domain/mws/mws.types';
import {loadFixture} from './fixtures/load';
import {LiveMapNodeDetailsSource} from './node-details-source';

const CONTROLLER: ControllerInfo = {
  mac: '02:7d:4a:91:c3:10',
  ip: null,
  name: 'Router',
  model: null,
  firmware: null,
  interfaceUptime: null,
  isOnline: true,
};

function fixtureRoots(): MwsNode[] {
  return buildMap(normalizeMembers(loadFixture('show-mws-member.json')), [], CONTROLLER);
}

describe('LiveMapNodeDetailsSource', () => {
  it('emits the matching node per snapshot and null when it disappears', () => {
    const snapshots = new Subject<MwsNode[]>();
    const source = new LiveMapNodeDetailsSource(snapshots);
    const controller = new AbortController();
    const seen: Array<string | null> = [];

    source.open('02:7d:4a:91:c3:21', controller.signal).subscribe((node) => seen.push(node?.id ?? null));

    snapshots.next(fixtureRoots());
    snapshots.next(buildMap([], [], CONTROLLER));

    expect(seen).toEqual(['02:7d:4a:91:c3:21', null]);
  });

  it('completes when the abort signal fires', () => {
    const snapshots = new Subject<MwsNode[]>();
    const source = new LiveMapNodeDetailsSource(snapshots);
    const controller = new AbortController();
    let completed = false;

    source.open('x', controller.signal).subscribe({complete: () => {
      completed = true;
    }});
    controller.abort();

    expect(completed).toBe(true);
  });
});
