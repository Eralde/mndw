import {expect, it} from 'vitest';
import downReply from '../fixtures/interface-down.json';
import sfpReply from '../fixtures/interface-sfp.json';
import upReply from '../fixtures/interface-up-100.json';
import inetPortReply from '../fixtures/show-interface.KN-4310.sanitized.json';
import {parseInterface} from './parse-interface.js';

it('parses a link-up port with speed, duplex and negotiation flags', () => {
  expect(parseInterface(upReply)).toEqual({
    status: 'up',
    speedMbps: 100,
    duplex: 'full',
    autoNegotiation: true,
    flowControl: true,
    eee: false,
    lastChangeSeconds: 8342.74361,
    hasSfp: false,
    role: null,
    activeMedium: '',
  });
});

it('parses a link-down port without speed or duplex', () => {
  expect(parseInterface(downReply)).toEqual({
    status: 'down',
    speedMbps: null,
    duplex: null,
    autoNegotiation: null,
    flowControl: null,
    eee: null,
    lastChangeSeconds: 8357.458863,
    hasSfp: false,
    role: null,
    activeMedium: '',
  });
});

it('flags an SFP port so the view draws link state only', () => {
  expect(parseInterface(sfpReply)).toMatchObject({status: 'up', hasSfp: true});
});

it('parses the internet role and an explicit active combo medium', () => {
  expect(parseInterface({link: 'up', role: 'inet', active: 'sfp'})).toMatchObject({
    role: 'inet',
    activeMedium: 'sfp',
  });
});

it('parses the internet role from the sanitized router interface sample', () => {
  expect(parseInterface(inetPortReply['GigabitEthernet1/0'])).toMatchObject({
    role: 'inet',
    activeMedium: '',
  });
});

it('leaves combo medium blank when reply has no active-medium field', () => {
  expect(parseInterface({link: 'up'})).toMatchObject({role: null, activeMedium: ''});
});

it('rejects replies that are not an object', () => {
  expect(parseInterface(undefined)).toBeNull();
  expect(parseInterface([])).toBeNull();
});
