from __future__ import annotations

import argparse
import json
import math
import os
import time
from collections.abc import Callable, Iterable
from pathlib import Path


HOSTS = ("vm-web-01", "vm-web-02", "vm-db-01")
WEB_ROUTES = ("/", "/api/orders", "/render/report")
METHOD = "GET"
CPU_COUNT = 2
HISTOGRAM_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)
THANOS_NAMESPACE = "thanos-prod"
THANOS_TENANTS = (
    ("kubernetes_obs_it_prod_30d_crit_high", 1073.8, 36.6, 140_000.0, 139_500.0),
    ("client_30d_crit_high_bestand", 824.7, 20.7, 88_000.0, 87_500.0),
    ("default_1y_crit_high", 645.0, 12.4, 52_000.0, 51_000.0),
    ("kubernetes_entw_alt_entw_30d_crit_med_bestand", 512.5, 16.8, 133_000.0, 132_500.0),
    ("vm_30d_crit_med_bestand", 477.2, 14.6, 121_000.0, 120_500.0),
)
THANOS_PODS = (
    ("thanos-global-crit-med-bestand-receive-distributor-5f479f4qlktc", "receive", "crit_med_bestand", 1.70, 28.0),
    ("thanos-rzb-crit-med-bestand-receive-4", "receive", "crit_med_bestand", 1.65, 31.0),
    ("thanos-rza-crit-med-bestand-receive-0", "receive", "crit_med_bestand", 1.63, 30.0),
    ("thanos-default-30d-compactor-29715135-xtfdt", "compact", "default_30d", 0.58, 68.1),
    ("thanos-vm-30d-compactor-29715135-792fp", "compact", "vm_30d", 0.52, 47.7),
    ("thanos-rza-crit-high-receive-5", "receive", "crit_high", 1.25, 46.6),
)
ENTERPRISE_SERVICES = (
    ("auth", "identity-platform", 135.0),
    ("checkout", "commerce-checkout", 190.0),
    ("payments", "commerce-payments", 155.0),
    ("catalog", "catalog-core", 220.0),
    ("search", "discovery", 245.0),
    ("orders", "order-management", 165.0),
    ("notifications", "messaging", 95.0),
    ("fulfillment", "supply-chain", 115.0),
)
ENTERPRISE_ENVS = ("prod", "staging", "dev")
ENTERPRISE_REGIONS = ("us-east-1", "eu-central-1")
ENTERPRISE_ROUTES = ("/api/read", "/api/write", "/api/admin")
ENTERPRISE_METHOD = "GET"
ENTERPRISE_STATUS_RATIOS = (("200", 0.982), ("400", 0.014), ("500", 0.004))
ENTERPRISE_QUEUES = ("default", "priority")
ENTERPRISE_DEPENDENCIES = ("postgres", "redis", "partner-api")
ENTERPRISE_HISTOGRAM_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0)
DEFAULT_HISTORY_HOURS = 6
DEFAULT_STEP_SECONDS = 60
DEFAULT_INCIDENT_DURATION_SECONDS = 900
DEFAULT_FUTURE_SECONDS = 3600


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def ramp(t: float, start: float, end: float) -> float:
    if end <= start:
        return 1.0 if t >= end else 0.0
    return clamp((t - start) / (end - start), 0.0, 1.0)


def incident_intensity(t: float, incident_start_seconds: float) -> float:
    local_t = t - incident_start_seconds
    rise = ramp(local_t, 180, 540)
    fall = ramp(local_t, 720, 840)
    return clamp(rise * (1.0 - fall), 0.0, 1.0)


def cpu_utilization(vm: str, t: float, incident_start_seconds: float) -> float:
    wave = 0.03 * math.sin(t / 37.0)
    if vm == "vm-web-01":
        return clamp(0.18 + wave + 0.78 * incident_intensity(t, incident_start_seconds), 0.05, 0.98)
    if vm == "vm-web-02":
        return clamp(0.16 + wave + 0.12 * incident_intensity(t, incident_start_seconds), 0.05, 0.45)
    return clamp(0.22 + 0.02 * math.sin(t / 55.0), 0.08, 0.38)


