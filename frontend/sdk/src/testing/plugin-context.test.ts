import {Subject, of} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import type {MndwEvent} from '../event-schema.js';
import {createTestI18n} from './i18n.js';
import {createTestPluginContext} from './plugin-context.js';

describe('createTestPluginContext', () => {
  it('records toast calls and handle dismissals', () => {
    const fixture = createTestPluginContext();
    const handle = fixture.context.toast.error('failed', {key: 'request'});

    handle.dismiss();
    fixture.context.toast.dismiss('request');

    expect(fixture.toastCalls).toMatchObject([
      {type: 'error', message: 'failed', options: {key: 'request'}, handleId: 1},
      {type: 'handle.dismiss', handleId: 1},
      {type: 'dismiss', key: 'request'},
    ]);
  });

  it('aborts its signal when the fixture unmounts', () => {
    const fixture = createTestPluginContext();

    expect(fixture.context.signal).toBeInstanceOf(AbortSignal);
    expect(fixture.context.signal.aborted).toBe(false);

    fixture.unmount();

    expect(fixture.context.signal.aborted).toBe(true);
    expect(fixture.context.signal.reason).toBeInstanceOf(DOMException);
    expect(fixture.context.signal.reason).toMatchObject({name: 'AbortError'});
  });

  it('implements query from a queue-only RCI override', async () => {
    const response = {version: '1'};
    const fixture = createTestPluginContext({device: {rci: {queue: () => of(response) as never}}});

    await expect(fixture.context.device.rci.query({path: 'show.version'})).resolves.toBe(response);
  });

  it('updates theme getters and streams', () => {
    const fixture = createTestPluginContext();
    const seen: string[] = [];

    fixture.context.appearance.theme$.subscribe((theme) => seen.push(theme));
    fixture.setTheme('dark');

    expect(fixture.context.appearance.theme).toBe('dark');
    expect(seen).toEqual(['light', 'dark']);
  });

  it('updates fixture i18n when setLocale changes the default i18n', () => {
    const fixture = createTestPluginContext();
    const seen: string[] = [];

    fixture.context.i18n.locale$.subscribe((locale) => seen.push(locale));
    fixture.setLocale('ru');

    expect(fixture.context.i18n.locale).toBe('ru');
    expect(seen).toEqual(['en', 'ru']);
  });

  it('leaves caller-supplied i18n under caller control', () => {
    const i18n = createTestI18n({}, 'en');
    const fixture = createTestPluginContext({i18n});

    fixture.setLocale('ru');

    expect('locale' in fixture.context).toBe(false);
    expect(fixture.context.i18n.locale).toBe('en');
  });

  it('uses a preset answer for overlay confirmations', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const fixture = createTestPluginContext({overlay: {confirm}});
    const options = {title: 'Remove package?', danger: true};

    await expect(fixture.context.overlay.confirm(options)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(options);
  });

  it('keeps overlay methods unconfigured except for the injected confirm fake', async () => {
    const fixture = createTestPluginContext({overlay: {confirm: () => Promise.resolve(false)}});

    await expect(fixture.context.overlay.confirm({title: 'Continue?'})).resolves.toBe(false);
    expect(() => fixture.context.overlay.closeAll()).toThrow('test overlay.closeAll not configured');
  });

  it('completes streams on unmount', () => {
    const fixture = createTestPluginContext();
    let completeCount = 0;

    fixture.context.appearance.theme$.subscribe({complete: () => completeCount += 1});
    fixture.unmount();

    expect(completeCount).toBe(1);
  });

  it('drives telemetry.gathering$ from the telemetry test option and completes on unmount', () => {
    const gathering = new Subject<{enabled: boolean}>();
    const fixture = createTestPluginContext({telemetry: {gathering$: gathering.asObservable()}});
    const values: boolean[] = [];
    let completeCount = 0;

    fixture.context.telemetry.gathering$.subscribe({
      next: ({enabled}) => values.push(enabled),
      complete: () => completeCount += 1,
    });
    gathering.next({enabled: true});

    expect(values).toEqual([true]);
    fixture.unmount();

    expect(completeCount).toBe(1);
  });

  it('does not emit telemetry gathering state by default', () => {
    const fixture = createTestPluginContext();
    const values: boolean[] = [];

    fixture.context.telemetry.gathering$.subscribe(({enabled}) => values.push(enabled));
    fixture.unmount();

    expect(values).toEqual([]);
  });

  it('always exposes event streams and controls them through the fixture', () => {
    const withoutEvents = createTestPluginContext();
    const fixture = createTestPluginContext({events: true});
    const receivedTopics: string[] = [];
    const denied = [] as unknown[];
    let noCapabilityResyncComplete = 0;
    let resyncCount = 0;
    let eventsComplete = 0;
    let resyncComplete = 0;

    expect(withoutEvents.context.events).toBeDefined();
    expect(withoutEvents.context.events.select$('plugin').subscribe({error: (error) => denied.push(error)}))
      .toBeDefined();
    expect(denied).toHaveLength(1);
    withoutEvents.context.events.resync$.subscribe({complete: () => noCapabilityResyncComplete += 1});
    expect(noCapabilityResyncComplete).toBe(1);
    fixture.context.events.select$('plugin').subscribe({
      next: (event) => receivedTopics.push(event.topic),
      complete: () => eventsComplete += 1,
    });
    fixture.context.events.resync$.subscribe({
      next: () => resyncCount += 1,
      complete: () => resyncComplete += 1,
    });
    fixture.emitEvent({
      id: '01J5KZ00000000000000000000',
      ts: 1725552000123,
      topic: 'plugin.started',
      source: 'internal',
      payload: {name: 'demo'},
    });
    fixture.emitEvent({
      id: '01J5KZ00000000000000000001',
      ts: 1725552000123,
      topic: 'wan.disconnected',
      source: 'hook',
      payload: {interface: 'wan0'},
    });
    fixture.resync();

    expect(receivedTopics).toEqual(['plugin.started']);
    expect(resyncCount).toBe(1);

    fixture.unmount();

    expect(eventsComplete).toBe(1);
    expect(resyncComplete).toBe(1);
  });

  it('deep-freezes events emitted through the test fixture', () => {
    const fixture = createTestPluginContext({events: true});
    const mutationErrors: unknown[] = [];
    const event: MndwEvent = {
      id: '01J5KZ00000000000000000000',
      ts: 1725552000123,
      topic: 'net.dns_changed',
      source: 'log',
      payload: {resolvers: ['1.1.1.1']},
    };

    fixture.context.events.select$('net').subscribe((received) => {
      const mutable = received as unknown as {topic: string; payload: {resolvers: string[]}};

      try {
        mutable.payload.resolvers[0] = '9.9.9.9';
      } catch (error) {
        mutationErrors.push(error);
      }

      try {
        mutable.topic = 'plugin.started';
      } catch (error) {
        mutationErrors.push(error);
      }
    });

    fixture.emitEvent(event);

    expect(mutationErrors).toHaveLength(2);
    expect(mutationErrors.every((error) => error instanceof TypeError)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);

    if (event.topic === 'net.dns_changed') {
      expect(event.payload.resolvers).toEqual(['1.1.1.1']);
      expect(Object.isFrozen(event.payload.resolvers)).toBe(true);
    }
  });

  it('provides a widget title recorder by default and omits it from page contexts', () => {
    const widget = createTestPluginContext();
    const page = createTestPluginContext({kind: 'page'});

    widget.context.setTileTitle('Demo title');

    expect(widget.tileTitles).toEqual(['Demo title']);
    expect('setTileTitle' in page.context).toBe(false);
  });

  it('provides manual tickers and destroys them when the fixture unmounts', () => {
    const fixture = createTestPluginContext();
    const ticks: number[] = [];
    let completeCount = 0;
    const ticker = fixture.context.timers.createTicker();

    ticker.tick$.subscribe({
      next: (tick) => ticks.push(tick.timestamp),
      complete: () => completeCount += 1,
    });
    fixture.tick(100);
    ticker.start(1000);
    fixture.tick(200);
    ticker.stop();
    fixture.tick(300);
    ticker.start(500);
    fixture.tick(400);

    expect(ticks).toEqual([200, 400]);

    fixture.unmount();
    fixture.tick(500);
    ticker.start(250);

    expect(completeCount).toBe(1);
    expect(ticks).toEqual([200, 400]);
  });

  it('aborts refresh loads and prevents restarting loops when the fixture unmounts', async () => {
    const fixture = createTestPluginContext();
    let loadSignal: AbortSignal | undefined;
    let release: (value: string) => void = () => {};
    let loadCount = 0;
    let successCount = 0;
    const loop = fixture.context.timers.createRefreshLoop({
      load: (signal) => {
        loadCount += 1;
        loadSignal = signal;

        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
      intervalMs: 1000,
      onSuccess: () => successCount += 1,
      onError: () => {},
    });

    loop.start();
    fixture.unmount();

    expect(loadSignal?.aborted).toBe(true);
    release('late');
    await Promise.resolve();
    await Promise.resolve();
    loop.start();
    await Promise.resolve();

    expect(loadCount).toBe(1);
    expect(successCount).toBe(0);
  });

  it('freezes the grouped context objects and omits replaced top-level members', () => {
    const fixture = createTestPluginContext();
    const {context} = fixture;

    expect(Object.getPrototypeOf(context)).toBeNull();
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.storage)).toBe(true);
    expect(Object.isFrozen(context.appearance)).toBe(true);
    expect(Object.isFrozen(context.device)).toBe(true);
    expect(Object.isFrozen(context.timers)).toBe(true);
    expect('sharedStorage' in context).toBe(false);
    expect('deviceInfo' in context).toBe(false);
    expect('rciManager' in context).toBe(false);
    expect('createTicker' in context).toBe(false);
    expect('theme' in context).toBe(false);
    expect('palette' in context).toBe(false);
    expect('locale' in context).toBe(false);
  });

  it('provides a page route for page contexts', () => {
    const fixture = createTestPluginContext({kind: 'page'});

    expect(fixture.context.kind).toBe('page');
    expect(fixture.context.pageRoute).toBeDefined();
  });

  it('provides a navigation test double that records calls and accepts navigation', () => {
    const fixture = createTestPluginContext();
    const target = {kind: 'settings', tab: 'general'} as const;

    expect(fixture.context.navigation.navigate(target)).toBe(true);
    expect(fixture.navigationCalls).toEqual([target]);
  });
});
