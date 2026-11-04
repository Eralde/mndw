import type {Observable} from 'rxjs';
import {type Ref, onScopeDispose, shallowReadonly, shallowRef} from 'vue';
import type {PluginContext} from '../context.js';
import type {MndwThemeName} from '../tokens.js';

export function useObservable<T>(source: Observable<T>, initial: T): Readonly<Ref<T>> {
  const value = shallowRef(initial);
  const subscription = source.subscribe((next) => {
    value.value = next;
  });

  onScopeDispose(() => subscription.unsubscribe());

  return shallowReadonly(value);
}

export function useTheme(context: Pick<PluginContext, 'theme' | 'theme$'>): Readonly<Ref<MndwThemeName>> {
  return useObservable(context.theme$, context.theme);
}

export function useLocale(context: Pick<PluginContext, 'locale' | 'locale$'>): Readonly<Ref<string>> {
  return useObservable(context.locale$, context.locale);
}
