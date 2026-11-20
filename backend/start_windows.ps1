$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path '.env')) {
  $bytes = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  @("CLIPFORGE_TOKEN=$token", "CLIPFORGE_WHISPER_MODEL=") | Set-Content -Encoding ascii '.env'
  Write-Host "Token privado creado en backend\.env" -ForegroundColor Green
  Write-Host "Copia este token en CLIPFORGE del teléfono (no lo publiques): $token" -ForegroundColor Yellow
}
$envLines = Get-Content '.env' | Where-Object { $_ -match '^\s*[^#].*=.*$' }
foreach ($line in $envLines) { $pair = $line -split '=',2; [Environment]::SetEnvironmentVariable($pair[0],$pair[1],'Process') }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw 'FFmpeg no está instalado o no está en PATH. Instálalo primero.' }
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { throw 'ffprobe no está instalado o no está en PATH. Instala la versión completa de FFmpeg.' }
if (-not (Test-Path '.venv')) { py -3.11 -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
Write-Host 'Backend protegido en http://127.0.0.1:8765' -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8765
