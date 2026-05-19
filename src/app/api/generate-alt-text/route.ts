import { NextRequest, NextResponse } from "next/server";

const MAX_ALT_LENGTH = 99;
const MAX_IMAGES = 12;
/** Per-image cap for base64 payload */
const MAX_IMAGE_DATA_URL_LENGTH = 8_000_000;
const MAX_FETCH_IMAGE_BYTES = 6 * 1024 * 1024;

/** Allow any image/* MIME; base64 marker case-insensitive for browser quirks */
const DATA_IMAGE_URL_RE = /^data:image\/.+;base64,/i;

const SYSTEM_PROMPT =
  "You write product-image ALT text for HTML img attributes (max 99 characters each). Describe only what is visible: brand, color, product type, key feature, context. Never use phrases like 'image of', 'picture of', or 'text in this image'. No promotional hype or keyword stuffing. Natural sentence case; do not use symbols such as | / _. Shorten if over 99 characters. Output only the alt text content. Follow the user's prompt for order (e.g. one line per image in sequence).";

function normalizeSources(body: Record<string, unknown>): {
  sources: string[];
  fallbacks: string[];
} | null {
  const fromData = (arr: unknown): string[] | null => {
    if (!Array.isArray(arr)) return null;
    const out: string[] = [];
    for (const item of arr) {
      if (typeof item !== "string" || !item.trim()) return null;
      const s = item.trim();
      if (s.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
      if (!DATA_IMAGE_URL_RE.test(s) && !/^https?:\/\//i.test(s)) return null;
      try {
        if (!s.startsWith("data:")) new URL(s);
      } catch {
        return null;
      }
      out.push(s);
    }
    return out.length ? out : null;
  };

  let sources: string[] | null = null;

  if (Array.isArray(body.imageDataUrls) && body.imageDataUrls.length > 0) {
    const onlyData = body.imageDataUrls.every(
      (x) => typeof x === "string" && DATA_IMAGE_URL_RE.test(x.trim())
    );
    if (onlyData) sources = fromData(body.imageDataUrls);
  }
  if (!sources && typeof body.imageDataUrl === "string" && body.imageDataUrl.trim()) {
    sources = fromData([body.imageDataUrl.trim()]);
  }
  if (!sources && Array.isArray(body.imageUrls) && body.imageUrls.length > 0) {
    sources = fromData(body.imageUrls);
  }
  if (!sources && typeof body.imageUrl === "string" && body.imageUrl.trim()) {
    sources = fromData([body.imageUrl.trim()]);
  }

  if (!sources?.length) return null;
  if (sources.length > MAX_IMAGES) return null;

  const fallbacks = sources.map((src, i) => {
    if (src.startsWith("data:")) return `Pasted or uploaded image ${i + 1}.`;
    try {
      const url = new URL(src);
      const pathname = url.pathname || "";
      const filename = pathname.split("/").filter(Boolean).pop() || "image";
      const nameWithoutExt = filename
        .replace(/\.[^.]+$/, "")
        .replace(/[-_]/g, " ")
        .trim();
      return nameWithoutExt.length > 1
        ? `Image: ${nameWithoutExt}`.slice(0, MAX_ALT_LENGTH)
        : `Image ${i + 1} from URL.`.slice(0, MAX_ALT_LENGTH);
    } catch {
      return `Image ${i + 1}.`;
    }
  });

  return { sources, fallbacks };
}

function parseModelOutputToLines(text: string, n: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^\s*(\d+[\).\]]|[-*•]|[A-Za-z][\).\]]\s*)\s*/, "")
        .trim()
    )
    .filter(Boolean);

  const alts: string[] = [];
  for (let i = 0; i < n; i++) {
    let line = lines[i] ?? "";
    if (line.length > MAX_ALT_LENGTH) line = line.slice(0, MAX_ALT_LENGTH);
    alts.push(line);
  }
  return alts;
}

function parseDataImageUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const idx = dataUrl.indexOf(";base64,");
  if (idx === -1) return null;
  const meta = dataUrl.slice(5, idx);
  if (!meta.toLowerCase().startsWith("image/")) return null;
  const mimeType = meta.split(";")[0].trim();
  const base64 = dataUrl.slice(idx + ";base64,".length);
  if (!mimeType || !base64) return null;
  return { mimeType, base64 };
}

/** Gemini REST uses snake_case for Part.inline_data (see AI Studio curl examples). */
async function sourceToGeminiImagePart(
  source: string
): Promise<{ inline_data: { mime_type: string; data: string } } | null> {
  if (source.startsWith("data:")) {
    const parsed = parseDataImageUrl(source);
    if (!parsed) return null;
    return {
      inline_data: { mime_type: parsed.mimeType, data: parsed.base64 },
    };
  }
  try {
    const url = new URL(source);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const res = await fetch(url.toString(), { redirect: "follow" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_FETCH_IMAGE_BYTES) return null;
    const ct = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    if (!ct.startsWith("image/")) return null;
    const data = Buffer.from(buf).toString("base64");
    return { inline_data: { mime_type: ct, data } };
  } catch {
    return null;
  }
}

/** Tried in order; per-minute 429 may succeed on another model. Daily quota stops after first 429. */
const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
] as const;

