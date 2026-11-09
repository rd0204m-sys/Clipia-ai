
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const app = express();

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(express.static("public"));
app.use("/outputs", express.static(path.resolve("outputs")));

const run = (args) => new Promise((resolve, reject) => {
  const p = spawn(ffmpegPath, args);
  let err = "";

  p.stderr.on("data", d => err += d.toString());

  p.on("error", reject);

  p.on("close", code => {
    code === 0
      ? resolve()
      : reject(new Error(err.slice(-2500)));
  });
});

const fmt = s => {
  const ms = Math.max(0, Math.floor(s * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor(ms % 3600000 / 60000)).padStart(2, "0");
  const sec = String(Math.floor(ms % 60000 / 1000)).padStart(2, "0");
  const milli = String(ms % 1000).padStart(3, "0");

  return `${h}:${m}:${sec},${milli}`;
};

app.post("/api/process", upload.single("video"), async (req, res) => {
  const temp = req.file?.path;
  const work = path.join(os.tmpdir(), "clipia-" + crypto.randomUUID());

  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Selecciona un video primero."
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Falta configurar OPENAI_API_KEY."
      });
    }

    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync("outputs", { recursive: true });

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    // 1. Extraer audio
    const audio = path.join(work, "audio.mp3");

    await run([
      "-y", "-i", temp,
      "-vn", "-ac", "1",
      "-ar", "16000",
      "-b:a", "48k",
      audio
    ]);

    // 2. Obtener duración
    const durationProbe = await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ["-i", audio]);
      let output = "";

      p.stderr.on("data", d => output += d.toString());

      p.on("error", reject);

      p.on("close", () => {
        const match = output.match(
          /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/
        );

        if (!match) {
          reject(new Error("No se pudo leer la duración."));
        } else {
          resolve(
            Number(match[1]) * 3600 +
            Number(match[2]) * 60 +
            Number(match[3])
          );
        }
      });
    });

    if (durationProbe < 30) {
      throw new Error("El video es demasiado corto.");
    }

    // 3. Dividir audio para transcripción
    const chunkSeconds = 480;
    const transcriptSegments = [];

    for (let start = 0; start < durationProbe; start += chunkSeconds) {
      const chunk = path.join(work, `audio-${start}.mp3`);

      await run([
        "-y", "-ss", String(start),
        "-i", audio,
        "-t", String(chunkSeconds),
        "-c", "copy",
        chunk
      ]);

      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(chunk),
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["segment"]
      });

      for (const seg of (tr.segments || [])) {
        transcriptSegments.push({
          start: Number(seg.start) + start,
          end: Number(seg.end) + start,
          text: seg.text.trim()
        });
      }

      fs.unlinkSync(chunk);
    }

    if (!transcriptSegments.length) {
      throw new Error("No se detectó suficiente voz.");
    }

    // 4. Analizar momentos destacados
    const transcript = transcriptSegments
      .map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
      .join("\n");

    const pick = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
Eres un editor profesional de videos virales.

Selecciona exactamente 5 momentos destacados.

Cada clip debe:
- Durar entre 30 y 60 segundos.
- Tener un inicio atractivo.
- Mantener contexto.
- Evitar cortes a mitad de frase.
- Tener potencial para TikTok, Reels y Shorts.
- No inventar frases.

Devuelve JSON:
{
  "clips": [
    {
      "start": 0,
      "end": 40,
      "title": "Título",
      "reason": "Motivo"
    }
  ]
}

Los tiempos deben corresponder al video original.
Ordena los clips por potencial de retención.
`
        },
        {
          role: "user",
          content: `Duración: ${durationProbe} segundos.\n${transcript}`
        }
      ]
    });

    const parsed = JSON.parse(
      pick.choices[0].message.content || "{}"
    );

    const clips = (parsed.clips || [])
      .map(c => ({
        ...c,
        start: Number(c.start),
        end: Number(c.end)
      }))
      .filter(c =>
        Number.isFinite(c.start) &&
        Number.isFinite(c.end) &&
        c.start >= 0 &&
        c.end <= durationProbe &&
        c.end - c.start >= 30 &&
        c.end - c.start <= 60
      )
      .slice(0, 5);

    if (clips.length !== 5) {
      throw new Error(
        "La IA no encontró exactamente 5 momentos de 30 a 60 segundos. Prueba con un video más largo."
      );
    }

    // 5. Crear los cinco videos
    const id = crypto.randomUUID();
    const results = [];

    for (let i = 0; i < 5; i++) {
      const c = clips[i];
      const start = c.start;
      const end = c.end;

      const selected = transcriptSegments.filter(
        s => s.end >= start && s.start <= end
      );

      const srt = selected.map((s, n) => {
        const a = Math.max(0, s.start - start);
        const b = Math.max(a + 0.2, Math.min(end - start, s.end - start));

        return `${n + 1}\n${fmt(a)} --> ${fmt(b)}\n${s.text}\n`;
      }).join("\n");

      const srtPath = path.join(work, `${i + 1}.srt`);
      fs.writeFileSync(srtPath, srt, "utf8");

      const outName = `${id}-${i + 1}.mp4`;
      const outPath = path.resolve("outputs", outName);

      const escapedSrt = srtPath
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'");

      await run([
        "-y",
        "-ss", String(start),
        "-i", temp,
        "-t", String(end - start),
        "-vf",
        `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles='${escapedSrt}':force_style='FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=130'`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outPath
      ]);

      results.push({
        title: c.title || `Clip ${i + 1}`,
        reason: c.reason || "Momento destacado",
        start,
        end,
        duration: end - start,
        video: `/outputs/${outName}`
      });
    }

    res.json({
      success: true,
      clips: results,
      total: results.length
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: e.message || "Error procesando el video."
    });

  } finally {
    if (temp && fs.existsSync(temp)) {
      fs.unlinkSync(temp);
    }

    fs.rmSync(work, {
      recursive: true,
      force: true
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Clipia AI lista en puerto ${port}`);
});

