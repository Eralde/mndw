import {FetchTransport, RciManager, SessionManager} from '@rci-tools/core';
import {EMPTY, type Observable, Subscription, catchError, exhaustMap, tap, timer} from 'rxjs';

export const RCI_HEARTBEAT_INTERVAL_MS = 30_000;

const RCI_HEARTBEAT_QUERY = {path: 'show.system'} as const;

export class RciService {
  private readonly transport: FetchTransport;
  private heartbeatSubscription: Subscription | null = null;
  public readonly driver: RciManager;
  public readonly auth: SessionManager;

  constructor() {
    const host = window.location.origin;

    this.transport = new FetchTransport();
    this.auth = new SessionManager(host, this.transport);
    this.driver = new RciManager(host, this.transport);
  }

  public login(username: string, password: string): Observable<boolean> {
    return this.auth.login(username, password).pipe(
      tap((authenticated) => {
        if (authenticated) {
          this.startHeartbeat();
        } else {
          this.stopHeartbeat();
        }
      }),
    );
  }

  public logout(): Observable<unknown> {
    this.stopHeartbeat();

    return this.auth.logout();
  }

  public isAuthenticated(): Observable<boolean> {
    return this.auth.isAuthenticated().pipe(
      tap((authenticated) => {
        if (authenticated) {
          this.startHeartbeat();
        } else {
          this.stopHeartbeat();
        }
      }),
    );
  }

  public startHeartbeat(): void {
    if (this.heartbeatSubscription !== null) {
      return;
    }

    this.heartbeatSubscription = timer(0, RCI_HEARTBEAT_INTERVAL_MS).pipe(
      exhaustMap(() => this.driver.queue(RCI_HEARTBEAT_QUERY).pipe(catchError(() => EMPTY))),
    )
      .subscribe();
  }

  public stopHeartbeat(): void {
    this.heartbeatSubscription?.unsubscribe();
    this.heartbeatSubscription = null;
  }

  public get authError$(): Observable<void> {
    return this.transport.authError$.pipe(tap(() => this.stopHeartbeat()));
  }
}

export const rciService = new RciService();
