// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {defineComponents, mount} from '../testing/index.js';
import {MNDW_SWITCHPORT_TAG, MndwSwitchport, type MndwSwitchportType} from './switchport.js';

defineComponents([MNDW_SWITCHPORT_TAG, MndwSwitchport]);

const part = (element: MndwSwitchport, name: string): Element | null =>
  element.shadowRoot?.querySelector(`[part="${name}"]`) ?? null;

const socketKinds = (element: MndwSwitchport): string[] =>
  [...(element.shadowRoot?.querySelectorAll('[part="socket"]') ?? [])].map((socket) =>
    socket.getAttribute('data-kind') ?? ''
  );

interface Bounds {
  readonly top: number;
  readonly bottom: number;
}

/** happy-dom has no SVG layout, so read the rendered outline's vertical geometry from its own attributes. */
const pathBounds = (d: string): Bounds => {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/gu) ?? [];
  let y = 0;
  let command = '';
  let index = 0;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  while (index < tokens.length) {
    const token = tokens[index] ?? '';

    if (/[A-Za-z]/u.test(token)) {
      command = token;
      index += 1;
      continue;
    }

    if (command === 'M' || command === 'L') {
      y = Number(tokens[index + 1]);
      index += 2;
    } else if (command === 'm' || command === 'l') {
      y += Number(tokens[index + 1]);
      index += 2;
    } else if (command === 'H' || command === 'h') {
      index += 1;
    } else if (command === 'V') {
      y = Number(token);
      index += 1;
    } else if (command === 'v') {
      y += Number(token);
      index += 1;
    } else {
      index += 1;
      continue;
    }

    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }

  return {top, bottom};
};

const outline = (element: MndwSwitchport, kind: MndwSwitchportType): Element => {
  const shape = element.shadowRoot?.querySelector(`[part="socket"][data-kind="${kind}"] [part="${kind}"]`);

  if (shape === null || shape === undefined) {
    throw new Error(`missing ${kind} outline`);
  }

  return shape;
};

const outlineBounds = (element: MndwSwitchport, kind: MndwSwitchportType): Bounds => {
  const shape = outline(element, kind);

  if (shape.hasAttribute('y')) {
    const top = Number(shape.getAttribute('y'));

    return {top, bottom: top + Number(shape.getAttribute('height'))};
  }

  return pathBounds(shape.getAttribute('d') ?? '');
};

describe('<mndw-switchport> sockets', () => {
  it.each(
    [
      ['ethernet', '5'],
      ['sfp', 'SFP'],
      ['dsl', '5'],
    ] as const,
  )('draws only the supplied label on the %s socket', async (type, label) => {
    const element = await mount(
      `<mndw-switchport type="${type}" label="${label}"></mndw-switchport>`,
      MNDW_SWITCHPORT_TAG,
    );
    const texts = [...(element.shadowRoot?.querySelectorAll('text') ?? [])];

    expect(socketKinds(element)).toEqual([type]);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.textContent).toBe(label);
    expect(part(element, 'tag')).toBeNull();
  });

  it('falls back to an Ethernet socket for an unknown type', async () => {
    const element = await mount('<mndw-switchport type="serial"></mndw-switchport>', MNDW_SWITCHPORT_TAG);

    expect(socketKinds(element)).toEqual(['ethernet']);
  });

  it.each(
    [
      ['blue', 'blue'],
      ['gray', 'gray'],
      ['orange', 'orange'],
      ['purple', 'gray'],
    ] as const,
  )('paints the Ethernet socket %s', async (color, expected) => {
    const element = await mount(`<mndw-switchport color="${color}"></mndw-switchport>`, MNDW_SWITCHPORT_TAG);

    expect(part(element, 'ethernet')?.getAttribute('data-color')).toBe(expected);
  });

  it('rotates only the socket shape when reversed', async () => {
    const element = await mount('<mndw-switchport reversed label="0" link></mndw-switchport>', MNDW_SWITCHPORT_TAG);
    const shape = part(element, 'ethernet');

    expect(shape?.closest('[transform]')?.getAttribute('transform')).toMatch(/^rotate\(180 /u);
    expect(part(element, 'led')?.closest('[transform]')).toBeNull();
    expect(part(element, 'label')?.closest('[transform]')).toBeNull();
  });
});

