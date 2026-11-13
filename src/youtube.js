import fs from "node:fs";

async function accessToken() {
  const { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN } = process.env;
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    throw new Error("YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN missing");
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: YT_CLIENT_ID,
      client_secret: YT_CLIENT_SECRET,
      refresh_token: YT_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OAuth refresh failed: ${JSON.stringify(j)}`);
  return j.access_token;
}

/**
 * Uploads a video to YouTube. When `publishAt` (ISO string, future) is given the video is
 * uploaded as private and YouTube publishes it automatically at that time.
 */
export async function uploadToYouTube({ file, title, description, tags, publishAt }) {
  const token = await accessToken();
  const size = fs.statSync(file).size;

  const metadata = {
    snippet: {
      title: title.slice(0, 100),
      description,
      tags: tags.slice(0, 15),
      categoryId: "23", // Comedy
      defaultLanguage: "ar",
      defaultAudioLanguage: "ar",
    },
    status: {
      privacyStatus: publishAt ? "private" : "public",
      ...(publishAt ? { publishAt } : {}),
      selfDeclaredMadeForKids: false,
      embeddable: true,
    },
  };

  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!init.ok) throw new Error(`YouTube init ${init.status}: ${await init.text()}`);
  const location = init.headers.get("location");
  if (!location) throw new Error("YouTube did not return an upload URL");

  const put = await fetch(location, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: fs.readFileSync(file),
  });
  if (!put.ok) throw new Error(`YouTube upload ${put.status}: ${await put.text()}`);
  const video = await put.json();
  return video.id;
}