function gemini429Details(raw: string): {
  dailyLimit: boolean;
  retrySeconds?: number;
} {
  const dailyLimit =
    raw.includes("PerDayPerProjectPerModel") || /"limit":\s*0/i.test(raw);
  const m = raw.match(/retry in ([\d.]+)s/i);
  return {
    dailyLimit,
    retrySeconds: m ? Math.ceil(parseFloat(m[1])) : undefined,
  };
}

function keySuffix(key: string): string {
  const t = key.trim();
  return t.length >= 4 ? t.slice(-4) : "????";
}

function geminiModelsToTry(): string[] {
  const preferred = process.env.GEMINI_MODEL?.trim();
  const ordered = preferred
    ? [preferred, ...GEMINI_MODEL_FALLBACKS]
    : [...GEMINI_MODEL_FALLBACKS];
  return [...new Set(ordered)];
}

type GeminiJson = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
};

async function generateAltsWithGemini(
  sources: string[],
  userPrompt: string,
  apiKey: string
): Promise<{ alts: string[] | null; hint?: string }> {
  const n = sources.length;

  const instruction =
    userPrompt.trim() ||
    "Generate accessible ALT text for each image in the order they appear (first attachment = first line).";
  const outputRule = `\n\nOutput exactly ${n} lines. Each line is ONLY the alt text for that image (max ${MAX_ALT_LENGTH} characters). No numbering, bullets, or labels—one alt per line, in order.`;

  const parts: Array<
    { text: string } | { inline_data: { mime_type: string; data: string } }
  > = [{ text: instruction + outputRule }];

  for (const src of sources) {
    const imagePart = await sourceToGeminiImagePart(src);
    if (!imagePart) {
      return { alts: null, hint: "Could not read an image for Gemini (invalid or too large)." };
    }
    parts.push(imagePart);
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      maxOutputTokens: Math.min(1024, 100 + n * 60),
      temperature: 0.3,
    },
  });

  let lastHint =
    "Gemini did not return usable text. Check Google AI Studio quotas or set GEMINI_MODEL in .env.local.";

  for (const model of geminiModelsToTry()) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const raw = await response.text();
    let json: GeminiJson;
    try {
      json = JSON.parse(raw) as GeminiJson;
    } catch {
      console.error("Gemini non-JSON response", model, raw.slice(0, 500));
      lastHint = `Gemini (${model}) returned an invalid response.`;
      continue;
    }

    if (!response.ok) {
      const code = json.error?.code;
      const msg = json.error?.message ?? raw;
      console.error("Gemini API error", model, raw);
      if (code === 429) {
        const { dailyLimit, retrySeconds } = gemini429Details(raw);
        if (dailyLimit) {
          lastHint =
            "Gemini daily free-tier limit is exhausted for this API key’s Google Cloud project. A new key in the same project will not help — create a key in a new AI Studio project, wait until tomorrow, or paste an OpenAI key as fallback.";
          break;
        }
        lastHint = retrySeconds
          ? `Gemini rate limit (429). Wait about ${retrySeconds}s, then try again. Trying another model…`
          : "Gemini rate limit (429). Wait about a minute, then try again.";
      } else if (code === 403) {
        lastHint =
          "Gemini returned 403 (API not enabled for this key or region). Enable Generative Language API in Google Cloud for the key’s project.";
      } else if (code === 400 || code === 404) {
        lastHint = `Gemini model “${model}” failed (${code}). Try GEMINI_MODEL=gemini-1.5-flash in .env.local. ${msg.slice(0, 180)}`;
      } else {
        lastHint = msg.slice(0, 280);
      }
      continue;
    }

    const block = json.promptFeedback?.blockReason;
    if (block) {
      lastHint = `Gemini blocked the request (${block}). Try a different image or prompt.`;
      continue;
    }

    const c0 = json.candidates?.[0];
    const textParts = c0?.content?.parts;
    if (!textParts?.length) {
      lastHint = `Gemini (${model}) returned no candidates (finish: ${c0?.finishReason ?? "unknown"}).`;
      continue;
    }

    const text = textParts
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("\n")
      .trim();

    if (!text) {
      lastHint = `Gemini (${model}) returned empty text.`;
      continue;
    }

    const alts = parseModelOutputToLines(text, n);
    return { alts };
  }

  return { alts: null, hint: lastHint };
}

