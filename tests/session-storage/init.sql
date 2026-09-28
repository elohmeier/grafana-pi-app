-- Disposable HA fixture: Grafana and assistant use the same database, separate roles/schemas.
CREATE ROLE grafana LOGIN PASSWORD 'grafana-test';
CREATE ROLE pi_sessions LOGIN PASSWORD 'sessions-test';
CREATE DATABASE grafana OWNER grafana;
\connect grafana
CREATE SCHEMA grafana_pi AUTHORIZATION pi_sessions;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