def load1(vm: str, t: float, incident_start_seconds: float) -> float:
    if vm == "vm-web-01":
        return round(0.45 + 4.9 * incident_intensity(t, incident_start_seconds), 3)
    if vm == "vm-web-02":
        return round(0.35 + 0.55 * incident_intensity(t, incident_start_seconds), 3)
    return round(0.55 + 0.08 * math.sin(t / 41.0), 3)


def memory_total_bytes(vm: str) -> float:
    gib = 1024 * 1024 * 1024
    return 8 * gib if vm.startswith("vm-web") else 16 * gib


def memory_available_bytes(vm: str, t: float) -> float:
    used_ratio = 0.42 + 0.05 * math.sin(t / 180.0) if vm.startswith("vm-web") else 0.58 + 0.04 * math.sin(t / 150.0)
    return memory_total_bytes(vm) * (1.0 - used_ratio)


def filesystem_size_bytes(vm: str) -> float:
    gib = 1024 * 1024 * 1024
    return 80 * gib if vm.startswith("vm-web") else 200 * gib


def filesystem_free_bytes(vm: str, t: float) -> float:
    baseline = 0.62 if vm.startswith("vm-web") else 0.48
    return filesystem_size_bytes(vm) * (baseline + 0.015 * math.sin(t / 210.0))


def traffic_rps(vm: str, route: str, t: float, incident_start_seconds: float) -> float:
    route_base = {
        "/": 18.0,
        "/api/orders": 8.0,
        "/render/report": 3.0,
    }[route]
    host_share = 0.52 if vm == "vm-web-01" else 0.48
    return route_base * host_share * (1.0 + 0.08 * math.sin(t / 95.0))


def error_ratio(vm: str, route: str, t: float, incident_start_seconds: float) -> float:
    base = 0.002
    if vm == "vm-web-01" and route == "/render/report":
        return base + 0.14 * incident_intensity(t, incident_start_seconds)
    if vm == "vm-web-01":
        return base + 0.035 * incident_intensity(t, incident_start_seconds)
    return base + 0.004 * incident_intensity(t, incident_start_seconds)


def latency_seconds(vm: str, route: str, quantile_hint: float, t: float, incident_start_seconds: float) -> float:
    base = {
        "/": 0.055,
        "/api/orders": 0.11,
        "/render/report": 0.32,
    }[route]
    if vm == "vm-web-01":
        multiplier = 1.0 + incident_intensity(t, incident_start_seconds) * (7.0 if route == "/render/report" else 3.2)
    else:
        multiplier = 1.0 + incident_intensity(t, incident_start_seconds) * 0.45
    return base * multiplier * (1.0 + quantile_hint * 1.8)


def integrate_rate(rate_func: Callable[[float], float], t: float, step: float = 15.0) -> float:
    if t <= 0:
        return 0.0
    total = 0.0
    cursor = 0.0
    while cursor < t:
        interval = min(step, t - cursor)
        midpoint = cursor + interval / 2.0
        total += rate_func(midpoint) * interval
        cursor += interval
    return total


def cpu_mode_fraction(vm: str, mode: str, t: float, incident_start_seconds: float) -> float:
    utilization = cpu_utilization(vm, t, incident_start_seconds)
    if mode == "idle":
        return 1.0 - utilization
    if mode == "user":
        return utilization * (0.72 if vm == "vm-web-01" else 0.62)
    if mode == "system":
        return utilization * (0.22 if vm.startswith("vm-web") else 0.18)
    if mode == "iowait":
        return 0.01 + (0.015 if vm == "vm-db-01" else 0.005)
    return 0.0


def counter_value(rate_func: Callable[[float], float], t: float) -> float:
    return integrate_rate(rate_func, t)