async function generateAltsWithOpenAI(
  sources: string[],
  userPrompt: string,
  apiKey: string
): Promise<string[] | null> {
  if (!apiKey.trim()) return null;

  const n = sources.length;
  const instruction =
    userPrompt.trim() ||
    "Generate accessible ALT text for each image in the order they appear (first attachment = first line).";
  const outputRule = `\n\nOutput exactly ${n} lines. Each line is ONLY the alt text for that image (max ${MAX_ALT_LENGTH} characters). No numbering, bullets, or labels—one alt per line, in order.`;

  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: instruction + outputRule }];

  for (const url of sources) {
    userContent.push({ type: "image_url", image_url: { url } });
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: Math.min(800, 80 + n * 50),
    }),
  });

  if (!response.ok) {
    console.error("OpenAI API error", await response.text());
    return null;
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) return null;

  let text: string;
  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    text = content
      .map((part: { text?: string }) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  } else {
    return null;
  }

  return parseModelOutputToLines(text, n);
}

function googleApiKeyFromEnv(): string | undefined {
  const k =
    process.env.GOOGLE_AI_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim();
  return k || undefined;
}

function trimKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t || undefined;
}

function resolveApiKeys(body: Record<string, unknown>): {
  geminiKey?: string;
  openaiKey?: string;
  geminiKeySource?: "request" | "env";
  openaiKeySource?: "request" | "env";
} {
  const requestGemini =
    trimKey(body.googleApiKey) ?? trimKey(body.geminiApiKey);
  const requestOpenai = trimKey(body.openaiApiKey);
  const envGemini = googleApiKeyFromEnv();
  const envOpenai = trimKey(process.env.OPENAI_API_KEY);

  const geminiKey = requestGemini ?? envGemini;
  const openaiKey = requestOpenai ?? envOpenai;

  return {
    geminiKey,
    openaiKey,
    geminiKeySource: requestGemini ? "request" : envGemini ? "env" : undefined,
    openaiKeySource: requestOpenai ? "request" : envOpenai ? "env" : undefined,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";

    const parsed = normalizeSources(body);
    if (!parsed) {
      return NextResponse.json(
        {
          error: `Add at least one image (paste, file, or URL). Maximum ${MAX_IMAGES} images.`,
        },
        { status: 400 }
      );
    }

    const { sources, fallbacks } = parsed;

    const { geminiKey, openaiKey, geminiKeySource, openaiKeySource } =
      resolveApiKeys(body);
    const hasAnyKey = Boolean(geminiKey || openaiKey);

    let usedAi = false;
    let provider: "gemini" | "openai" | null = null;
    let altTexts: string[] = [...fallbacks];
    let geminiFailureHint: string | undefined;

    const applyAi = (ai: string[] | null, p: "gemini" | "openai") => {
      if (ai && ai.length === sources.length) {
        usedAi = true;
        provider = p;
        altTexts = ai.map((t, i) => {
          const trimmed = (t || "").trim();
          if (!trimmed) return fallbacks[i];
          return trimmed.length > MAX_ALT_LENGTH
            ? trimmed.slice(0, MAX_ALT_LENGTH)
            : trimmed;
        });
      }
    };

    try {
      if (geminiKey) {
        const { alts, hint: gh } = await generateAltsWithGemini(
          sources,
          prompt,
          geminiKey
        );
        applyAi(alts, "gemini");
        if (!usedAi && gh) geminiFailureHint = gh;
      }
      if (!usedAi && openaiKey) {
        const ai = await generateAltsWithOpenAI(sources, prompt, openaiKey);
        applyAi(ai, "openai");
      }
    } catch (err) {
      console.error("Error calling vision API:", err);
    }

    for (let i = 0; i < altTexts.length; i++) {
      if (altTexts[i].length > MAX_ALT_LENGTH) {
        altTexts[i] = altTexts[i].slice(0, MAX_ALT_LENGTH);
      }
    }

    const altText = altTexts.length === 1 ? altTexts[0] : altTexts.join("\n");

    const hint = usedAi
      ? undefined
      : !hasAnyKey
        ? "Vision AI is off: paste a Google AI Studio (Gemini) or OpenAI API key in Settings, or add GOOGLE_AI_API_KEY / OPENAI_API_KEY to .env.local."
        : geminiFailureHint ??
          "The model did not return usable lines (check the key, API enablement, billing, and server logs). Showing placeholder text only.";

    return NextResponse.json({
      altTexts,
      altText,
      maxLength: MAX_ALT_LENGTH,
      count: altTexts.length,
      usedAi,
      provider,
      /** True when a vision model produced the alts (Gemini or OpenAI). */
      usedOpenAI: usedAi,
      hint,
      geminiKeySource,
      geminiKeySuffix: geminiKey ? keySuffix(geminiKey) : undefined,
      openaiKeySource,
    });
  } catch (error) {
    console.error("Unhandled error in /api/generate-alt-text:", error);
    return NextResponse.json(
      { error: "Failed to process request." },
      { status: 500 }
    );
  }
}
