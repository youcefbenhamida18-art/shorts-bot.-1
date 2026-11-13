import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { run, pick, listAudio, probeDuration } from "./util.js";

export const DURATION = 9; // seconds – the whole video
const W = 1080;
const H = 1920;
const FONT = '"Noto Sans Arabic", "Noto Naskh Arabic", "DejaVu Sans", sans-serif';

/* ---------------------------- fonts ---------------------------- */
let fontsReady = false;
function loadFonts() {
  if (fontsReady) return;
  try {
    GlobalFonts.loadSystemFonts();
  } catch {}
  const dir = path.resolve("assets/fonts"); // drop your own .ttf here (optional)
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (/\.(ttf|otf)$/i.test(f)) GlobalFonts.registerFromPath(path.join(dir, f));
    }
  }
  fontsReady = true;
}

/* -------------------------- captions --------------------------- */
function wrap(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function makeCaption(text, file, { color = "#FFE600", y = 1180, badge = "" } = {}) {
  loadFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.direction = "rtl";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let size = 112;
  let lines;
  for (; size >= 64; size -= 6) {
    ctx.font = `bold ${size}px ${FONT}`;
    lines = wrap(ctx, text, 900);
    if (lines.length <= 3) break;
  }
  const lh = size * 1.35;
  const boxH = lines.length * lh + 70;
  const boxY = y - boxH / 2;

  // dark rounded card for readability
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.roundRect(60, boxY, W - 120, boxH, 48);
  ctx.fill();

  ctx.lineJoin = "round";
  ctx.lineWidth = Math.round(size / 9);
  ctx.strokeStyle = "#000";
  ctx.fillStyle = color;
  lines.forEach((l, i) => {
    const ly = boxY + 35 + lh * i + lh / 2;
    ctx.strokeText(l, W / 2, ly);
    ctx.fillText(l, W / 2, ly);
  });

  if (badge) {
    ctx.direction = "ltr";
    ctx.font = `bold 44px ${FONT}`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 6;
    ctx.strokeText(badge, W / 2, 1640);
    ctx.fillText(badge, W / 2, 1640);
  }

  fs.writeFileSync(file, canvas.toBuffer("image/png"));
  return file;
}

/* ----------------------------- sfx ----------------------------- */
async function synth(file, expr, ...extra) {
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", expr, ...extra, file]);
  return file;
}

async function chooseSfx(tmp) {
  const start = listAudio("assets/sfx/start");
  const end = listAudio("assets/sfx/end");
  return {
    start: start.length
      ? pick(start)
      : await synth(path.join(tmp, "pop.wav"), "aevalsrc=0.8*sin(2*PI*900*t)*exp(-25*t):d=0.25:s=44100"),
    end: end.length
      ? pick(end)
      : await synth(
          path.join(tmp, "boing.wav"),
          "aevalsrc=0.7*sin(2*PI*(350+250*sin(2*PI*7*t))*t)*exp(-2.5*t):d=0.9:s=44100"
        ),
  };
}

/* ---------------------------- render --------------------------- */
/**
 * bg: { type: "video"|"image", file }
 * pcm: Buffer (24kHz s16le mono) with the spoken joke
 */
export async function renderShort({ bg, pcm, setup, punchline, outFile, tmp }) {
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // 1) voice -> wav, speed up if longer than the video allows
  const pcmFile = path.join(tmp, "voice.pcm");
  const voiceWav = path.join(tmp, "voice.wav");
  fs.writeFileSync(pcmFile, pcm);
  await run("ffmpeg", ["-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcmFile, voiceWav]);
  const rawDur = await probeDuration(voiceWav);
  const VOICE_START = 0.35;
  const maxVoice = DURATION - VOICE_START - 0.9;
  const tempo = rawDur > maxVoice ? Math.min(rawDur / maxVoice, 1.7) : 1;
  const voiceDur = rawDur / tempo;

  // 2) caption timing follows the voice (setup first, punchline after)
  const sw = setup.split(/\s+/).length;
  const pw = punchline.split(/\s+/).length;
  const t1 = Math.min(6, Math.max(2.4, VOICE_START + (voiceDur * sw) / (sw + pw)));
  const reactAt = Math.min(DURATION - 1.1, VOICE_START + voiceDur + 0.1);

  const cap1 = makeCaption(setup, path.join(tmp, "cap1.png"), { color: "#FFFFFF", badge: process.env.CHANNEL_NAME || "" });
  const cap2 = makeCaption(punchline, path.join(tmp, "cap2.png"), { color: "#FFE600", badge: process.env.CHANNEL_NAME || "" });

  // 3) sound design
  const sfx = await chooseSfx(tmp);
  const music = listAudio("assets/music");
  const musicFile = music.length ? pick(music) : null;

  // 4) assemble ffmpeg command
  const inputs = [];
  let bgFilter;
  if (bg.type === "video") {
    inputs.push("-stream_loop", "-1", "-i", bg.file);
    bgFilter =
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,` +
      `eq=saturation=1.18:contrast=1.06:brightness=0.02[bg]`;
  } else {
    inputs.push("-i", bg.file); // single frame -> Ken Burns zoom
    bgFilter =
      `[0:v]scale=1296:2304:force_original_aspect_ratio=increase,crop=1296:2304,` +
      `zoompan=z='min(1+0.0011*on,1.28)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${DURATION * 30}:s=${W}x${H}:fps=30,` +
      `eq=saturation=1.15:contrast=1.05[bg]`;
  }
  inputs.push("-loop", "1", "-i", cap1); // 1
  inputs.push("-loop", "1", "-i", cap2); // 2
  inputs.push("-i", voiceWav); // 3
  inputs.push("-i", sfx.start); // 4
  inputs.push("-i", sfx.end); // 5
  if (musicFile) inputs.push("-stream_loop", "-1", "-i", musicFile); // 6

  const ms = (s) => Math.round(s * 1000);
  const filters = [
    bgFilter,
    `[bg][1:v]overlay=0:0:enable='between(t,0,${t1.toFixed(2)})'[v1]`,
    `[v1][2:v]overlay=0:0:enable='gte(t,${t1.toFixed(2)})',fade=t=in:d=0.2,fade=t=out:st=${DURATION - 0.3}:d=0.3[v]`,
    `[3:a]atempo=${tempo.toFixed(3)},volume=1.8,adelay=${ms(VOICE_START)}|${ms(VOICE_START)}[voice]`,
    `[4:a]volume=0.9[pop]`,
    `[5:a]volume=0.7,adelay=${ms(reactAt)}|${ms(reactAt)}[react]`,
  ];
  let mixIn = "[voice][pop][react]";
  let n = 3;
  if (musicFile) {
    filters.push(`[6:a]volume=0.14,afade=t=out:st=${DURATION - 1}:d=1[mus]`);
    mixIn += "[mus]";
    n = 4;
  }
  filters.push(
    `${mixIn}amix=inputs=${n}:duration=longest:normalize=0,alimiter=limit=0.95,atrim=0:${DURATION},afade=t=out:st=${DURATION - 0.4}:d=0.4[a]`
  );

  await run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-t", String(DURATION),
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-movflags", "+faststart",
    outFile,
  ]);
  return outFile;
}
