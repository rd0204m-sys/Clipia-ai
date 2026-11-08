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
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });
app.use(express.static("public"));
app.use("/outputs", express.static(path.resolve("outputs")));

const run = (args) => new Promise((resolve, reject) => {
  const p = spawn(ffmpegPath, args);
  let err = "";
  p.stderr.on("data", d => err += d.toString());
  p.on("close", code => code === 0 ? resolve() : reject(new Error(err.slice(-2500))));
});

const safeName = s => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const fmt = s => {
  const ms = Math.max(0, Math.floor(s * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2,"0");
  const m = String(Math.floor(ms % 3600000 / 60000)).padStart(2,"0");
  const sec = String(Math.floor(ms % 60000 / 1000)).padStart(2,"0");
  const milli = String(ms % 1000).padStart(3,"0");
  return `${h}:${m}:${sec},${milli}`;
};
const escapeAss = s => s.replace(/[{}]/g, "").replace(/\n/g, " ");

app.post("/api/process", upload.single("video"), async (req, res) => {
  const temp = req.file?.path;
  const work = path.join(os.tmpdir(), "clipia-" + crypto.randomUUID());
  try {
    if (!req.file) return res.status(400).json({ error: "Selecciona un video primero." });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Falta OPENAI_API_KEY. Consulta README." });
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync("outputs", { recursive: true });
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const audio = path.join(work, "audio.mp3");
    await run(["-y","-i",temp,"-vn","-ac","1","-ar","16000","-b:a","48k",audio]);

    // Split audio into 8-minute pieces to stay within transcription upload limits.
    const stat = await fs.promises.stat(audio);
    const durationProbe = await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ["-i", audio]);
      let out = "";
      p.stderr.on("data", d => out += d.toString());
      p.on("close", () => {
        const match = out.match(/Duration: (\\d+):(\\d+):(\\d+(?:\\.\\d+)?)/);
        if (!match) reject(new Error("No se pudo leer la duración del audio."));
        else resolve(Number(match[1])*3600 + Number(match[2])*60 + Number(match[3]));
      });
    });
    const chunkSeconds = 480;
    const transcriptSegments = [];
    for (let start = 0; start < durationProbe; start += chunkSeconds) {
      const chunk = path.join(work, `audio-${start}.mp3`);
      await run(["-y","-ss",String(start),"-i",audio,"-t",String(chunkSeconds),"-c","copy",chunk]);
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
    if (!transcriptSegments.length) throw new Error("No se detectó voz suficiente para crear subtítulos.");

    const transcript = transcriptSegments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n");
    const pick = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Eres editor experto de clips cortos para TikTok, Reels y Shorts. Selecciona momentos con gancho, emoción, humor, sorpresa, opinión fuerte o información útil. No inventes frases. Devuelve JSON con la clave clips: array de objetos {start,end,title,reason}. Los tiempos deben estar dentro de la transcripción, duración de cada clip entre 20 y 60 segundos. Evita cortes a mitad de frase. Ordena por potencial de retención. Máximo 8 clips." },
        { role: "user", content: `Duración total: ${durationProbe.toFixed(1)} segundos. Transcripción con tiempos:\n${transcript}` }
      ]
    });
    const parsed = JSON.parse(pick.choices[0].message.content || "{}");
    const clips = (parsed.clips || []).filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.end-c.start >= 12)
      .slice(0,8);
    if (!clips.length) throw new Error("La IA no encontró momentos adecuados. Prueba con otro video más claro o con más conversación.");

    const id = crypto.randomUUID();
    const results = [];
    for (let i=0; i<clips.length; i++) {
      const c = clips[i];
      const start = Math.max(0, Number(c.start));
      const end = Math.min(durationProbe, Number(c.end));
      const selected = transcriptSegments.filter(s => s.end >= start && s.start <= end);
      const srt = selected.map((s, n) => {
        const a = Math.max(0, s.start-start);
        const b = Math.max(a+0.2, Math.min(end-start, s.end-start));
        return `${n+1}\n${fmt(a)} --> ${fmt(b)}\n${s.text}\n`;
      }).join("\n");
      const outName = `${id}-${i+1}.mp4`;
      const outPath = path.resolve("outputs", outName);
      const srtPath = path.join(work, `${i+1}.srt`);
      fs.writeFileSync(srtPath, srt, "utf8");
      // Vertical 9:16 crop. Burn subtitles; if the FFmpeg build lacks libass, return the SRT separately.
      const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
      try {
        await run(["-y","-ss",String(start),"-i",temp,"-t",String(end-start),
          "-vf",`scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles='${escapedSrt}':force_style='FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=130'`,
          "-c:v","libx264","-preset","veryfast","-crf","23","-c:a","aac","-b:a","128k","-movflags","+faststart",outPath]);
        results.push({ title: c.title || `Clip ${i+1}`, reason: c.reason || "Momento destacado", start, end, video: `/outputs/${outName}` });
      } catch (e) {
        const fallbackName = `${id}-${i+1}-sin-subtitulos.mp4`;
        const fallbackPath = path.resolve("outputs", fallbackName);
        await run(["-y","-ss",String(start),"-i",temp,"-t",String(end-start),
          "-vf","scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
          "-c:v","libx264","-preset","veryfast","-crf","23","-c:a","aac","-b:a","128k","-movflags","+faststart",fallbackPath]);
        const srtOut = path.resolve("outputs", `${id}-${i+1}.srt`);
        fs.copyFileSync(srtPath, srtOut);
        results.push({ title: c.title || `Clip ${i+1}`, reason: c.reason || "Momento destacado", start, end, video: `/outputs/${fallbackName}`, subtitles: `/outputs/${id}-${i+1}.srt`, note: "Subtítulos disponibles como archivo SRT separado." });
      }
    }
    res.json({ clips: results, transcript: transcriptSegments.length + " segmentos de transcripción" });
  } catch (e) {
    res.status(500).json({ error: e.message || "Ocurrió un error procesando el video." });
  } finally {
    if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Clipia AI lista en http://localhost:${port}`));
