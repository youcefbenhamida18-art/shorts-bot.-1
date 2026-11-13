import { pick, retry, sleep } from "./util.js";

/* ------------------------------------------------------------------ *
 *  Gemini (3 keys rotated automatically when one hits its quota)      *
 * ------------------------------------------------------------------ */
const KEYS = ["GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"]
  .map((k) => process.env[k])
  .filter(Boolean);
let keyIndex = 0;

async function gemini(model, body) {
  if (!KEYS.length) throw new Error("No GEMINI_API_KEY configured");
  let last;
  for (let i = 0; i < KEYS.length * 2; i++) {
    const key = KEYS[keyIndex % KEYS.length];
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      }
    );
    if (r.ok) return r.json();
    const txt = await r.text();
    last = new Error(`Gemini ${model} ${r.status}: ${txt.slice(0, 300)}`);
    if ([403, 429, 500, 503].includes(r.status)) {
      keyIndex++; // rotate to next key
      await sleep(1500);
      continue;
    }
    throw last;
  }
  throw last;
}

/* ------------------------------------------------------------------ *
 *  Cloudflare Workers AI (fallback LLM + image generation)            *
 * ------------------------------------------------------------------ */
const CF = () => {
  const id = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!id || !token) throw new Error("CF_ACCOUNT_ID / CF_API_TOKEN missing");
  return { id, token };
};

async function cfRun(model, body) {
  const { id, token } = CF();
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${id}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`Cloudflare ${model} ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.result;
}

/** Photorealistic vertical image (used only when no stock video is found). */
export async function generateImage(prompt, file, fs) {
  const res = await cfRun("@cf/black-forest-labs/flux-1-schnell", {
    prompt: `Ultra realistic professional photo, vertical 9:16, sharp focus, cinematic lighting, vivid colors. ${prompt}`,
    steps: 6,
  });
  fs.writeFileSync(file, Buffer.from(res.image, "base64"));
  return file;
}

/* ------------------------------------------------------------------ *
 *  Idea generation: joke + title + tags + search keywords             *
 * ------------------------------------------------------------------ */
const THEMES = [
  "قط يتصرف كأنه موظف متعب يوم الاثنين",
  "قط يسقط الأشياء عن الطاولة عمداً",
  "قط ينظر إلى صاحبه بنظرة اتهام",
  "قطة تفكر في الحياة وتسخر منها",
  "جِراء كلاب مع قطط في مواقف طريفة",
  "نكتة سريعة عن المدرسة أو الامتحانات",
  "نكتة عن الأمهات والنعال",
  "نكتة عن الحمية الغذائية والجوع الليلي",
  "نكتة عن الهاتف والشاحن والبطارية 1%",
  "قط يتظاهر بأنه لم يفعل شيئاً",
  "قط خائف من الخيار أو من ظله",
  "نكتة عن النوم والاستيقاظ المبكر",
];

function buildPrompt(history) {
  const lang = process.env.LANG_NAME || "العربية (لهجة بيضاء بسيطة يفهمها الجميع)";
  return `أنت كاتب محتوى فيروسي لقناة Shorts كوميدية مدتها 9 ثوانٍ فقط.
اكتب نكتة/موقف طريف قصير جداً باللغة ${lang}.
الموضوع: ${pick(THEMES)}.
القواعد الصارمة:
- setup: جملة التشويق (من 4 إلى 8 كلمات فقط) تُلقى في أول 3 ثوانٍ وتشد المشاهد فوراً.
- punchline: القفلة المضحكة (من 3 إلى 8 كلمات) غير متوقعة.
- بدون إيموجي وبدون علامات غريبة داخل setup و punchline.
- لا تكرر أي عنوان من هذه القائمة: ${JSON.stringify(history.titles.slice(-30))}
- bgQuery: كلمتان أو ثلاث بالإنجليزية للبحث عن فيديو حقيقي في Pixabay (مثال: "funny cat", "kitten playing", "cat surprised").
- imagePrompt: وصف إنجليزي لصورة واقعية تناسب النكتة (قط غالباً).
- mood: واحدة من upbeat | excited | sarcastic | cute
- title: عنوان جذاب بالعربية أقل من 60 حرفاً، يحتوي إيموجي واحداً.
- description: سطرين مع هاشتاغات.
- tags: 8 كلمات مفتاحية.
أجب بـ JSON فقط بهذا الشكل:
{"setup":"","punchline":"","bgQuery":"","imagePrompt":"","mood":"","title":"","description":"","tags":[]}`;
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model output");
  return JSON.parse(m[0]);
}

export async function generateIdea(history) {
  const prompt = buildPrompt(history);
  let idea;
  try {
    const res = await retry(
      () =>
        gemini("gemini-2.5-flash", {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.1, responseMimeType: "application/json" },
        }),
      { label: "gemini idea" }
    );
    idea = parseJson(res.candidates[0].content.parts[0].text);
  } catch (e) {
    console.warn("Gemini failed, falling back to Cloudflare LLM:", e.message);
    const res = await cfRun("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600,
    });
    idea = parseJson(res.response);
  }
  if (!idea.setup || !idea.punchline) throw new Error("idea missing setup/punchline");
  idea.tags = Array.isArray(idea.tags) ? idea.tags : [];
  return idea;
}

/* ------------------------------------------------------------------ *
 *  Text-to-speech (Gemini TTS). Voice is chosen by the joke's mood.   *
 * ------------------------------------------------------------------ */
const VOICES = {
  upbeat: "Puck",
  excited: "Fenrir",
  sarcastic: "Algenib",
  cute: "Zephyr",
};

/** Returns raw PCM s16le @ 24kHz mono. */
export async function speak(setup, punchline, mood) {
  const voiceName = process.env.VOICE_NAME || VOICES[mood] || "Puck";
  const text = `Say this in a playful, fast, funny comedic voice, with a tiny dramatic pause before the last sentence: ${setup} ... ${punchline}`;
  const res = await retry(
    () =>
      gemini("gemini-2.5-flash-preview-tts", {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
    { label: "gemini tts", tries: 4 }
  );
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error("TTS returned no audio");
  return Buffer.from(part.inlineData.data, "base64");
}
