# Running the assistant host on Kubernetes

Implemented 2026-10-04. The [assistant host](mattermost.md) runs active/standby:
one leader is connected to the chat platforms and handles webhooks, and a
standby takes over when the leader stops. The Helm chart is in
`deploy/helm/assistant-host`.

## How it works

| Concern     | How                                                                                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One leader  | A `coordination.k8s.io/v1` Lease (`src/host/lease.ts`), renewed every 5 s with a 15 s duration. Updates carry the Lease's `resourceVersion`, so two replicas cannot both win. A replica that cannot renew for the duration stops and restarts as a standby.                                                    |
| Traffic     | The leader labels its own pod `assistant-host/leader=true`, and the Service selects that label: Grafana and Webex webhooks reach only the leader. Each replica removes its label at start, on shutdown, and when it loses the Lease. Readiness means "initialized", so rolling updates proceed with a standby. |
| State       | Threads, alert episodes, and pending runs are a versioned document in the plugin backend (`/host-state/{key}`, chat database schema version 4) instead of a file. Every write names the version it replaces; a write that conflicts means another replica leads, and the host stops.                           |
| Takeover    | On SIGTERM the leader removes its label and releases the Lease, so a replica takes over within its next attempt (5 s) instead of after 15 s. The new leader loads the state, connects, and resumes pending runs: Pi Durable continues each interrupted answer, which replaces its placeholder post.            |
| Duplicates  | Grafana retries notifications the host did not acknowledge, and alert episodes skip unchanged repeats, so a notification during a takeover is posted once.                                                                                                                                                     |
| Disruptions | A PodDisruptionBudget (`minAvailable: 1`), `maxSurge: 1` and `maxUnavailable: 0`, and 30 s for shutdown.                                                                                                                                                                                                       |
| Permissions | A Role for `leases` (create; get and update on the named Lease) and `pods` (get and patch, for the leader label).                                                                                                                                                                                              |

Without `LEASE_NAME`, the host runs as before: one instance, state in a file
(`HOST_STATE=file`). `HOST_STATE=backend` keeps a single instance's state in
the plugin backend too.

## Install

Build the image (it contains the host bundle, its worker threads, the plugin's
CPython-WASM assets, and jq-wasm) and push it to your registry:

```bash
npm run build                      # dist/cpython
scripts/build-host-image.sh registry.example.com/grafana-assistant-host:6.1.0
```

Create the Secret and install the chart:

```bash
kubectl create secret generic assistant-host \
  --from-literal=grafana-token=... \
  --from-literal=alert-webhook-token=... \
  --from-literal=mattermost-token=...      # and/or webex-token, webex-webhook-secret
helm install assistant deploy/helm/assistant-host \
  --set image.repository=registry.example.com/grafana-assistant-host --set image.tag=6.1.0 \
  --set grafana.url=http://grafana.monitoring:3000 \
  --set mattermost.url=https://mattermost.example.com --set mattermost.alertChannel=ops/alerts
```

Point Grafana's webhook contact point at the Service
(`http://<release>-assistant-host:8080/alerts/grafana`). For Webex, expose
`/webex/webhook` through an Ingress and set `webex.webhookUrl`. See
`values.yaml` for the remaining settings.

When Grafana itself runs with several replicas, configure the plugin's chat
storage with PostgreSQL ([chat storage](chat-storage.md)): the host state lives
in the same database.

## Local test

OrbStack and other local clusters that share the Docker image store can run the
image directly:

```bash
scripts/build-host-image.sh grafana-assistant-host:dev
kubectl create namespace assistant-ha
kubectl -n assistant-ha create secret generic assistant-host \
  --from-file=grafana-token=work/host/grafana-token \
  --from-file=webex-token=work/host/webex-token \
  --from-file=alert-webhook-token=work/host/alert-webhook-token
helm install ha deploy/helm/assistant-host -n assistant-ha \
  --set grafana.url=http://host.docker.internal:3001 --set grafana.publicUrl=http://localhost:3001 \
  --set webex.apiUrl=http://host.docker.internal:8099/v1 \
  --set webex.webhookUrl=http://host.docker.internal:18080/webex/webhook \
  --set webex.alertRoom=Alerts --set webex.rooms=Ops \
  --set service.type=LoadBalancer --set service.port=18080
kubectl -n assistant-ha get pods -L assistant-host/leader
```

Stop the Compose host first (`docker compose --profile mattermost stop
assistant-host`), so only one host answers. To test a takeover, mention the
bot, then delete the leader pod while the placeholder shows: the other replica
takes the Lease and label, resumes the run, and the answer replaces the
placeholder.

On OrbStack, the Mattermost websocket from a pod to the Compose Mattermost
connects but closes before Mattermost's first frame, through the published port
and the container IP alike, while REST works; the same connection from the
Compose network works. The local test therefore uses the Webex fake, whose
traffic is plain HTTP.

## Tests

`src/host/lease.test.ts` runs elections against an in-memory Lease API with the
API server's `resourceVersion` checks: one leader, handover on release,
takeover after expiry, and a lost lease. The chat store's contract tests cover
the host state's version checks on SQLite and PostgreSQL.