describe('<mndw-switchport> socket geometry', () => {
  const types: readonly MndwSwitchportType[] = ['ethernet', 'sfp', 'dsl'];

  it.each(types)('draws the %s socket between the shared top and bottom', async (type) => {
    const element = await mount(`<mndw-switchport type="${type}"></mndw-switchport>`, MNDW_SWITCHPORT_TAG);

    expect(outlineBounds(element, type)).toEqual({top: 7, bottom: 46});
  });

  it.each(['ethernet-sfp', 'sfp-ethernet'] as const)('aligns both sockets of the %s combo', async (combo) => {
    const element = await mount(`<mndw-switchport combo="${combo}"></mndw-switchport>`, MNDW_SWITCHPORT_TAG);

    for (const type of socketKinds(element) as MndwSwitchportType[]) {
      expect(outlineBounds(element, type), type).toEqual({top: 7, bottom: 46});
    }
  });

  it.each([false, true])('draws every label on one baseline (reversed: %s)', async (reversed) => {
    const baselines = new Set<number>();

    for (const type of types) {
      const element = await mount(
        `<mndw-switchport type="${type}" label="0"${reversed ? ' reversed' : ''}></mndw-switchport>`,
        MNDW_SWITCHPORT_TAG,
      );

      baselines.add(Number(part(element, 'label')?.getAttribute('y')));
    }

    expect([...baselines]).toEqual([reversed ? 29 : 34]);
  });

  it('keeps the LED on one line above every socket', async () => {
    const markups = [
      'type="ethernet"',
      'type="sfp"',
      'type="dsl"',
      'combo="ethernet-sfp" active="ethernet"',
      'combo="sfp-ethernet" active="sfp"',
    ];

    for (const markup of markups) {
      const element = await mount(`<mndw-switchport ${markup} link></mndw-switchport>`, MNDW_SWITCHPORT_TAG);
      const led = part(element, 'led');
      const ledTop = Number(led?.getAttribute('y'));
      const ledBottom = ledTop + Number(led?.getAttribute('height'));

      expect(ledTop, markup).toBe(1);

      for (const type of socketKinds(element) as MndwSwitchportType[]) {
        expect(ledBottom, markup).toBeLessThan(outlineBounds(element, type).top);
      }
    }
  });
});

describe('<mndw-switchport> combos', () => {
  it.each(
    [
      ['ethernet-sfp', 'ethernet', ['ethernet', 'sfp'], 25],
      ['ethernet-sfp', 'sfp', ['ethernet', 'sfp'], 85],
      ['sfp-ethernet', 'ethernet', ['sfp', 'ethernet'], 85],
      ['sfp-ethernet', 'sfp', ['sfp', 'ethernet'], 25],
    ] as const,
  )('orders %s with %s active', async (combo, active, kinds, ledX) => {
    const element = await mount(
      `<mndw-switchport combo="${combo}" active="${active}" link></mndw-switchport>`,
      MNDW_SWITCHPORT_TAG,
    );

    expect(socketKinds(element)).toEqual(kinds);

    for (const kind of kinds) {
      const socket = element.shadowRoot?.querySelector(`[part="socket"][data-kind="${kind}"]`);

      expect(socket?.hasAttribute('data-dim'), kind).toBe(kind !== active);
    }

    expect(part(element, 'led')?.getAttribute('x')).toBe(String(ledX));
    expect(part(element, 'led')?.getAttribute('data-on')).toBe('true');
  });

  it.each(['', 'dsl'])('dims both sockets without a valid active medium ("%s")', async (active) => {
    const element = await mount(
      `<mndw-switchport combo="ethernet-sfp" active="${active}" link></mndw-switchport>`,
      MNDW_SWITCHPORT_TAG,
    );

    expect(element.shadowRoot?.querySelectorAll('[part="socket"][data-dim]')).toHaveLength(2);
    expect(part(element, 'led')).toBeNull();
  });

  it('ignores active outside a combo', async () => {
    const element = await mount('<mndw-switchport active="sfp" link></mndw-switchport>', MNDW_SWITCHPORT_TAG);

    expect(socketKinds(element)).toEqual(['ethernet']);
    expect(element.shadowRoot?.querySelectorAll('[data-dim]')).toHaveLength(0);
    expect(part(element, 'led')?.getAttribute('data-on')).toBe('true');
  });

  it('falls back to a single socket for an unknown combo', async () => {
    const element = await mount('<mndw-switchport combo="qsfp"></mndw-switchport>', MNDW_SWITCHPORT_TAG);

    expect(socketKinds(element)).toEqual(['ethernet']);
  });
});

