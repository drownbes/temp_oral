#!/usr/bin/env bash
# Local Grafana with Tempo + VictoriaLogs datasources provisioned from dev/grafana.
# GRAFANA_HOME and GRAFANA_PLUGINS_DIR come from the flake devShell.
set -euo pipefail

mkdir -p .data/grafana/logs
export GF_PATHS_DATA="$PWD/.data/grafana"
export GF_PATHS_LOGS="$PWD/.data/grafana/logs"
export GF_PATHS_PLUGINS="$GRAFANA_PLUGINS_DIR"
export GF_PATHS_PROVISIONING="$PWD/dev/grafana/provisioning"
export GF_SERVER_HTTP_ADDR=127.0.0.1
export GF_SERVER_HTTP_PORT=3000
export GF_AUTH_ANONYMOUS_ENABLED=true
export GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
export GF_AUTH_DISABLE_LOGIN_FORM=true
export GF_ANALYTICS_REPORTING_ENABLED=false
export GF_ANALYTICS_CHECK_FOR_UPDATES=false
export GF_LOG_LEVEL=warn

exec grafana server --homepath "$GRAFANA_HOME"
