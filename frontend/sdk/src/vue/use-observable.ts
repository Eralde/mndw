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

export function useTheme(context: Pick<PluginContext, 'appearance'>): Readonly<Ref<MndwThemeName>> {
  return useObservable(context.appearance.theme$, context.appearance.theme);
}

export function useLocale(context: Pick<PluginContext, 'i18n'>): Readonly<Ref<string>> {
  return useObservable(context.i18n.locale$, context.i18n.locale);
}
