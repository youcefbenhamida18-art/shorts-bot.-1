import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Run a command and resolve with stdout. Rejects with the tail of stderr. */
export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${err.slice(-2500)}`))
    );
  });
}

export async function retry(fn, { tries = 3, delay = 2000, label = "task" } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.warn(`[retry] ${label} failed (${i}/${tries}): ${String(e.message).slice(0, 300)}`);
      await sleep(delay * i);
    }
  }
  throw last;
}

export async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status} ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

/** List audio files in a folder (used for your own custom sounds). */
export function listAudio(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(mp3|wav|m4a|ogg|aac)$/i.test(f))
    .map((f) => path.join(dir, f));
}

export async function probeDuration(file) {
  const out = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  return parseFloat(out.trim());
}