def periodic_counter(rate: float, t: float, phase: float, amplitude: float = 0.08, period: float = 900.0) -> float:
    if t <= 0:
        return 0.0
    return rate * (t + amplitude * period * (math.cos(phase) - math.cos((t / period) + phase)))


def stable_phase(*parts: str) -> float:
    total = 0
    for part in parts:
        total += sum(ord(char) for char in part)
    return (total % 628) / 100.0


def enterprise_env_multiplier(env: str) -> float:
    return {"prod": 1.0, "staging": 0.32, "dev": 0.14}[env]


def enterprise_region_multiplier(region: str) -> float:
    return {"us-east-1": 0.58, "eu-central-1": 0.42}[region]


def enterprise_route_multiplier(route: str) -> float:
    return {"/api/read": 0.66, "/api/write": 0.28, "/api/admin": 0.06}[route]


def enterprise_latency_baseline(service: str, route: str) -> float:
    service_penalty = {
        "search": 0.08,
        "checkout": 0.12,
        "payments": 0.16,
        "fulfillment": 0.10,
    }.get(service, 0.04)
    route_penalty = {"/api/read": 0.06, "/api/write": 0.13, "/api/admin": 0.22}[route]
    return service_penalty + route_penalty


def enterprise_request_rate(service_rate: float, env: str, region: str, route: str, status: str) -> float:
    status_ratio = dict(ENTERPRISE_STATUS_RATIOS)[status]
    return (
        service_rate
        * enterprise_env_multiplier(env)
        * enterprise_region_multiplier(region)
        * enterprise_route_multiplier(route)
        * status_ratio
    )


def histogram_bucket_count(vm: str, route: str, le: float, t: float, incident_start_seconds: float) -> float:
    def rate_at(moment: float) -> float:
        rps = traffic_rps(vm, route, moment, incident_start_seconds)
        p95 = latency_seconds(vm, route, 0.95, moment, incident_start_seconds)
        if le >= 10.0:
            return rps
        fraction = clamp(1.0 - math.exp(-le / max(p95 / 3.0, 0.001)), 0.0, 1.0)
        return rps * fraction

    return integrate_rate(rate_at, t)


def labels(**values: str) -> str:
    encoded = ",".join(f'{key}="{value}"' for key, value in values.items())
    return f"{{{encoded}}}"


def sample(name: str, value: float, **label_values: str) -> str:
    return f"{name}{labels(**label_values)} {value:.6f}"


def metric_family(name: str, metric_type: str, help_text: str, samples: Iterable[str]) -> list[str]:
    return [
        f"# HELP {name} {help_text}",
        f"# TYPE {name} {metric_type}",
        *samples,
    ]


