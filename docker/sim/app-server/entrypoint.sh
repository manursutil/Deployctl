#!/bin/bash
set -euo pipefail

mkdir -p /opt/sherwood/releases /opt/sherwood/tenants

node /opt/deployctl/health-server.js &

exec tail -f /dev/null
