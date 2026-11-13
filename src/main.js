import fs from "node:fs";
import path from "node:path";
import { generateIdea, speak, generateImage } from "./ai.js";
import { findStockVideo } from "./media.js";
import { renderShort } from "./render.js";
import { uploadToYouTube } from "./youtube.js";

/* ---------------------------- settings ---------------------------- */
const VIDEOS_PER_RUN = Number(process.env.VIDEOS_PER_RUN || 3);
// Best local posting times (HH:MM). Defaults: lunch break, after work, prime time.
const SLOTS = (process.env.POST_SLOTS || "12:30,18:00,21:00").split(",").map((s) => s.trim());
// Your timezone offset from UTC in hours (Algeria/Morocco = 1, Saudi/Iraq = 3, Egypt = 2/3 ...)
const TZ_OFFSET = Number(process.env.TZ_OFFSET_HOURS ?? 1);
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const OUT = path.resolve("out");
const TMP = path.resolve("tmp");
const HISTORY_FILE = path.resolve("data/history.json");

/* ----------------------------- history ----------------------------- */
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return { used: [], titles: [] };
  }
}
function saveHistory(h) {
  h.used = h.used.slice(-300);
  h.titles = h.titles.slice(-200);
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2));
}

/* ----------------------------- schedule ---------------------------- */
/** Next occurrence of each HH:MM slot (in local time) as an ISO UTC string. */
function scheduleTimes(count) {
  const now = Date.now();
  const local = new Date(now + TZ_OFFSET * 3600_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const times = [];
  let dayShift = 0;
  while (times.length < count) {
    for (const slot of SLOTS) {
      const [hh, mm] = slot.split(":").map(Number);
      const t = Date.UTC(y, m, d + dayShift, hh, mm) - TZ_OFFSET * 3600_000;
      if (t > now + 20 * 60_000) times.push(new Date(t).toISOString());
      if (times.length >= count) break;
    }
    dayShift++;
  }
  return times;
}

/* ------------------------------ main ------------------------------- */
async function makeOne(i, publishAt, history) {
  console.log(`\n===== Video ${i + 1} =====`);
  const idea = await generateIdea(history);
  console.log("Idea:", idea.setup, "|", idea.punchline);

  // background: real stock footage first, AI photo as fallback
  let bg;
  const stock = await findStockVideo(idea.bgQuery || "funny cat", history.used, TMP).catch((e) => {
    console.warn("Pixabay failed:", e.message);
    return null;
  });
  if (stock) {
    bg = { type: "video", file: stock.file };
    history.used.push(stock.id);
  } else {
    console.log("No stock video – generating image with Cloudflare Flux");
    const img = path.join(TMP, `bg-${i}.jpg`);
    await generateImage(idea.imagePrompt || "a funny surprised cat looking at the camera", img, fs);
    bg = { type: "image", file: img };
  }

  const pcm = await speak(idea.setup, idea.punchline, idea.mood);
  const outFile = path.join(OUT, `short-${Date.now()}-${i + 1}.mp4`);
  await renderShort({ bg, pcm, setup: idea.setup, punchline: idea.punchline, outFile, tmp: path.join(TMP, `v${i}`) });
  console.log("Rendered:", outFile);

  const hashtags = "#Shorts #ضحك #قطط #funny #cats #fyp #viral";
  const title = `${idea.title} #Shorts`;
  const description = `${idea.description}\n\n${hashtags}`;
  const tags = [...idea.tags, "shorts", "funny", "cats", "ضحك", "قطط", "viral"];

  if (DRY_RUN) {
    console.log("DRY_RUN – skipping upload. Would schedule at", publishAt);
  } else {
    const id = await uploadToYouTube({ file: outFile, title, description, tags, publishAt });
    console.log(`Uploaded https://youtube.com/shorts/${id} (publishes ${publishAt})`);
  }
  history.titles.push(idea.title);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  const history = loadHistory();
  const times = scheduleTimes(VIDEOS_PER_RUN);
  console.log("Schedule (UTC):", times.join(", "));

  let ok = 0;
  for (let i = 0; i < VIDEOS_PER_RUN; i++) {
    try {
      await makeOne(i, times[i], history);
      ok++;
    } catch (e) {
      console.error(`Video ${i + 1} failed:`, e.message);
    }
    saveHistory(history);
  }
  console.log(`\nDone: ${ok}/${VIDEOS_PER_RUN} videos`);
  if (ok === 0) process.exit(1);
}

main();
