# CLIPFORGE WEB

Aplicación original publicada en GitHub Pages: https://manuelni765-lgtm.github.io/clipforge-web/

## Modos de trabajo
- Archivo local: el navegador analiza cambios visuales y exporta clips en el dispositivo.
- Enlace de YouTube, YouTube Live, Kick y Twitch: usa el backend privado en la carpeta backend. Detecta el estado del enlace, extrae VODs accesibles con yt-dlp o captura un intervalo de un directo con FFmpeg, analiza audio y cambios de escena y exporta MP4 vertical 9:16.
- Generador local de títulos, descripciones y hashtags para YouTube Shorts, Instagram Reels y TikTok. Usa plantillas gratuitas, no IA remota.

## Requisitos del modo enlace
GitHub Pages no ejecuta Python ni FFmpeg. El computador del usuario debe permanecer encendido con backend y túnel HTTPS activos. Sigue las instrucciones de backend/README.md. El backend escucha solo en localhost y exige un token privado Bearer para inspección, extracción, trabajos, render y descargas. No subas backend/.env ni compartas el token.

## Procesamiento autorizado
Solo se aceptan enlaces HTTPS de YouTube, Kick y Twitch. No se usan cookies de terceros ni se eluden DRM, muros de pago, membresías ni controles de acceso. Si el contenido está restringido o la plataforma no lo entrega, el trabajo se detiene y muestra el motivo disponible. El soporte de yt-dlp puede cambiar según la plataforma.

## Detección y exportación
La selección inicial combina energía RMS de audio y cambios de escena FFmpeg. Faster-Whisper puede instalarse opcionalmente para transcripción local; no está instalado ni activado por defecto. No se afirma comprensión semántica profunda. Los clips permiten ajustar inicio y duración de 15 a 180 segundos, seleccionar hasta 20 y exportar H.264/AAC vertical 9:16 con audio original sincronizado. Las zonas de cámara y juego se configuran en la interfaz; la cámara debe estar presente en el video original.

## Desarrollo
- Frontend: index.html, style.css, app.js, link-mode.js.
- Backend: backend/main.py y requirements.txt.
- GitHub Pages despliega desde la raíz mediante .github/workflows/pages.yml.