describe('<mndw-switchport> combo chrome', () => {
  it('keeps one label in a combo, inside the Ethernet socket', async () => {
    const element = await mount(
      '<mndw-switchport combo="sfp-ethernet" active="sfp" label="5"></mndw-switchport>',
      MNDW_SWITCHPORT_TAG,
    );

    expect(element.shadowRoot?.querySelectorAll('[part="label"]')).toHaveLength(1);

    const socket = part(element, 'label')?.closest('[data-kind]');

    expect(socket?.getAttribute('data-kind')).toBe('ethernet');
    expect(element.shadowRoot?.querySelector('[part="socket"][data-kind="sfp"] text')).toBeNull();
  });

  it('dims only the socket shape, keeping the port label readable', async () => {
    const element = await mount(
      '<mndw-switchport combo="ethernet-sfp" active="sfp" label="0"></mndw-switchport>',
      MNDW_SWITCHPORT_TAG,
    );
    const ethernet = element.shadowRoot?.querySelector('[part="socket"][data-kind="ethernet"]');

    expect(ethernet?.hasAttribute('data-dim')).toBe(true);
    expect(ethernet?.querySelector('.socket-shape')).not.toBeNull();
    expect(part(element, 'label')?.closest('.socket-shape')).toBeNull();
  });

  it('keeps the combo LED above the frame and inside the art box', async () => {
    const element = await mount(
      '<mndw-switchport combo="ethernet-sfp" active="ethernet" link></mndw-switchport>',
      MNDW_SWITCHPORT_TAG,
    );
    const led = part(element, 'led');
    const ledY = Number(led?.getAttribute('y'));
    const ledBottom = ledY + Number(led?.getAttribute('height'));

    expect(ledY).toBeGreaterThan(0);
    expect(ledBottom).toBeLessThan(Number(part(element, 'frame')?.getAttribute('y')));
  });
});

describe('<mndw-switchport> defaults and reflection', () => {
  it('starts as a gray Ethernet socket without a combo', async () => {
    const element = await mount('<mndw-switchport></mndw-switchport>', MNDW_SWITCHPORT_TAG);

    expect([element.type, element.color, element.combo, element.active, element.label, element.portRole]).toEqual([
      'ethernet',
      'gray',
      'none',
      '',
      '',
      '',
    ]);
    expect([element.reversed, element.link, element.selected, element.disabled]).toEqual([false, false, false, false]);
  });

  it('reflects every property and hides the host from assistive technology', async () => {
    const element = await mount(
      '<mndw-switchport type="sfp" color="blue" label="5" reversed combo="sfp-ethernet"'
        + ' active="sfp" link port-role="inet" selected disabled></mndw-switchport>',
      MNDW_SWITCHPORT_TAG,
    );

    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(element.hasAttribute('role')).toBe(false);

    for (
      const [name, value] of Object.entries({
        'type': 'sfp',
        'color': 'blue',
        'label': '5',
        'reversed': '',
        'combo': 'sfp-ethernet',
        'active': 'sfp',
        'link': '',
        'port-role': 'inet',
        'selected': '',
        'disabled': '',
      })
    ) {
      expect(element.getAttribute(name), name).toBe(value);
    }
  });
});

describe('<mndw-switchport> visual states', () => {
  it('lights the LED only while link is set', async () => {
    const element = await mount('<mndw-switchport></mndw-switchport>', MNDW_SWITCHPORT_TAG);

    expect(part(element, 'led')?.getAttribute('data-on')).toBe('false');

    element.link = true;
    await element.updateComplete;

    expect(part(element, 'led')?.getAttribute('data-on')).toBe('true');
  });

  it('shows the globe badge only for the inet port role', async () => {
    const element = await mount('<mndw-switchport port-role="inet"></mndw-switchport>', MNDW_SWITCHPORT_TAG);

    expect(part(element, 'globe')).not.toBeNull();

    element.portRole = 'lan';
    await element.updateComplete;

    expect(part(element, 'globe')).toBeNull();
  });

  it('draws the selected outline only when selected', async () => {
    const element = await mount('<mndw-switchport></mndw-switchport>', MNDW_SWITCHPORT_TAG);

    expect(part(element, 'selected')).toBeNull();

    element.selected = true;
    await element.updateComplete;

    expect(part(element, 'selected')).not.toBeNull();
  });

  it('dims the art while disabled', async () => {
    const element = await mount('<mndw-switchport disabled></mndw-switchport>', MNDW_SWITCHPORT_TAG);

    expect(part(element, 'port')?.hasAttribute('data-disabled')).toBe(true);

    element.disabled = false;
    await element.updateComplete;

    expect(part(element, 'port')?.hasAttribute('data-disabled')).toBe(false);
  });
});
