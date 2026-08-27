export interface ServiceInjector {
  get<T>(token: string | symbol): T | undefined;
  has(token: string | symbol): boolean;
}