def render_prometheus_metrics(elapsed_seconds: float, incident_start_seconds: float) -> str:
    t = max(0.0, elapsed_seconds)
    lines: list[str] = []

    cpu_samples: list[str] = []
    for vm in HOSTS:
        for cpu in range(CPU_COUNT):
            for mode in ("idle", "user", "system", "iowait"):
                value = integrate_rate(lambda moment, vm=vm, mode=mode: cpu_mode_fraction(vm, mode, moment, incident_start_seconds), t)
                cpu_samples.append(sample("node_cpu_seconds_total", value, cpu=str(cpu), mode=mode, vm=vm, instance=f"{vm}:9100", job="node"))
    lines.extend(metric_family("node_cpu_seconds_total", "counter", "Seconds the CPUs spent in each mode.", cpu_samples))

    lines.extend(
        metric_family(
            "node_load1",
            "gauge",
            "One minute load average.",
            [sample("node_load1", load1(vm, t, incident_start_seconds), vm=vm, instance=f"{vm}:9100", job="node") for vm in HOSTS],
        )
    )

    mem_total_samples = []
    mem_available_samples = []
    fs_size_samples = []
    fs_free_samples = []
    for vm in HOSTS:
        mem_total_samples.append(sample("node_memory_MemTotal_bytes", memory_total_bytes(vm), vm=vm, instance=f"{vm}:9100", job="node"))
        mem_available_samples.append(sample("node_memory_MemAvailable_bytes", memory_available_bytes(vm, t), vm=vm, instance=f"{vm}:9100", job="node"))
        fs_size_samples.append(sample("node_filesystem_size_bytes", filesystem_size_bytes(vm), vm=vm, mountpoint="/", fstype="ext4", instance=f"{vm}:9100", job="node"))
        fs_free_samples.append(sample("node_filesystem_free_bytes", filesystem_free_bytes(vm, t), vm=vm, mountpoint="/", fstype="ext4", instance=f"{vm}:9100", job="node"))
    lines.extend(metric_family("node_memory_MemTotal_bytes", "gauge", "Total memory.", mem_total_samples))
    lines.extend(metric_family("node_memory_MemAvailable_bytes", "gauge", "Available memory.", mem_available_samples))
    lines.extend(metric_family("node_filesystem_size_bytes", "gauge", "Filesystem size.", fs_size_samples))
    lines.extend(metric_family("node_filesystem_free_bytes", "gauge", "Filesystem free bytes.", fs_free_samples))

    receive_samples = []
    transmit_samples = []
    for vm in HOSTS:
        receive = counter_value(lambda moment, vm=vm: 280_000 + 40_000 * incident_intensity(moment, incident_start_seconds) if vm.startswith("vm-web") else 90_000, t)
        transmit = counter_value(lambda moment, vm=vm: 360_000 + 70_000 * incident_intensity(moment, incident_start_seconds) if vm.startswith("vm-web") else 120_000, t)
        receive_samples.append(sample("node_network_receive_bytes_total", receive, vm=vm, device="eth0", instance=f"{vm}:9100", job="node"))
        transmit_samples.append(sample("node_network_transmit_bytes_total", transmit, vm=vm, device="eth0", instance=f"{vm}:9100", job="node"))
    lines.extend(metric_family("node_network_receive_bytes_total", "counter", "Network bytes received.", receive_samples))
    lines.extend(metric_family("node_network_transmit_bytes_total", "counter", "Network bytes transmitted.", transmit_samples))

    request_samples = []
    latency_sum_samples = []
    bucket_samples = []
    inflight_samples = []
    for vm in ("vm-web-01", "vm-web-02"):
        for route in WEB_ROUTES:
            ok_rate = lambda moment, vm=vm, route=route: traffic_rps(vm, route, moment, incident_start_seconds) * (1.0 - error_ratio(vm, route, moment, incident_start_seconds))
            err_rate = lambda moment, vm=vm, route=route: traffic_rps(vm, route, moment, incident_start_seconds) * error_ratio(vm, route, moment, incident_start_seconds)
            request_samples.append(sample("http_requests_total", counter_value(ok_rate, t), vm=vm, route=route, method=METHOD, status="200", job="web"))
            request_samples.append(sample("http_requests_total", counter_value(err_rate, t), vm=vm, route=route, method=METHOD, status="500", job="web"))

            total_requests = counter_value(lambda moment, vm=vm, route=route: traffic_rps(vm, route, moment, incident_start_seconds), t)
            avg_latency = latency_seconds(vm, route, 0.50, t, incident_start_seconds)
            latency_sum_samples.append(sample("http_request_duration_seconds_sum", total_requests * avg_latency, vm=vm, route=route, method=METHOD, job="web"))
            latency_sum_samples.append(sample("http_request_duration_seconds_count", total_requests, vm=vm, route=route, method=METHOD, job="web"))
            inflight = traffic_rps(vm, route, t, incident_start_seconds) * latency_seconds(vm, route, 0.70, t, incident_start_seconds)
            inflight_samples.append(sample("http_inflight_requests", inflight, vm=vm, route=route, method=METHOD, job="web"))
            for bucket in HISTOGRAM_BUCKETS:
                bucket_samples.append(sample("http_request_duration_seconds_bucket", histogram_bucket_count(vm, route, bucket, t, incident_start_seconds), vm=vm, route=route, method=METHOD, le=str(bucket), job="web"))
            bucket_samples.append(sample("http_request_duration_seconds_bucket", total_requests, vm=vm, route=route, method=METHOD, le="+Inf", job="web"))

    lines.extend(metric_family("http_requests_total", "counter", "HTTP requests by route, status, and VM.", request_samples))
    lines.extend(metric_family("http_request_duration_seconds", "histogram", "HTTP request duration histogram.", [*bucket_samples, *latency_sum_samples]))
    lines.extend(metric_family("http_inflight_requests", "gauge", "Current in-flight HTTP requests.", inflight_samples))
    lines.extend(render_enterprise_metric_families(t))
    lines.extend(render_thanos_cost_metric_families(t))

    return "\n".join(lines) + "\n"


