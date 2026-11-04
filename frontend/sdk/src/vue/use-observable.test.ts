import {Observable, Subject} from 'rxjs';
import {type Ref, effectScope} from 'vue';
import {describe, expect, it, vi} from 'vitest';

import {useObservable} from './use-observable.js';

describe('useObservable', () => {
  it('starts with the current value and follows the stream', () => {
    const source = new Subject<string>();
    const scope = effectScope();
    let result: Readonly<Ref<string>> | undefined;

    scope.run(() => {
      result = useObservable(source, 'initial');
    });

    expect(result?.value).toBe('initial');
    source.next('next');
    expect(result?.value).toBe('next');

    scope.stop();
  });

  it('unsubscribes when the effect scope stops', () => {
    const source = new Subject<number>();
    const onUnsubscribe = vi.fn();
    const observable = new Observable<number>((subscriber) => {
      const subscription = source.subscribe(subscriber);

      return () => {
        onUnsubscribe();
        subscription.unsubscribe();
      };
    });
    const scope = effectScope();

    scope.run(() => {
      useObservable(observable, 0);
    });

    expect(onUnsubscribe).not.toHaveBeenCalled();
    scope.stop();
    expect(onUnsubscribe).toHaveBeenCalledOnce();
  });
});
