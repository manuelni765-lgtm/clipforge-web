# CLIPFORGE - backend privado local

GitHub Pages sigue siendo la interfaz. Este servicio corre en TU computador y solo escucha en 127.0.0.1; no lo publiques directamente en Internet.

## Windows
1. Instala Python 3.11+ y FFmpeg (incluye ffprobe) y asegúrate de que ambos estén en PATH. Instala cloudflared desde la [página oficial de descargas](https://developers.cloudflare.com/tunnel/downloads/).
2. Abre PowerShell en backend y ejecuta Set-ExecutionPolicy -Scope Process Bypass y luego ./start_windows.ps1. El script instala las dependencias Python dentro de .venv.
3. La primera ejecución crea backend/.env con un token aleatorio privado. Copia el token que muestra la consola. No subas .env a GitHub.
4. En otra consola ejecuta cloudflared tunnel --url http://127.0.0.1:8765.
5. Copia la URL https://....trycloudflare.com que imprime cloudflared y pégala en el campo Backend de CLIPFORGE; pega también el token.

El enlace rápido de Cloudflare cambia al reiniciar el túnel. Mantén abiertas ambas consolas y el computador encendido. La URL temporal es accesible públicamente, pero todas las rutas de extracción/exportación exigen token Bearer. No compartas el token. El backend limita a dos trabajos simultáneos y acepta solo YouTube, Kick y Twitch por HTTPS.

## Linux/macOS
Instala Python 3.11+, FFmpeg y cloudflared; ejecuta ./start_linux.sh y, en otra terminal, cloudflared tunnel --url http://127.0.0.1:8765.

## Funciones y límites
- yt-dlp inspecciona enlaces y descarga VODs a los que ya tienes acceso; no usa cookies ajenas, no evade DRM, muros de pago ni controles de acceso.
- Directos activos: FFmpeg captura el intervalo indicado desde el momento seleccionado. No recupera segmentos anteriores al inicio de la captura.
- Análisis real: energía RMS de audio y cambios de escena con FFmpeg. Transcripción opcional con Faster-Whisper local instalando requirements-whisper.txt y configurando CLIPFORGE_WHISPER_MODEL (el primer uso descarga el modelo; no llama a una API de pago).
- Exporta MP4 H.264/AAC vertical 9:16 con audio original sincronizado. Las zonas de cámara/juego se pueden ajustar en la interfaz; la cámara debe estar visible en la grabación original.
- El soporte depende de los cambios de cada plataforma. Un VOD privado, eliminado, geobloqueado, que exija login/membresía o tenga DRM no se procesa. Algunos directos no exponen un flujo compatible.
- Los trabajos se guardan en backend/work; borra esa carpeta para liberar espacio. Detén cloudflared cuando termines.
