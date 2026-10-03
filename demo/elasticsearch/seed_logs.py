"""Seed Elasticsearch with synthetic ECS logs for restricted log access tests.

The logs follow the Prometheus demo history: same hosts, routes, services, and
incident (vm-web-01 /render/report timeouts in the last minutes of the
history). The Prometheus generator writes its time window to a timeline file;
when the file exists, the logs use the same window, so metric and log spikes
line up.

Restricted data streams carry sentinel values (PI-SENTINEL-...) in every text
field: messages, error messages, and stack traces. Keyword fields are
non-sensitive and carry none, except error.message.keyword, the keyword
subfield of a text field, which must be treated as text. Deployment events
(log.logger "deployer") are mixed into the application logs, carry no
sentinels, and are meant to be readable completely.

Only the Python standard library is used.
"""

from __future__ import annotations

import base64
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "prometheus"))

from generate_openmetrics import (  # noqa: E402
    ENTERPRISE_SERVICES,
    WEB_ROUTES,
    error_ratio,
    incident_intensity,
    latency_seconds,
    traffic_rps,
)

ES_URL = os.getenv("ES_URL", "http://elasticsearch:9200").rstrip("/")
ELASTIC_PASSWORD = os.getenv("ELASTIC_PASSWORD", "elastic-dev")
GRAFANA_ES_USER = os.getenv("GRAFANA_ES_USER", "grafana")
GRAFANA_ES_PASSWORD = os.getenv("GRAFANA_ES_PASSWORD", "grafana-dev")
TIMELINE_FILE = os.getenv("TIMELINE_FILE", "")
HISTORY_HOURS = int(os.getenv("HISTORY_HOURS", "6"))
INCIDENT_DURATION_SECONDS = int(os.getenv("INCIDENT_DURATION_SECONDS", "900"))
SEED = int(os.getenv("LOGS_SEED", "42"))
# Share of the Prometheus demo request rate written as access log lines.
ACCESS_SAMPLE = float(os.getenv("LOGS_ACCESS_SAMPLE", "0.05"))
FORCE = os.getenv("LOGS_FORCE", "0") not in ("", "0", "false")
BULK_BATCH = 5000

NAMESPACE = "prod"
WEB_HOSTS = ("vm-web-01", "vm-web-02")
REGIONS = ("eu-central-1", "us-east-1")
LEVEL_WEIGHTS = (("INFO", 0.86), ("DEBUG", 0.08), ("WARN", 0.05), ("ERROR", 0.01))
FIXTURE_INDEX = "pi-demo-fixture"
FORBIDDEN_INDEX = "secrets-vault-export"
ROLE = "grafana_logs_reader"

AUTH = "Basic " + base64.b64encode(f"elastic:{ELASTIC_PASSWORD}".encode()).decode()

