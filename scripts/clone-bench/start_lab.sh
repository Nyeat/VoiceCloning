#!/usr/bin/env bash
# Install/start the UI service after install_lab.py has prepared model environments.
set -euo pipefail
LAB_ROOT="${CLONE_LAB_ROOT:-/opt/zero-shot-lab}"
if [[ "$LAB_ROOT" != /opt/zero-shot-lab ]]; then
  echo 'The checked-in systemd service uses /opt/zero-shot-lab.' >&2
  exit 1
fi
test -x "$LAB_ROOT/envs/ui/bin/python"
test -f "$LAB_ROOT/app/app.py"
install -d -o ubuntu -g ubuntu "$LAB_ROOT/runs" "$LAB_ROOT/logs" "$LAB_ROOT/status" "$LAB_ROOT/cache"
mkdir -p "$LAB_ROOT/app/.gradio"
chown -R ubuntu:ubuntu "$LAB_ROOT/app/.gradio"
touch "$LAB_ROOT/gpu.lock"
chown ubuntu:ubuntu "$LAB_ROOT/gpu.lock"
if [[ -d /root/nltk_data ]]; then
  mkdir -p "$LAB_ROOT/cache/nltk"
  cp -an /root/nltk_data/. "$LAB_ROOT/cache/nltk/"
fi
python3 - <<'PY'
import json, secrets
from pathlib import Path
p=Path('/opt/zero-shot-lab/access.json')
if not p.exists():
    p.write_text(json.dumps({'username':'voice-lab','password':secrets.token_urlsafe(15)}))
p.chmod(0o600)
PY
# Model libraries write caches/configuration inside their repositories.
chown -R ubuntu:ubuntu "$LAB_ROOT/repos" "$LAB_ROOT/cache" "$LAB_ROOT/runs" "$LAB_ROOT/status" "$LAB_ROOT/logs" "$LAB_ROOT/access.json"
cat > /etc/systemd/system/zero-shot-lab.service <<'UNIT'
[Unit]
Description=Private zero-shot voice evaluation lab
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/zero-shot-lab/app
Environment=HF_HOME=/opt/zero-shot-lab/cache/huggingface
Environment=NLTK_DATA=/opt/zero-shot-lab/cache/nltk
Environment=GRADIO_TEMP_DIR=/opt/zero-shot-lab/cache/gradio
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/zero-shot-lab/envs/ui/bin/python -u /opt/zero-shot-lab/app/app.py
Restart=on-failure
RestartSec=10
KillMode=control-group
TimeoutStopSec=20
NoNewPrivileges=true
UMask=0077
StandardOutput=append:/opt/zero-shot-lab/logs/ui.log
StandardError=append:/opt/zero-shot-lab/logs/ui.log

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now zero-shot-lab
echo 'UI started. Read its HTTPS address in /opt/zero-shot-lab/logs/ui.log.'
echo 'The instance shutdown schedule is separate; this script does not change it.'
