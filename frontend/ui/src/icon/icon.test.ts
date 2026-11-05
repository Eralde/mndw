// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {defineMndwUi} from '../index.js';
import {defineComponents, mount} from '../testing/index.js';
import {MNDW_ICON_TAG, MndwIcon} from './icon.js';
import {getIconSpriteUrl, setIconSpriteUrl} from './sprite-config.js';

const SPRITE_URL = '/assets/icons.svg';

defineComponents([MNDW_ICON_TAG, MndwIcon]);

function useEl(icon: MndwIcon): SVGUseElement | null {
  return icon.shadowRoot?.querySelector('use') ?? null;
}

function svgEl(icon: MndwIcon): SVGElement | null {
  return icon.shadowRoot?.querySelector('svg') ?? null;
}

afterEach(() => {
  setIconSpriteUrl('');
});

describe('<mndw-icon> rendering', () => {
  it('exposes the documented defaults', async () => {
    const icon = await mount('<mndw-icon></mndw-icon>', MNDW_ICON_TAG);

    expect(icon.name).toBe('');
    expect(icon.label).toBe('');
  });

  it('reflects name and label so framework property assignment is observable', async () => {
    const icon = await mount('<mndw-icon></mndw-icon>', MNDW_ICON_TAG);

    icon.name = 'settings';
    icon.label = 'Settings';
    await icon.updateComplete;

    expect(icon.getAttribute('name')).toBe('settings');
    expect(icon.getAttribute('label')).toBe('Settings');
  });

  it('renders as a typed element from the tag name map', () => {
    const icon = document.createElement('mndw-icon');

    expect(icon).toBeInstanceOf(MndwIcon);
  });

  it('renders a decorative SVG for a named icon', async () => {
    setIconSpriteUrl(SPRITE_URL);

    const icon = await mount('<mndw-icon name="settings"></mndw-icon>', MNDW_ICON_TAG);

    expect(useEl(icon)?.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(useEl(icon)?.getAttribute('href')).toBe(`${SPRITE_URL}#mndw-icon-settings`);
    expect(svgEl(icon)?.getAttribute('aria-hidden')).toBe('true');
    expect(svgEl(icon)?.hasAttribute('aria-label')).toBe(false);
    expect(svgEl(icon)?.getAttribute('role')).toBe('img');
    expect(svgEl(icon)?.getAttribute('part')).toBe('svg');
    expect(svgEl(icon)?.hasAttribute('tabindex')).toBe(false);
  });

  it('swaps aria-hidden for a label without touching the host', async () => {
    setIconSpriteUrl(SPRITE_URL);

    const icon = await mount('<mndw-icon name="info" label="Information"></mndw-icon>', MNDW_ICON_TAG);

    expect(svgEl(icon)?.getAttribute('aria-label')).toBe('Information');
    expect(svgEl(icon)?.hasAttribute('aria-hidden')).toBe(false);
    expect(icon.hasAttribute('aria-label')).toBe(false);

    icon.label = '';
    await icon.updateComplete;

    expect(svgEl(icon)?.hasAttribute('aria-label')).toBe(false);
    expect(svgEl(icon)?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders no use element for unknown or empty names', async () => {
    setIconSpriteUrl(SPRITE_URL);

    const unknown = await mount('<mndw-icon name="not-an-icon"></mndw-icon>', MNDW_ICON_TAG);
    const empty = await mount('<mndw-icon></mndw-icon>', MNDW_ICON_TAG);

    expect(useEl(unknown)).toBeNull();
    expect(useEl(empty)).toBeNull();
    expect(svgEl(unknown)).not.toBeNull();
    expect(svgEl(empty)).not.toBeNull();
  });

  it('renders no use element when the sprite URL is missing', async () => {
    const icon = await mount('<mndw-icon name="settings"></mndw-icon>', MNDW_ICON_TAG);

    expect(useEl(icon)).toBeNull();
    expect(svgEl(icon)).not.toBeNull();
  });

  it('reacts to name changes', async () => {
    setIconSpriteUrl(SPRITE_URL);

    const icon = await mount('<mndw-icon name="eye"></mndw-icon>', MNDW_ICON_TAG);

    expect(useEl(icon)?.getAttribute('href')).toBe(`${SPRITE_URL}#mndw-icon-eye`);

    icon.name = 'eye-off';
    await icon.updateComplete;

    expect(useEl(icon)?.getAttribute('href')).toBe(`${SPRITE_URL}#mndw-icon-eye-off`);

    icon.setAttribute('name', 'nope');
    await icon.updateComplete;

    expect(useEl(icon)).toBeNull();
  });

  it('refreshes connected icons when the URL is reconfigured', async () => {
    setIconSpriteUrl(SPRITE_URL);

    const icon = await mount('<mndw-icon name="search"></mndw-icon>', MNDW_ICON_TAG);

    setIconSpriteUrl('/assets/second.svg');
    await icon.updateComplete;

    expect(useEl(icon)?.getAttribute('href')).toBe('/assets/second.svg#mndw-icon-search');

    setIconSpriteUrl('');
    await icon.updateComplete;

    expect(useEl(icon)).toBeNull();
  });

  it('resubscribes after disconnect and reconnect', async () => {
    const icon = await mount('<mndw-icon name="menu"></mndw-icon>', MNDW_ICON_TAG);

    icon.remove();

    setIconSpriteUrl(SPRITE_URL);
    await icon.updateComplete;
    expect(useEl(icon)).toBeNull();

    document.body.append(icon);
    await icon.updateComplete;
    expect(useEl(icon)?.getAttribute('href')).toBe(`${SPRITE_URL}#mndw-icon-menu`);

    setIconSpriteUrl('/assets/third.svg');
    await icon.updateComplete;
    expect(useEl(icon)?.getAttribute('href')).toBe('/assets/third.svg#mndw-icon-menu');
    icon.remove();
  });

  it('does not leak subscriptions after disconnection', async () => {
    setIconSpriteUrl(SPRITE_URL);

    const icon = await mount('<mndw-icon name="x"></mndw-icon>', MNDW_ICON_TAG);

    icon.remove();

    setIconSpriteUrl('/assets/fourth.svg');
    await icon.updateComplete;

    expect(useEl(icon)?.getAttribute('href')).toBe(`${SPRITE_URL}#mndw-icon-x`);
  });
});

describe('icon registration', () => {
  it('accepts the sprite URL through defineMndwUi and keeps it on repeat calls', () => {
    defineMndwUi({iconSpriteUrl: SPRITE_URL});
    expect(document.createElement('mndw-icon')).toBeInstanceOf(MndwIcon);

    defineMndwUi();
    expect(getIconSpriteUrl()).toBe(SPRITE_URL);
  });

  it('reconfigures already-defined elements on a later call', async () => {
    defineMndwUi({iconSpriteUrl: SPRITE_URL});

    const icon = await mount('<mndw-icon name="check"></mndw-icon>', MNDW_ICON_TAG);

    expect(useEl(icon)?.getAttribute('href')).toBe(`${SPRITE_URL}#mndw-icon-check`);

    defineMndwUi({iconSpriteUrl: '/assets/fifth.svg'});
    await icon.updateComplete;
    expect(useEl(icon)?.getAttribute('href')).toBe('/assets/fifth.svg#mndw-icon-check');
  });
});
