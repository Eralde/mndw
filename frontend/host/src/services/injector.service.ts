import type {ServiceInjector} from '@mndw/sdk';

export class ServiceInjectorImpl implements ServiceInjector {
  private services = new Map<string | symbol, unknown>();

  public register<T>(token: string | symbol, service: T): void {
    this.services.set(token, service);
  }

  public get<T>(token: string | symbol): T | undefined {
    return this.services.get(token) as T | undefined;
  }

  public has(token: string | symbol): boolean {
    return this.services.has(token);
  }
}

export const injector = new ServiceInjectorImpl();
