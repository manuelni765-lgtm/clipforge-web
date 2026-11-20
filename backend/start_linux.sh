#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  printf 'CLIPFORGE_TOKEN=%s\nCLIPFORGE_WHISPER_MODEL=\n' "$TOKEN" > .env
  chmod 600 .env
  echo "Token privado (cópialo al teléfono, no lo publiques): $TOKEN"
fi
set -a; source .env; set +a
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11 o superior es obligatorio"'
command -v ffmpeg >/dev/null || { echo 'Falta FFmpeg'; exit 1; }
command -v ffprobe >/dev/null || { echo 'Falta ffprobe'; exit 1; }
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
exec uvicorn main:app --host 127.0.0.1 --port 8765
