# CLIPFORGE WEB

Aplicación web estática para crear clips verticales a partir de archivos de video. Se publica gratis en GitHub Pages y procesa el video localmente en el navegador; no sube el archivo a un servicio externo.

## Funciones incluidas
- Cargar un archivo local de video compatible con el navegador.
- Analizar cambios visuales entre fotogramas y sugerir segmentos. Es una heurística, no IA semántica.
- Elegir cantidad y duración, ajustar inicio y duración de cada clip.
- Recortar regiones de cámara y gameplay para componer un video vertical 9:16.
- Exportar con MediaRecorder y descargar clips individualmente.
- Generar, editar y copiar títulos, descripciones y hashtags usando plantillas locales gratuitas.

## Límites importantes
- GitHub Pages sirve HTML, CSS y JavaScript estáticos: no ejecuta Python, FFmpeg ni yt-dlp.
- Esta versión estática no descarga directamente VODs de Kick o Twitch. Sus páginas requieren un backend y acceso permitido por la plataforma; los enlaces directos MP4/WebM solo sirven si el servidor permite CORS.
- La detección de momentos es heurística visual; no entiende semánticamente la jugada ni escucha conversaciones.
- La exportación depende del soporte del navegador para Canvas captureStream, MediaRecorder y AudioContext. El formato puede ser MP4 o WebM según el dispositivo.
- El procesamiento ocurre en tiempo real en el dispositivo. En teléfonos, videos largos o resoluciones altas pueden agotar memoria o batería; mantener la pestaña abierta durante la exportación.
- El generador de descripciones usa plantillas, no un modelo de IA.

## Publicación
El workflow `.github/workflows/pages.yml` despliega el contenido de la raíz del repositorio en GitHub Pages cuando hay un push a `main`.

URL pública prevista: https://manuelni765-lgtm.github.io/clipforge-web/

## Archivos
- `index.html`: interfaz.
- `style.css`: estilos adaptables a móvil.
- `app.js`: análisis local, edición de recortes, renderizado en navegador y generador de descripciones.