def render_enterprise_metric_families(t: float) -> list[str]:
    lines: list[str] = []
    request_samples = []
    bucket_samples = []
    latency_sum_samples = []
    queue_samples = []
    slo_samples = []
    dependency_error_samples = []
    cache_samples = []
    worker_restart_samples = []
    db_connection_samples = []

    for service_index, (service, team, service_rate) in enumerate(ENTERPRISE_SERVICES):
        for env in ENTERPRISE_ENVS:
            for region in ENTERPRISE_REGIONS:
                env_region_phase = stable_phase(service, env, region)
                traffic_total = 0.0
                weighted_latency_total = 0.0

                for route in ENTERPRISE_ROUTES:
                    route_latency = enterprise_latency_baseline(service, route)
                    route_rate = 0.0
                    for status, _ratio in ENTERPRISE_STATUS_RATIOS:
                        rate = enterprise_request_rate(service_rate, env, region, route, status)
                        phase = stable_phase(service, env, region, route, status)
                        request_samples.append(
                            sample(
                                "enterprise_http_requests_total",
                                periodic_counter(rate, t, phase),
                                service=service,
                                team=team,
                                env=env,
                                region=region,
                                route=route,
                                method=ENTERPRISE_METHOD,
                                status=status,
                                instance=f"{service}-{region}-{env}:8080",
                                job="enterprise-app",
                            )
                        )
                        route_rate += rate

                    route_total = periodic_counter(route_rate, t, stable_phase(service, env, region, route))
                    traffic_total += route_total
                    weighted_latency_total += route_total * route_latency
                    for bucket in ENTERPRISE_HISTOGRAM_BUCKETS:
                        fraction = clamp(1.0 - math.exp(-bucket / max(route_latency / 2.5, 0.001)), 0.0, 1.0)
                        bucket_samples.append(
                            sample(
                                "enterprise_request_duration_seconds_bucket",
                                route_total * fraction,
                                service=service,
                                team=team,
                                env=env,
                                region=region,
                                route=route,
                                method=ENTERPRISE_METHOD,
                                le=str(bucket),
                                job="enterprise-app",
                            )
                        )
                    bucket_samples.append(
                        sample(
                            "enterprise_request_duration_seconds_bucket",
                            route_total,
                            service=service,
                            team=team,
                            env=env,
                            region=region,
                            route=route,
                            method=ENTERPRISE_METHOD,
                            le="+Inf",
                            job="enterprise-app",
                        )
                    )
                    latency_sum_samples.append(
                        sample(
                            "enterprise_request_duration_seconds_sum",
                            route_total * route_latency,
                            service=service,
                            team=team,
                            env=env,
                            region=region,
                            route=route,
                            method=ENTERPRISE_METHOD,
                            job="enterprise-app",
                        )
                    )
                    latency_sum_samples.append(
                        sample(
                            "enterprise_request_duration_seconds_count",
                            route_total,
                            service=service,
                            team=team,
                            env=env,
                            region=region,
                            route=route,
                            method=ENTERPRISE_METHOD,
                            job="enterprise-app",
                        )
                    )

                avg_latency = weighted_latency_total / max(traffic_total, 1.0)
                error_budget = clamp(
                    0.93
                    - 0.06 * enterprise_env_multiplier(env)
                    + 0.03 * math.sin((t / 1800.0) + env_region_phase)
                    - min(avg_latency, 2.0) * 0.02,
                    0.08,
                    0.99,
                )
                slo_samples.append(
                    sample(
                        "enterprise_slo_error_budget_remaining_ratio",
                        error_budget,
                        service=service,
                        team=team,
                        env=env,
                        region=region,
                        objective="99.9",
                        job="enterprise-slo",
                    )
                )

                cache_samples.append(
                    sample(
                        "enterprise_cache_hit_ratio",
                        clamp(0.82 + 0.08 * math.sin((t / 1200.0) + service_index), 0.55, 0.99),
                        service=service,
                        team=team,
                        env=env,
                        region=region,
                        cache="edge",
                        job="enterprise-app",
                    )
                )
                for queue_index, queue in enumerate(ENTERPRISE_QUEUES):
                    queue_samples.append(
                        sample(
                            "enterprise_queue_depth",
                            45
                            + service_rate * enterprise_env_multiplier(env) * 0.8
                            + 28 * math.sin((t / 600.0) + env_region_phase + queue_index),
                            service=service,
                            team=team,
                            env=env,
                            region=region,
                            queue=queue,
                            job="enterprise-worker",
                        )
                    )
                    worker_restart_samples.append(
                        sample(
                            "enterprise_worker_restarts_total",
                            periodic_counter(
                                0.002 * (queue_index + 1) * enterprise_env_multiplier(env),
                                t,
                                stable_phase(service, env, region, queue),
                                amplitude=0.2,
                            ),
                            service=service,
                            team=team,
                            env=env,
                            region=region,
                            worker=queue,
                            job="enterprise-worker",
                        )
                    )

                for dependency_index, dependency in enumerate(ENTERPRISE_DEPENDENCIES):
                    dependency_error_samples.append(
                        sample(
                            "enterprise_external_dependency_errors_total",
                            periodic_counter(
                                0.018
                                * (dependency_index + 1)
                                * enterprise_env_multiplier(env)
                                * enterprise_region_multiplier(region),
                                t,
                                stable_phase(service, env, region, dependency),
                            ),
                            service=service,
                            team=team,
                            env=env,
                            region=region,
                            dependency=dependency,
                            job="enterprise-app",
                        )
                    )

                for pool in ("read", "write"):
                    pool_multiplier = 0.72 if pool == "read" else 0.28
                    db_connection_samples.append(
                        sample(
                            "enterprise_db_connections",
                            10
                            + service_rate
                            * enterprise_env_multiplier(env)
                            * enterprise_region_multiplier(region)
                            * pool_multiplier
                            * (1.0 + 0.08 * math.sin((t / 700.0) + env_region_phase)),
                            service=service,
                            team=team,
                            env=env,
                            region=region,
                            pool=pool,
                            job="enterprise-db",
                        )
                    )

    lines.extend(metric_family("enterprise_http_requests_total", "counter", "Synthetic enterprise HTTP requests.", request_samples))
    lines.extend(
        metric_family(
            "enterprise_request_duration_seconds",
            "histogram",
            "Synthetic enterprise request duration histogram.",
            [*bucket_samples, *latency_sum_samples],
        )
    )
    lines.extend(metric_family("enterprise_queue_depth", "gauge", "Synthetic enterprise queue depth.", queue_samples))
    lines.extend(metric_family("enterprise_slo_error_budget_remaining_ratio", "gauge", "Synthetic enterprise SLO budget.", slo_samples))
    lines.extend(
        metric_family(
            "enterprise_external_dependency_errors_total",
            "counter",
            "Synthetic enterprise dependency errors.",
            dependency_error_samples,
        )
    )
    lines.extend(metric_family("enterprise_cache_hit_ratio", "gauge", "Synthetic enterprise cache hit ratio.", cache_samples))
    lines.extend(metric_family("enterprise_worker_restarts_total", "counter", "Synthetic enterprise worker restarts.", worker_restart_samples))
    lines.extend(metric_family("enterprise_db_connections", "gauge", "Synthetic enterprise DB connections.", db_connection_samples))
    return lines


