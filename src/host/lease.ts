import { readFileSync } from 'node:fs';

type Lease = {
  apiVersion?: string;
  kind?: string;
  metadata: { name: string; namespace?: string; resourceVersion?: string };
  spec: {
    holderIdentity?: string | null;
    leaseDurationSeconds?: number;
    acquireTime?: string;
    renewTime?: string;
    leaseTransitions?: number;
  };
};

export type LeaseOptions = {
  /** Kubernetes API base, such as https://kubernetes.default.svc. */
  apiUrl: string;
  namespace: string;
  name: string;
  /** This replica, usually the pod name. */
  identity: string;
  /** The service account token, read again for each request (projected tokens rotate). */
  token: () => string;
  durationSeconds?: number;
  renewSeconds?: number;
  fetch?: typeof fetch;
  log?: (message: string) => void;
};

/**
 * Leader election with a `coordination.k8s.io/v1` Lease, like client-go's: the
 * leader renews the lease; another replica takes it over once it was not
 * renewed for its duration. Updates carry the lease's resourceVersion, so two
 * replicas cannot both win.
 */
export class LeaseElector {
  private leader = false;
  private lastRenew = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private lost?: () => void;
  private stopped = false;
  private readonly duration: number;
  private readonly renew: number;
  private readonly path: string;

  constructor(private readonly options: LeaseOptions) {
    this.duration = options.durationSeconds ?? 15;
    this.renew = options.renewSeconds ?? 5;
    this.path = `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(options.namespace)}/leases`;
  }

  get isLeader() {
    return this.leader;
  }

  /** Resolves once this replica holds the lease; then keeps renewing it. `onLost` runs if it cannot. */
  async acquire(onLost: () => void) {
    this.lost = onLost;
    // API errors (for example while the cluster restarts) mean: not yet.
    while (!this.stopped && !(await this.tryAcquire().catch(() => false))) {
      await sleep(this.renew * 1000);
    }
    if (this.leader) {
      this.options.log?.(`lease ${this.options.name}: leader is ${this.options.identity}`);
      this.schedule();
    }
  }

  /** Gives the lease up, so another replica takes over at once instead of after its duration. */
  async release() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (!this.leader) {
      return;
    }
    this.leader = false;
    const lease = await this.get().catch(() => undefined);
    if (lease?.spec.holderIdentity === this.options.identity) {
      await this.put({
        ...lease,
        spec: { ...lease.spec, holderIdentity: null, leaseDurationSeconds: 1, renewTime: microTime(new Date()) },
      }).catch(() => undefined);
    }
  }

  private schedule() {
    this.timer = setTimeout(() => void this.renewLease(), this.renew * 1000);
  }

  private async renewLease() {
    if (this.stopped) {
      return;
    }
    if (await this.tryAcquire().catch(() => false)) {
      this.schedule();
      return;
    }
    if (Date.now() - this.lastRenew > this.duration * 1000) {
      // Another replica may hold the lease now: stop acting as the leader.
      this.leader = false;
      this.options.log?.(`lease ${this.options.name}: lost by ${this.options.identity}`);
      this.lost?.();
      return;
    }
    this.schedule();
  }

  private async tryAcquire(): Promise<boolean> {
    const now = new Date();
    const lease = await this.get();
    if (!lease) {
      const created = await this.request('POST', this.path, {
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: { name: this.options.name },
        spec: this.spec(now, now, 0),
      });
      return this.won(created.status === 201 || created.status === 200);
    }
    const holder = lease.spec.holderIdentity;
    const renewed = Date.parse(lease.spec.renewTime ?? '') || 0;
    const expired = renewed + (lease.spec.leaseDurationSeconds ?? this.duration) * 1000 < now.getTime();
    if (holder && holder !== this.options.identity && !expired) {
      this.leader = false;
      return false;
    }
    const takeover = holder !== this.options.identity;
    const acquired = takeover ? now : new Date(lease.spec.acquireTime ?? now);
    const transitions = (lease.spec.leaseTransitions ?? 0) + (takeover ? 1 : 0);
    const updated = await this.put({ ...lease, spec: this.spec(acquired, now, transitions) });
    return this.won(updated.ok);
  }

  private won(ok: boolean) {
    if (ok) {
      this.leader = true;
      this.lastRenew = Date.now();
    }
    return ok;
  }

  private spec(acquired: Date, renewed: Date, transitions: number): Lease['spec'] {
    return {
      holderIdentity: this.options.identity,
      leaseDurationSeconds: this.duration,
      acquireTime: microTime(acquired),
      renewTime: microTime(renewed),
      leaseTransitions: transitions,
    };
  }

  private async get(): Promise<Lease | undefined> {
    const response = await this.request('GET', `${this.path}/${encodeURIComponent(this.options.name)}`);
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`lease ${this.options.name}: GET failed with ${response.status}`);
    }
    return (await response.json()) as Lease;
  }

  /** A PUT with the lease's resourceVersion; a concurrent change answers 409. */
  private put(lease: Lease) {
    return this.request('PUT', `${this.path}/${encodeURIComponent(this.options.name)}`, lease);
  }

  private request(method: string, path: string, body?: unknown) {
    return (this.options.fetch ?? fetch)(`${this.options.apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.options.token()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

/** Kubernetes MicroTime: RFC 3339 with microseconds. */
function microTime(date: Date) {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The in-cluster API URL, namespace, and token of the pod's service account. */
export function inClusterConfig() {
  const dir = '/var/run/secrets/kubernetes.io/serviceaccount';
  return {
    apiUrl: `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? '443'}`,
    namespace: readFileSync(`${dir}/namespace`, 'utf8').trim(),
    token: () => readFileSync(`${dir}/token`, 'utf8').trim(),
  };
}

/** The label that marks the leader's pod; the Service selects it, so only the leader gets traffic. */
export const LEADER_LABEL = 'assistant-host/leader';

/** Sets or removes this pod's leader label (a JSON merge patch of its metadata). */
export async function labelPod(
  options: { apiUrl: string; namespace: string; token: () => string; pod: string; fetch?: typeof fetch },
  leader: boolean
) {
  const response = await (options.fetch ?? fetch)(
    `${options.apiUrl.replace(/\/$/, '')}/api/v1/namespaces/${encodeURIComponent(options.namespace)}/pods/${encodeURIComponent(options.pod)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${options.token()}`, 'Content-Type': 'application/merge-patch+json' },
      body: JSON.stringify({ metadata: { labels: { [LEADER_LABEL]: leader ? 'true' : null } } }),
    }
  );
  if (!response.ok) {
    throw new Error(`labeling pod ${options.pod} failed with ${response.status}`);
  }
}
