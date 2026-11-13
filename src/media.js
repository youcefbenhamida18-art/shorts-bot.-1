import path from "node:path";
import { download, pick } from "./util.js";

/**
 * Finds a real stock video on Pixabay (cats, funny animals…) that was not used before.
 * Returns { file, id } or null.
 */
export async function findStockVideo(query, usedIds, outDir) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return null;
  const queries = [query, "funny cat", "cute kitten", "cat"];
  for (const q of queries) {
    const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(q)}&per_page=50&safesearch=true`;
    const r = await fetch(url);
    if (!r.ok) continue;
    const data = await r.json();
    const hits = (data.hits || []).filter(
      (h) => h.duration >= 4 && !usedIds.includes(String(h.id)) && (h.videos?.large?.url || h.videos?.medium?.url)
    );
    if (!hits.length) continue;
    // prefer the most popular half so quality stays high
    const top = hits.slice(0, Math.max(5, Math.ceil(hits.length / 2)));
    const hit = pick(top);
    const v = hit.videos.large?.url ? hit.videos.large : hit.videos.medium;
    const file = path.join(outDir, `bg-${hit.id}.mp4`);
    await download(v.url, file);
    return { file, id: String(hit.id) };
  }
  return null;
}