def render_thanos_cost_metric_families(t: float) -> list[str]:
    gib = 1024 * 1024 * 1024
    lines: list[str] = []

    tsdb_samples = []
    wal_samples = []
    receive_samples = []
    timeseries_samples = []
    for index, (tenant, storage_gib, wal_gib, sample_rate, series_rate) in enumerate(THANOS_TENANTS):
        storage_wave = 1.0 + 0.01 * math.sin((t / 900.0) + index)
        wal_wave = 1.0 + 0.03 * math.sin((t / 420.0) + index)
        tsdb_samples.append(
            sample(
                "prometheus_tsdb_storage_blocks_bytes",
                storage_gib * gib * storage_wave,
                namespace=THANOS_NAMESPACE,
                tenant=tenant,
                job=f"thanos-{tenant}-receive",
            )
        )
        wal_samples.append(
            sample(
                "prometheus_tsdb_wal_storage_size_bytes",
                wal_gib * gib * wal_wave,
                namespace=THANOS_NAMESPACE,
                tenant=tenant,
                job=f"thanos-{tenant}-receive",
            )
        )
        receive_samples.append(
            sample(
                "thanos_receive_write_samples_sum",
                counter_value(lambda moment, sample_rate=sample_rate, index=index: sample_rate * (1.0 + 0.04 * math.sin(moment / 600.0 + index)), t),
                namespace=THANOS_NAMESPACE,
                tenant=tenant,
                service=f"thanos-{tenant}-receive",
                job="thanos-receive",
            )
        )
        timeseries_samples.append(
            sample(
                "thanos_receive_write_timeseries_sum",
                counter_value(lambda moment, series_rate=series_rate, index=index: series_rate * (1.0 + 0.04 * math.sin(moment / 600.0 + index)), t),
                namespace=THANOS_NAMESPACE,
                tenant=tenant,
                service=f"thanos-{tenant}-receive",
                job="thanos-receive",
            )
        )

    lines.extend(metric_family("prometheus_tsdb_storage_blocks_bytes", "gauge", "Synthetic Thanos TSDB blocks storage by tenant.", tsdb_samples))
    lines.extend(metric_family("prometheus_tsdb_wal_storage_size_bytes", "gauge", "Synthetic Thanos WAL storage by tenant.", wal_samples))
    lines.extend(metric_family("thanos_receive_write_samples_sum", "counter", "Synthetic Thanos received samples.", receive_samples))
    lines.extend(metric_family("thanos_receive_write_timeseries_sum", "counter", "Synthetic Thanos received time series.", timeseries_samples))

    cpu_samples = []
    memory_working_set_samples = []
    memory_usage_samples = []
    for index, (pod, component, tenant_id, cpu_cores, memory_gib) in enumerate(THANOS_PODS):
        cpu_samples.append(
            sample(
                "container_cpu_usage_seconds_total",
                counter_value(lambda moment, cpu_cores=cpu_cores, index=index: cpu_cores * (1.0 + 0.05 * math.sin(moment / 500.0 + index)), t),
                namespace=THANOS_NAMESPACE,
                pod=pod,
                container=component,
                tenant_id=tenant_id,
                job="cadvisor",
            )
        )
        memory_value = memory_gib * gib * (1.0 + 0.02 * math.sin(t / 500.0 + index))
        memory_working_set_samples.append(
            sample(
                "container_memory_working_set_bytes",
                memory_value,
                namespace=THANOS_NAMESPACE,
                pod=pod,
                container=component,
                tenant_id=tenant_id,
                job="cadvisor",
            )
        )
        memory_usage_samples.append(
            sample(
                "container_memory_usage_bytes",
                memory_value * 1.05,
                namespace=THANOS_NAMESPACE,
                pod=pod,
                container=component,
                tenant_id=tenant_id,
                job="cadvisor",
            )
        )

    lines.extend(metric_family("container_cpu_usage_seconds_total", "counter", "Synthetic container CPU usage.", cpu_samples))
    lines.extend(metric_family("container_memory_working_set_bytes", "gauge", "Synthetic container memory working set.", memory_working_set_samples))
    lines.extend(metric_family("container_memory_usage_bytes", "gauge", "Synthetic container memory usage.", memory_usage_samples))
    return lines


