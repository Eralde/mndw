import type {
  OverlayCloseReason,
  OverlayLayer,
  OverlayLayerOptions,
  OverlayOpenOptions,
  OverlayService,
  OverlaySession,
} from '@mndw/sdk';
import {describe, expect, it, vi} from 'vitest';
import {adaptOverlayService} from './overlay-adapter.js';

function fakeService(reason: OverlayCloseReason = 'api'): {
  service: OverlayService;
  calls: OverlayLayerOptions[];
  openCalls: OverlayOpenOptions[];
  update: ReturnType<typeof vi.fn>;
  markReady: ReturnType<typeof vi.fn>;
} {
  const calls: OverlayLayerOptions[] = [];
  const openCalls: OverlayOpenOptions[] = [];
  const update = vi.fn();
  const markReady = vi.fn();
  const service = {
    createLayer(options: OverlayLayerOptions): OverlayLayer {
      calls.push(options);

      const contentElement = document.createElement('div');

      return {
        contentElement,
        closed: Promise.resolve({reason}),
        close: vi.fn(),
        markReady,
        update,
      } as unknown as OverlayLayer;
    },
    open(options: OverlayOpenOptions): OverlaySession {
      openCalls.push(options);

      const contentElement = document.createElement('div');

      const session: OverlaySession = {
        contentElement,
        closed: Promise.resolve({reason}),
        close: vi.fn(),
        update,
      } as unknown as OverlaySession;

      void options.mount(contentElement, session, new AbortController().signal);

      return session;
    },
  } as unknown as OverlayService;

  return {service, calls, openCalls, update, markReady};
}

describe('adaptOverlayService', () => {
  it('requests an anchored popover layer', () => {
    const {service, calls} = fakeService();
    const anchor = document.createElement('button');

    adaptOverlayService(service).open({anchor});

    expect(calls[0].kind).toBe('popover');
    expect(calls[0].anchor?.element).toBe(anchor);
    expect(calls[0].placement).toBe('bottom-start');
  });

  it('enables escape and outside-click dismissal', () => {
    const {service, calls} = fakeService();

    adaptOverlayService(service).open({anchor: document.createElement('button')});

    expect(calls[0].closeOnEscape).toBe(true);
    expect(calls[0].closeOnOutsideClick).toBe(true);
  });

  it('forwards className but not select sizing', () => {
    const {service, calls} = fakeService();

    adaptOverlayService(service).open({anchor: document.createElement('button'), className: 'demo'});

    expect(calls[0]).toHaveProperty('className', 'demo');
    expect(calls[0]).not.toHaveProperty('maxHeight');
  });

  it('marks the layer ready so it leaves the opening state', () => {
    const {service, markReady} = fakeService();

    adaptOverlayService(service).open({anchor: document.createElement('button')});

    expect(markReady).toHaveBeenCalledTimes(1);
  });

  it('forwards trapFocus and restoreFocus when supplied', () => {
    const {service, calls} = fakeService();

    adaptOverlayService(service).open({anchor: document.createElement('button'), trapFocus: false,
      restoreFocus: false});

    expect(calls[0].trapFocus).toBe(false);
    expect(calls[0].restoreFocus).toBe(false);
  });

  it('omits trapFocus and restoreFocus when not supplied', () => {
    const {service, calls} = fakeService();

    adaptOverlayService(service).open({anchor: document.createElement('button')});

    expect(calls[0].trapFocus).toBeUndefined();
    expect(calls[0].restoreFocus).toBeUndefined();
  });

  it('repositions by re-supplying the anchor through update()', () => {
    const {service, update} = fakeService();
    const anchor = document.createElement('button');
    const layer = adaptOverlayService(service).open({anchor});

    layer.reposition();

    expect(update).toHaveBeenCalledWith({anchor: {element: anchor}});
  });

  it('requests an explicitly sized bottom sheet session', () => {
    const {service, calls, openCalls, update} = fakeService();
    const anchor = document.createElement('button');

    const layer = adaptOverlayService(service).open({
      anchor,
      presentation: 'sheet',
      title: 'Interface',
      className: 'demo',
    });

    expect(calls).toHaveLength(0);
    expect(openCalls[0]).toMatchObject({
      kind: 'drawer',
      placement: 'bottom',
      title: 'Interface',
      showCloseButton: true,
      lockScroll: true,
      trapFocus: true,
      width: '100%',
      height: 'auto',
      maxHeight: '100dvh',
      className: 'mndw-ui-select-sheet demo',
    });
    expect(layer.contentElement.style.height).toBe('');
    expect(layer.contentElement.style.minHeight).toBe('0');

    layer.reposition();

    expect(update).not.toHaveBeenCalled();
  });

  it('keeps popover behavior when presentation is omitted', () => {
    const {service, calls, openCalls} = fakeService();

    adaptOverlayService(service).open({anchor: document.createElement('button')});

    expect(calls).toHaveLength(1);
    expect(openCalls).toHaveLength(0);
  });
});

describe('adaptOverlayService close-reason mapping', () => {
  const cases: [OverlayCloseReason, string][] = [
    ['escape', 'escape'],
    ['outside-click', 'outside'],
    ['api', 'api'],
    ['action', 'api'],
    ['anchor-lost', 'api'],
    ['mount-failed', 'api'],
    ['host-navigation', 'detached'],
    ['plugin-unmount', 'detached'],
    ['replaced', 'detached'],
  ];

  for (const [hostReason, uiReason] of cases) {
    it(`maps ${hostReason} to ${uiReason}`, async () => {
      const {service} = fakeService(hostReason);
      const layer = adaptOverlayService(service).open({anchor: document.createElement('button')});

      await expect(layer.closed).resolves.toBe(uiReason);
    });
  }
});
