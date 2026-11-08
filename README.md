# Clipia AI — primera versión funcional

Esta es una aplicación web MVP: subes un video, la app transcribe el audio, pide a la IA que seleccione momentos destacados y crea clips verticales con subtítulos incrustados (si el FFmpeg incluido tiene soporte de subtítulos).

## Qué necesitas
- Una computadora (Windows, macOS o Linux).
- Node.js 20 o superior.
- Una clave de API de OpenAI con facturación/crédito habilitado.
- Conexión a internet durante el procesamiento.

## Cómo ejecutarla
1. Descomprime el ZIP.
2. Abre una terminal dentro de la carpeta `clipia-ai`.
3. Ejecuta `npm install`.
4. Configura tu clave API como variable de entorno `OPENAI_API_KEY`. No la compartas ni la pongas en el código fuente.
   - Windows PowerShell: `$env:OPENAI_API_KEY="TU_CLAVE"`
   - macOS/Linux: `export OPENAI_API_KEY="TU_CLAVE"`
5. Ejecuta `npm start`.
6. Abre `http://localhost:3000` en el navegador.

## Qué hace
- Acepta videos de hasta 500 MB.
- Extrae y divide el audio en fragmentos de 8 minutos.
- Transcribe con marcas de tiempo usando `whisper-1`.
- Selecciona hasta 8 momentos con `gpt-4o-mini`.
- Exporta clips MP4 verticales 1080x1920.
- Intenta incrustar subtítulos. Si el FFmpeg no soporta el filtro `subtitles`, genera el video y entrega un archivo SRT aparte.

## Límites importantes
- Este proyecto es un MVP local, no está publicado en internet ni tiene cuentas de usuario.
- La API de OpenAI tiene costos variables; el usuario paga el uso de su propia cuenta.
- El análisis depende de que el video tenga voz clara. La IA estima potencial de retención; no puede garantizar viralidad.
- Los archivos procesados se guardan en `outputs/`. Borra esa carpeta cuando quieras limpiar resultados.
- No subas videos privados o material del que no tengas permiso para editar.

## Próximas mejoras
Publicarlo en un hosting, cola de trabajos para videos largos, selección de idioma, estilos de subtítulos, detección de silencios, encuadre inteligente de rostros y panel para editar los tiempos antes de exportar.