def render_openmetrics_history(start_timestamp: int, total_seconds: int, step_seconds: int, incident_start_seconds: int) -> str:
    lines: list[str] = []
    metadata_written = False
    for elapsed in range(0, total_seconds + 1, step_seconds):
        timestamp_seconds = start_timestamp + elapsed
        for line in render_prometheus_metrics(elapsed, incident_start_seconds).splitlines():
            if line.startswith("# HELP") or line.startswith("# TYPE"):
                if not metadata_written:
                    lines.append(line)
                continue
            if line:
                lines.append(f"{line} {timestamp_seconds}")
        metadata_written = True
    lines.append("# EOF")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Write historical OpenMetrics samples for the Observability Analyst local demo stack."
    )
    parser.add_argument("--output", default=os.getenv("OPENMETRICS_OUTPUT", "/demo/history.openmetrics"))
    parser.add_argument("--hours", type=int, default=int(os.getenv("HISTORY_HOURS", str(DEFAULT_HISTORY_HOURS))))
    parser.add_argument("--step-seconds", type=int, default=int(os.getenv("HISTORY_STEP_SECONDS", str(DEFAULT_STEP_SECONDS))))
    parser.add_argument("--incident-duration-seconds", type=int, default=int(os.getenv("INCIDENT_DURATION_SECONDS", str(DEFAULT_INCIDENT_DURATION_SECONDS))))
    parser.add_argument("--future-seconds", type=int, default=int(os.getenv("HISTORY_FUTURE_SECONDS", str(DEFAULT_FUTURE_SECONDS))))
    parser.add_argument("--end-timestamp", type=int, default=int(os.getenv("HISTORY_END_TIMESTAMP", "0")) or None)
    parser.add_argument(
        "--timeline-output",
        default=os.getenv("TIMELINE_OUTPUT", ""),
        help="Also write the history window and incident start as JSON, so other demo data can align with it.",
    )
    args = parser.parse_args()

    history_seconds = args.hours * 3600
    incident_start_seconds = max(0, history_seconds - args.incident_duration_seconds)
    end_timestamp = int(args.end_timestamp or time.time())
    start_timestamp = end_timestamp - history_seconds
    total_seconds = history_seconds + max(0, args.future_seconds)
    output = Path(args.output)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        render_openmetrics_history(
            start_timestamp=start_timestamp,
            total_seconds=total_seconds,
            step_seconds=args.step_seconds,
            incident_start_seconds=incident_start_seconds,
        ),
        encoding="utf-8",
    )
    if args.timeline_output:
        timeline = Path(args.timeline_output)
        timeline.parent.mkdir(parents=True, exist_ok=True)
        timeline.write_text(
            json.dumps(
                {
                    "startTimestamp": start_timestamp,
                    "endTimestamp": end_timestamp,
                    "futureSeconds": max(0, args.future_seconds),
                    "incidentStartTimestamp": start_timestamp + incident_start_seconds,
                    "incidentDurationSeconds": args.incident_duration_seconds,
                }
            )
            + "\n",
            encoding="utf-8",
        )
    print(
        f"wrote {output} with {args.hours}h of history and {max(0, args.future_seconds)}s "
        f"of current-query overlap ending at unix timestamp {end_timestamp + max(0, args.future_seconds)}"
    )


if __name__ == "__main__":
    main()