KEYWORD = {"type": "keyword", "ignore_above": 1024}
MAPPINGS = {
    "dynamic": "false",
    "properties": {
        "@timestamp": {"type": "date"},
        "message": {"type": "match_only_text"},
        "data_stream": {
            "properties": {
                "type": {"type": "constant_keyword"},
                "dataset": {"type": "constant_keyword"},
                "namespace": {"type": "constant_keyword"},
            }
        },
        "event": {
            "properties": {
                "dataset": KEYWORD,
                "action": KEYWORD,
                "outcome": KEYWORD,
                "category": KEYWORD,
                "duration": {"type": "long"},
            }
        },
        "log": {"properties": {"level": KEYWORD, "logger": KEYWORD}},
        "service": {
            "properties": {
                "name": KEYWORD,
                "version": KEYWORD,
                "environment": KEYWORD,
                "team": KEYWORD,
            }
        },
        "host": {"properties": {"name": KEYWORD}},
        "cloud": {"properties": {"region": KEYWORD}},
        "trace": {"properties": {"id": KEYWORD}},
        "http": {
            "properties": {
                "request": {"properties": {"method": KEYWORD}},
                "response": {"properties": {"status_code": {"type": "long"}, "bytes": {"type": "long"}}},
            }
        },
        "url": {"properties": {"path": KEYWORD, "query": KEYWORD}},
        "client": {"properties": {"ip": {"type": "ip"}}},
        "source": {"properties": {"ip": {"type": "ip"}}},
        "user_agent": {"properties": {"original": KEYWORD}},
        "user": {"properties": {"name": KEYWORD, "email": KEYWORD, "id": KEYWORD}},
        "error": {
            "properties": {
                "type": KEYWORD,
                # A text field with a keyword subfield, as in default dynamic
                # mappings: the subfield holds the same sensitive content.
                "message": {"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 1024}}},
                "stack_trace": {"type": "match_only_text"},
            }
        },
        "labels": {
            "properties": {
                "session_token": KEYWORD,
                "change_id": KEYWORD,
            }
        },
    },
}


def request(method: str, path: str, body=None, *, ndjson: bool = False, auth: str = AUTH, ok=(200, 201)):
    data = None
    headers = {"Authorization": auth}
    if body is not None:
        if ndjson:
            data = body.encode()
            headers["Content-Type"] = "application/x-ndjson"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(ES_URL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        payload = error.read()
        if error.code in ok:
            return error.code, json.loads(payload or b"null")
        raise RuntimeError(f"{method} {path} failed with {error.code}: {payload[:500]!r}") from None


def wait_for_elasticsearch() -> None:
    deadline = time.time() + 300
    while True:
        try:
            request("GET", "/_cluster/health?wait_for_status=yellow&timeout=5s")
            return
        except (OSError, RuntimeError) as error:
            if time.time() > deadline:
                raise
            print(f"waiting for Elasticsearch: {error}", flush=True)
            time.sleep(3)


def setup_security() -> None:
    # The Grafana datasource credential may read every logs-* data stream,
    # including the audit stream the assistant policy denies: the credential is
    # broader than the policy, as in typical production setups.
    request(
        "PUT",
        f"/_security/role/{ROLE}",
        {
            "cluster": ["monitor"],
            "indices": [{"names": ["logs-*"], "privileges": ["read", "view_index_metadata"]}],
        },
    )
    request(
        "PUT",
        f"/_security/user/{GRAFANA_ES_USER}",
        {"password": GRAFANA_ES_PASSWORD, "roles": [ROLE], "full_name": "Grafana datasource"},
    )


def setup_templates() -> None:
    request(
        "PUT",
        "/_index_template/pi-demo-logs",
        {
            "index_patterns": ["logs-*-*"],
            "data_stream": {},
            "priority": 500,
            "template": {
                "settings": {"number_of_shards": 1, "number_of_replicas": 0},
                "mappings": MAPPINGS,
            },
            "_meta": {"description": "Observability Analyst restricted log fixture"},
        },
    )


def existing_document_count() -> int:
    status, body = request("GET", "/logs-*-*/_count", ok=(200, 404))
    return int(body.get("count", 0)) if status == 200 else 0


def delete_fixture() -> None:
    request("DELETE", "/_data_stream/logs-*-*", ok=(200, 404))
    request("DELETE", f"/{FIXTURE_INDEX}", ok=(200, 404))
    request("DELETE", f"/{FORBIDDEN_INDEX}", ok=(200, 404))


def load_timeline() -> dict:
    if TIMELINE_FILE and Path(TIMELINE_FILE).exists():
        timeline = json.loads(Path(TIMELINE_FILE).read_text(encoding="utf-8"))
        print(f"using Prometheus history timeline from {TIMELINE_FILE}", flush=True)
        return timeline
    end = int(time.time())
    start = end - HISTORY_HOURS * 3600
    print(
        "no Prometheus timeline found; logs use a window ending now and may not line up with "
        "existing Prometheus history (run `mise run dev:reload:variant:fresh` and `mise run dev:logs` to reseed both)",
        flush=True,
    )
    return {
        "startTimestamp": start,
        "endTimestamp": end,
        "futureSeconds": 0,
        "incidentStartTimestamp": end - INCIDENT_DURATION_SECONDS,
        "incidentDurationSeconds": INCIDENT_DURATION_SECONDS,
    }


def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Fixture:
    def __init__(self, timeline: dict):
        self.rng = random.Random(SEED)
        self.start = int(timeline["startTimestamp"])
        self.end = int(timeline["endTimestamp"]) + int(timeline.get("futureSeconds", 0))
        self.incident_start = int(timeline["incidentStartTimestamp"])
        self.incident_offset = self.incident_start - self.start
        self.counts: Counter[str] = Counter()
        self.sentinels = 0
        self.deploys: list[dict] = []

    def sentinel(self, kind: str) -> str:
        self.sentinels += 1
        return f"PI-SENTINEL-{kind}-{self.sentinels:07d}"

    def email(self) -> str:
        return f"user-{self.rng.randint(1, 5000):05d}@example.com"

    def client_ip(self) -> str:
        return f"10.{self.rng.randint(16, 31)}.{self.rng.randint(0, 255)}.{self.rng.randint(1, 254)}"

    def trace_id(self) -> str:
        return "%032x" % self.rng.getrandbits(128)

    def base(self, dataset: str, timestamp: float) -> dict:
        self.counts[dataset] += 1
        return {
            "@timestamp": iso(timestamp),
            "data_stream": {"type": "logs", "dataset": dataset, "namespace": NAMESPACE},
            "event": {"dataset": dataset},
            "service": {"environment": NAMESPACE},
        }

    def poisson(self, mean: float) -> int:
        if mean <= 0:
            return 0
        if mean > 30:
            return max(0, round(self.rng.gauss(mean, math.sqrt(mean))))
        limit, k, p = math.exp(-mean), 0, 1.0
        while True:
            p *= self.rng.random()
            if p <= limit:
                return k
            k += 1

    def access_logs(self, minute_start: int):
        elapsed = minute_start - self.start
        for host in WEB_HOSTS:
            for route in WEB_ROUTES:
                rate = traffic_rps(host, route, elapsed, self.incident_offset) * 60 * ACCESS_SAMPLE
                for _ in range(self.poisson(rate)):
                    offset = self.rng.uniform(0, 60)
                    t = elapsed + offset
                    roll = self.rng.random()
                    if roll < error_ratio(host, route, t, self.incident_offset):
                        status = 504 if route == "/render/report" else self.rng.choice((500, 502, 503))
                    elif roll < 0.012 + error_ratio(host, route, t, self.incident_offset):
                        status = self.rng.choice((400, 401, 404, 429))
                    else:
                        status = 200
                    duration = latency_seconds(host, route, self.rng.random(), t, self.incident_offset)
                    if status == 504:
                        duration = max(duration, 30.0)
                    ip = self.client_ip()
                    query = f"email={self.email()}&page={self.rng.randint(1, 20)}"
                    path = route if route != "/api/orders" else f"/api/orders/{self.rng.randint(100000, 999999)}"
                    method = "POST" if route == "/api/orders" and self.rng.random() < 0.3 else "GET"
                    bytes_sent = self.rng.randint(400, 90000) if status == 200 else self.rng.randint(80, 600)
                    agent = self.rng.choice(
                        (
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)",
                            "okhttp/4.12.0",
                            "Grafana/13.2.1",
                        )
                    )
                    doc = self.base("nginx.access", minute_start + offset)
                    doc.update(
                        {
                            "message": (
                                f'{ip} - - "{method} {path}?{query} HTTP/1.1" {status} {bytes_sent} '
                                f'"-" "{agent}" rt={duration:.3f} rid={self.sentinel("MSG")}'
                            ),
                            "log": {"level": "ERROR" if status >= 500 else "INFO", "logger": "nginx"},
                            "service": {"name": "web-frontend", "environment": NAMESPACE, "team": "web-platform"},
                            "host": {"name": host},
                            "cloud": {"region": "eu-central-1"},
                            "http": {
                                "request": {"method": method},
                                "response": {"status_code": status, "bytes": bytes_sent},
                            },
                            "url": {"path": path if route != "/api/orders" else "/api/orders/{id}", "query": query},
                            "client": {"ip": ip},
                            "user_agent": {"original": agent},
                            "event": {
                                "dataset": "nginx.access",
                                "category": "web",
                                "outcome": "failure" if status >= 500 else "success",
                                "duration": int(duration * 1e9),
                            },
                            "trace": {"id": self.trace_id()},
                        }
                    )
                    yield "logs-nginx.access-prod", doc

    def version(self, service: str, host: str, timestamp: float) -> str:
        """report-renderer on vm-web-01 runs 3.8.0 between the CHG-4711 rollout and the CHG-4712 rollback (see deploy_events)."""
        if service != "report-renderer":
            return "2.14.0"
        rollout_done = self.incident_start + 60 + 95
        rollback_done = self.incident_start + 780 + 95
        return "3.8.0" if host == "vm-web-01" and rollout_done <= timestamp < rollback_done else "3.7.2"

    def app_log(self, timestamp: float, service: str, team: str, host: str, region: str, level: str, **extra) -> dict:
        doc = self.base("app", timestamp)
        user = self.email()
        token = "%024x" % self.rng.getrandbits(96)
        message = extra.pop(
            "message",
            self.rng.choice(
                (
                    f"Request handled for {user} session={token} {self.sentinel('MSG')}",
                    f"Cache refresh finished for tenant of {user} ({self.sentinel('MSG')})",
                    f"Processed order {self.rng.randint(100000, 999999)} for {user} card=**** {self.rng.randint(1000, 9999)} {self.sentinel('MSG')}",
                    f"Outbound call to partner-api succeeded ref={self.sentinel('MSG')}",
                )
            ),
        )
        doc.update(
            {
                "message": message,
                "log": {"level": level, "logger": f"com.example.{service.replace('-', '.')}.Handler"},
                "service": {
                    "name": service,
                    "version": self.version(service, host, timestamp),
                    "environment": NAMESPACE,
                    "team": team,
                },
                "host": {"name": host},
                "cloud": {"region": region},
                "user": {"email": user, "id": f"u-{self.rng.randint(1, 5000):05d}"},
                "labels": {"session_token": token},
                "trace": {"id": self.trace_id()},
            }
        )
        for key, value in extra.items():
            doc[key] = value
        return doc

    def application_logs(self, minute_start: int):
        elapsed = minute_start - self.start
        services = [(name, team, rate) for name, team, rate in ENTERPRISE_SERVICES]
        services.append(("report-renderer", "reporting", 160.0))
        for service, team, rate in services:
            for _ in range(self.poisson(rate / 40.0)):
                level = self.rng.choices([w[0] for w in LEVEL_WEIGHTS], [w[1] for w in LEVEL_WEIGHTS])[0]
                host = self.rng.choice(WEB_HOSTS) if service == "report-renderer" else f"{service}-{self.rng.randint(1, 3)}"
                extra = {}
                if level == "ERROR":
                    error_type = self.rng.choice(("UpstreamTimeout", "ValidationFailed", "ConnectionReset"))
                    extra = {
                        "message": f"Request failed for {self.email()}: {error_type} {self.sentinel('MSG')}",
                        "error": {
                            "type": error_type,
                            "message": f"{error_type} while serving {self.sentinel('ERR')}",
                            "stack_trace": f"com.example.{error_type}: {self.sentinel('STK')}\n\tat com.example.Handler.run(Handler.java:42)",
                        },
                    }
                yield "logs-app-prod", self.app_log(
                    minute_start + self.rng.uniform(0, 60), service, team, host, self.rng.choice(REGIONS), level, **extra
                )

        # Incident: report rendering on vm-web-01 times out because the
        # reporting database pool is exhausted after the 3.8.0 rollout.
        intensity = incident_intensity(elapsed + 30, self.incident_offset)
        for _ in range(self.poisson(intensity * 45)):
            report_id = self.rng.randint(10000, 99999)
            user = self.email()
            yield "logs-app-prod", self.app_log(
                minute_start + self.rng.uniform(0, 60),
                "report-renderer",
                "reporting",
                "vm-web-01",
                "eu-central-1",
                "ERROR",
                message=f"Rendering report {report_id} for {user} timed out after 30s {self.sentinel('MSG')}",
                error={
                    "type": "ReportRenderTimeout",
                    "message": f"render deadline exceeded for {user} {self.sentinel('ERR')}",
                    "stack_trace": f"com.example.reports.ReportRenderTimeout: {self.sentinel('STK')}\n\tat com.example.reports.Renderer.render(Renderer.java:311)",
                },
            )
        for _ in range(self.poisson(intensity * 20)):
            yield "logs-app-prod", self.app_log(
                minute_start + self.rng.uniform(0, 60),
                "report-renderer",
                "reporting",
                "vm-web-01",
                "eu-central-1",
                "WARN",
                message=f"Connection pool pg-reports exhausted (active=50 idle=0 waiting={self.rng.randint(5, 80)}) {self.sentinel('MSG')}",
                error={"type": "PoolExhausted", "message": f"pool pg-reports exhausted {self.sentinel('ERR')}"},
            )

    def audit_logs(self, minute_start: int):
        for _ in range(self.poisson(4)):
            outcome = "failure" if self.rng.random() < 0.08 else "success"
            user = self.email()
            doc = self.base("audit", minute_start + self.rng.uniform(0, 60))
            doc.update(
                {
                    "message": f"User {user} login {outcome} from {self.client_ip()} {self.sentinel('AUD')}",
                    "log": {"level": "INFO" if outcome == "success" else "WARN", "logger": "audit"},
                    "service": {"name": "auth", "environment": NAMESPACE, "team": "identity-platform"},
                    "host": {"name": f"auth-{self.rng.randint(1, 3)}"},
                    "event": {"dataset": "audit", "action": "user-login", "category": "authentication", "outcome": outcome},
                    "user": {"name": user.split("@")[0], "email": user},
                    "source": {"ip": self.client_ip()},
                }
            )
            yield "logs-audit-prod", doc

    def deploy_events(self):
        # Non-sensitive events in the same data stream as sensitive ones, told
        # apart by a keyword value (log.logger: deployer).
        changes = [
            (self.start + 1800, "catalog", "catalog-3", "5.2.0", "CHG-4702"),
            (self.start + 5400, "checkout", "checkout-1", "7.0.3", "CHG-4705"),
            (self.start + 9000, "search", "search-2", "1.19.4", "CHG-4708"),
            (self.incident_start + 60, "report-renderer", "vm-web-01", "3.8.0", "CHG-4711"),
            (self.incident_start + 780, "report-renderer", "vm-web-01", "3.7.2", "CHG-4712"),
        ]
        for timestamp, service, host, version, change in changes:
            if timestamp > self.end:
                continue
            rollback = change == "CHG-4712"
            for phase, offset in (("started", 0), ("finished", 95)):
                doc = self.base("app", timestamp + offset)
                action = "rollback" if rollback else "deploy"
                message = (
                    f"{'Rollback' if rollback else 'Deployment'} of {service} {version} to {host} {phase} "
                    f"(change {change}, approved by release-bot)"
                )
                doc.update(
                    {
                        "message": message,
                        "log": {"level": "INFO", "logger": "deployer"},
                        "service": {"name": service, "version": version, "environment": NAMESPACE, "team": "platform"},
                        "host": {"name": host},
                        "event": {"dataset": "app", "action": f"{action}-{phase}", "category": "configuration"},
                        "labels": {"change_id": change},
                        "user": {"name": "release-bot"},
                    }
                )
                self.deploys.append({"@timestamp": doc["@timestamp"], "service": service, "host": host, "version": version, "change": change, "action": f"{action}-{phase}"})
                yield "logs-app-prod", doc

    def documents(self):
        yield from self.deploy_events()
        for minute_start in range(self.start, self.end, 60):
            yield from self.access_logs(minute_start)
            yield from self.application_logs(minute_start)
            yield from self.audit_logs(minute_start)


def bulk_load(documents) -> int:
    lines: list[str] = []
    total = 0

    def flush() -> None:
        nonlocal lines
        if not lines:
            return
        _, body = request("POST", "/_bulk?refresh=false", "\n".join(lines) + "\n", ndjson=True)
        if body.get("errors"):
            failures = [item for item in body["items"] if next(iter(item.values())).get("error")]
            raise RuntimeError(f"bulk load failed for {len(failures)} documents: {json.dumps(failures[:2])[:800]}")
        lines = []

    for index, doc in documents:
        lines.append(json.dumps({"create": {"_index": index}}))
        lines.append(json.dumps(doc, separators=(",", ":")))
        total += 1
        if len(lines) >= BULK_BATCH * 2:
            flush()
            print(f"loaded {total} documents", flush=True)
    flush()
    return total


def seed_forbidden_index() -> None:
    # Not readable with the Grafana datasource credential.
    lines = []
    for i in range(3):
        lines.append(json.dumps({"index": {"_index": FORBIDDEN_INDEX}}))
        lines.append(json.dumps({"@timestamp": iso(time.time()), "message": f"vault export {i} PI-SENTINEL-VLT-{i:07d}"}))
    request("POST", "/_bulk?refresh=true", "\n".join(lines) + "\n", ndjson=True)


def main() -> None:
    wait_for_elasticsearch()
    setup_security()
    setup_templates()

    existing = existing_document_count()
    if existing and not FORCE:
        print(f"Elasticsearch already holds {existing} demo log documents; skipping (set LOGS_FORCE=1 to reseed).")
        return
    if existing:
        print(f"deleting {existing} demo log documents", flush=True)
    delete_fixture()

    timeline = load_timeline()
    fixture = Fixture(timeline)
    total = bulk_load(fixture.documents())
    seed_forbidden_index()
    request("POST", "/logs-*-*/_refresh")

    manifest = {
        "timeline": timeline,
        "window": {"from": iso(fixture.start), "to": iso(fixture.end)},
        "incident": {"from": iso(fixture.incident_start), "to": iso(fixture.incident_start + INCIDENT_DURATION_SECONDS)},
        "documents": total,
        "datasets": dict(fixture.counts),
        "sentinelPrefix": "PI-SENTINEL-",
        "deploys": fixture.deploys,
        "seed": SEED,
        "accessSample": ACCESS_SAMPLE,
    }
    # Readable only with the elastic superuser; tests compare broker results with it.
    request("PUT", f"/{FIXTURE_INDEX}/_doc/manifest?refresh=true", manifest)
    print(json.dumps({key: manifest[key] for key in ("window", "incident", "documents", "datasets")}, indent=2))


if __name__ == "__main__":
    main()
