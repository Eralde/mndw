import {FetchTransport, RciManager, SessionManager} from '@rci-tools/core';
import type {Observable} from 'rxjs';

export class RciService {
  private readonly transport: FetchTransport;
  public readonly driver: RciManager;
  public readonly auth: SessionManager;

  constructor() {
    const host = window.location.origin;

    this.transport = new FetchTransport();
    this.auth = new SessionManager(host, this.transport);
    this.driver = new RciManager(host, this.transport);
  }

  public login(username: string, password: string): Observable<boolean> {
    return this.auth.login(username, password);
  }

  public logout(): Observable<unknown> {
    return this.auth.logout();
  }

  public isAuthenticated(): Observable<boolean> {
    return this.auth.isAuthenticated();
  }

  public get authError$(): Observable<void> {
    return this.transport.authError$;
  }
}

export const rciService = new RciService();
