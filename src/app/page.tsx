"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

const MAX_PASTE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 12;
const STORAGE_GOOGLE_KEY = "alt-text-google-api-key";
const STORAGE_OPENAI_KEY = "alt-text-openai-api-key";

type PastedImage = {
  id: string;
  dataUrl: string;
  previewUrl: string;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === "string") resolve(r);
      else reject(new Error("Could not read image."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const DEFAULT_PROMPT = `Write product image alt text (≤99 chars).

Rules:
- Describe visible product only: brand, color, type, key feature, context
- No phrases like "image of", "picture of", "text in this image"
- No promo words or keyword stuffing
- Natural sentence case, no symbols (| / _)
- If >99 chars, shorten

Output: alt text only

Input:
{product_name}, {brand}, {color}, {feature}, {context}`;

export default function Home() {
  const composerId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [images, setImages] = useState<PastedImage[]>([]);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [altTexts, setAltTexts] = useState<string[]>([]);
  const [apiHint, setApiHint] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [googleApiKey, setGoogleApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [showApiSettings, setShowApiSettings] = useState(true);
  const [keysHydrated, setKeysHydrated] = useState(false);

  useEffect(() => {
    setGoogleApiKey(localStorage.getItem(STORAGE_GOOGLE_KEY) ?? "");
    setOpenaiApiKey(localStorage.getItem(STORAGE_OPENAI_KEY) ?? "");
    setKeysHydrated(true);
  }, []);

  useEffect(() => {
    if (!keysHydrated) return;
    if (googleApiKey.trim()) {
      localStorage.setItem(STORAGE_GOOGLE_KEY, googleApiKey.trim());
    } else {
      localStorage.removeItem(STORAGE_GOOGLE_KEY);
    }
  }, [googleApiKey, keysHydrated]);

  useEffect(() => {
    if (!keysHydrated) return;
    if (openaiApiKey.trim()) {
      localStorage.setItem(STORAGE_OPENAI_KEY, openaiApiKey.trim());
    } else {
      localStorage.removeItem(STORAGE_OPENAI_KEY);
    }
  }, [openaiApiKey, keysHydrated]);

  const revokePreview = useCallback((item: PastedImage) => {
    if (item.previewUrl.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const item = prev.find((x) => x.id === id);
      if (item) revokePreview(item);
      return prev.filter((x) => x.id !== id);
    });
  }, [revokePreview]);

  const appendFiles = useCallback(async (files: File[]) => {
    setError("");
    const list = files.filter((f) => f.type.startsWith("image/"));
    if (!list.length) {
      setError("Add image files only (PNG, JPEG, GIF, WebP, etc.).");
      return;
    }

    let prevLen = 0;
    setImages((p) => {
      prevLen = p.length;
      return p;
    });
    const room = MAX_IMAGES - prevLen;
    if (room <= 0) {
      setError(`You can add at most ${MAX_IMAGES} images. Remove one to add more.`);
      return;
    }

    const take = list.slice(0, room);
    if (list.length > room) {
      setError(`Only the first ${room} file(s) were added (max ${MAX_IMAGES} images).`);
    }

    const next: PastedImage[] = [];
    for (const file of take) {
      if (file.size > MAX_PASTE_BYTES) {
        setError(`Each image must be under ${MAX_PASTE_BYTES / (1024 * 1024)} MB.`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        next.push({
          id: makeId(),
          dataUrl,
          previewUrl: URL.createObjectURL(file),
        });
      } catch {
        setError("Could not read one of the files.");
      }
    }

    if (next.length) {
      setImages((p) => {
        const merged = [...p, ...next];
        return merged.length > MAX_IMAGES ? merged.slice(0, MAX_IMAGES) : merged;
      });
    }
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length) {
        e.preventDefault();
        void appendFiles(imageFiles);
      }
    },
    [appendFiles]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = e.dataTransfer.files;
      if (files?.length) void appendFiles(Array.from(files));
    },
    [appendFiles]
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setAltTexts([]);
    setApiHint("");

    if (images.length === 0) {
      setError("Paste or add at least one image, then send.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/generate-alt-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrls: images.map((x) => x.dataUrl),
          prompt: prompt.trim(),
          ...(googleApiKey.trim() ? { googleApiKey: googleApiKey.trim() } : {}),
          ...(openaiApiKey.trim() ? { openaiApiKey: openaiApiKey.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to generate alt text.");
        return;
      }
      const list: string[] = Array.isArray(data.altTexts)
        ? data.altTexts
        : typeof data.altText === "string" && data.altText
          ? data.altText.split(/\r?\n/).filter(Boolean)
          : [];
      setAltTexts(list);
      if (typeof data.hint === "string" && data.hint) {
        const parts: string[] = [];
        if (data.geminiKeySource === "request" && data.geminiKeySuffix) {
          parts.push(`Using your pasted Google key (…${data.geminiKeySuffix}).`);
        } else if (data.geminiKeySource === "env") {
          parts.push("Using Google key from .env.local.");
        }
        parts.push(data.hint);
        setApiHint(parts.join(" "));
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const hasOutput = altTexts.length > 0;
  const showEmptyOutput = !loading && !error && !hasOutput;

  return (
    <div className="min-h-screen bg-linear-to-br from-zinc-950 via-[#121214] to-zinc-900 font-sans text-zinc-100">
      <header className="border-b border-zinc-800/60 bg-zinc-950/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-5 sm:px-6 lg:px-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)]" />
              <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
                Image alt text
              </h1>
            </div>
            <p className="max-w-xl text-sm text-zinc-400">
              Paste images, write a short prompt, then generate accessible descriptions for each image.
            </p>
          </div>
          <div className="w-full max-w-md lg:max-w-sm">
            <button
              type="button"
              onClick={() => setShowApiSettings((v) => !v)}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/50 px-3 py-2 text-left text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-300"
              aria-expanded={showApiSettings}
            >
              <span className="font-medium text-zinc-300">API keys</span>
              <span className="tabular-nums text-zinc-600">
                {googleApiKey.trim() || openaiApiKey.trim() ? "configured" : "optional"}
              </span>
            </button>
            {showApiSettings && (
              <div className="mt-2 space-y-3 rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-3">
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  Paste a key from a{" "}
                  <span className="font-medium text-zinc-400">new AI Studio project</span>{" "}
                  when quota runs out (a new key in the same project shares the same limit). Saved in
                  this browser only.
                </p>
                <div>
                  <label
                    htmlFor="google-api-key"
                    className="mb-1 block text-[11px] font-medium text-zinc-400"
                  >
                    Google AI Studio (Gemini)
                  </label>
                  <input
                    id="google-api-key"
                    type="password"
                    autoComplete="off"
                    value={googleApiKey}
                    onChange={(e) => setGoogleApiKey(e.target.value)}
                    placeholder="AIza…"
                    disabled={loading}
                    className="w-full rounded-lg border border-zinc-700/80 bg-zinc-950/80 px-2.5 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/40 focus:outline-none focus:ring-2 focus:ring-emerald-500/15 disabled:opacity-60"
                  />
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block text-[10px] text-emerald-600/90 hover:text-emerald-500"
                  >
                    Get a free key →
                  </a>
                </div>
                <div>
                  <label
                    htmlFor="openai-api-key"
                    className="mb-1 block text-[11px] font-medium text-zinc-400"
                  >
                    OpenAI (fallback)
                  </label>
                  <input
                    id="openai-api-key"
                    type="password"
                    autoComplete="off"
                    value={openaiApiKey}
                    onChange={(e) => setOpenaiApiKey(e.target.value)}
                    placeholder="sk-…"
                    disabled={loading}
                    className="w-full rounded-lg border border-zinc-700/80 bg-zinc-950/80 px-2.5 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/40 focus:outline-none focus:ring-2 focus:ring-emerald-500/15 disabled:opacity-60"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="grid min-h-[min(70vh,640px)] grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
          {/* Left: chat / composer */}
          <section className="flex min-h-0 flex-col" aria-label="Composer">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
                Composer
              </h2>
              <span className="text-[11px] text-zinc-600">Ctrl+V to paste images</span>
            </div>
            <form
              onSubmit={handleSubmit}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div
                className={`flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-2xl border bg-zinc-900/40 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_24px_48px_-12px_rgba(0,0,0,0.45)] transition-all ${
                  isDragging
                    ? "border-emerald-500/50 ring-2 ring-emerald-500/25"
                    : "border-zinc-700/70"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                onPasteCapture={onPaste}
              >
                <div className="border-b border-zinc-800/80 bg-zinc-950/30 p-4">
                  <div className="flex min-h-[80px] flex-wrap content-start gap-2.5">
                    {images.map((img) => (
                      <div
                        key={img.id}
                        className="group relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-xl border border-zinc-600/80 bg-zinc-900 shadow-inner"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={img.previewUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removeImage(img.id)}
                          className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/55 text-lg font-light text-white opacity-0 transition-opacity group-hover:opacity-100"
                          aria-label="Remove image"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {images.length === 0 && (
                      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700/60 bg-zinc-900/20 px-4 py-6 text-center">
                        <p className="text-sm text-zinc-400">Drop images here or paste from clipboard</p>
                        <p className="text-xs text-zinc-600">Use + to pick files from disk</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 flex-col p-4">
                  <label
                    htmlFor={composerId}
                    className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500"
                  >
                    Prompt
                  </label>
                  <textarea
                    ref={textareaRef}
                    id={composerId}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    placeholder={DEFAULT_PROMPT}
                    disabled={loading}
                    className="min-h-[100px] w-full flex-1 resize-none rounded-xl border border-zinc-800/80 bg-zinc-950/50 px-3.5 py-3 text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/40 focus:outline-none focus:ring-2 focus:ring-emerald-500/15 disabled:opacity-60"
                  />
                </div>

                <div className="mt-auto flex items-center justify-between gap-3 border-t border-zinc-800/80 bg-zinc-950/40 px-4 py-3">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={loading || images.length >= MAX_IMAGES}
                      className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-700/60 bg-zinc-800/40 text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700/50 hover:text-white disabled:opacity-40"
                      aria-label="Add images"
                      title="Add images"
                    >
                      <span className="text-xl leading-none">+</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-3">
                    {loading && (
                      <span className="flex items-center gap-2 text-sm text-zinc-400">
                        <span className="relative flex h-4 w-4">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/40" />
                          <span className="relative inline-flex h-4 w-4 rounded-full bg-emerald-500/80" />
                        </span>
                        Generating…
                      </span>
                    )}
                    <button
                      type="submit"
                      disabled={loading || images.length === 0}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-linear-to-r from-emerald-600 to-teal-600 px-4 text-sm font-medium text-white shadow-lg shadow-emerald-900/30 transition hover:from-emerald-500 hover:to-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="Generate alt text"
                    >
                      <span>Generate</span>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                      </svg>
                    </button>
                  </div>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files;
                    if (f?.length) void appendFiles(Array.from(f));
                    e.target.value = "";
                  }}
                />
              </div>
            </form>
          </section>

          {/* Right: output */}
          <section className="flex min-h-0 flex-col" aria-label="Generated alt text">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
                Output
              </h2>
              {hasOutput && (
                <span className="text-[11px] tabular-nums text-zinc-600">
                  {altTexts.length} image{altTexts.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            <div className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-700/70 bg-zinc-900/40 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_24px_48px_-12px_rgba(0,0,0,0.45)]">
              <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                {loading && (
                  <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-4 text-zinc-500">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500" />
                    <p className="text-sm">Analyzing your images…</p>
                  </div>
                )}

                {!loading && error && (
                  <div
                    className="rounded-xl border border-red-500/30 bg-red-950/40 px-4 py-3 text-sm text-red-200"
                    role="alert"
                  >
                    {error}
                  </div>
                )}

                {!loading && !error && hasOutput && (
                  <div className="space-y-4">
                    {apiHint ? (
                      <p
                        className="rounded-xl border border-amber-500/30 bg-amber-950/25 px-3.5 py-2.5 text-sm text-amber-100/95"
                        role="status"
                      >
                        {apiHint}
                      </p>
                    ) : null}
                    <h3 className="text-sm font-medium text-zinc-300">
                      Alt text{" "}
                      <span className="font-normal text-zinc-500">(max 99 characters each)</span>
                    </h3>
                    <ol className="space-y-4">
                      {altTexts.map((text, i) => (
                        <li key={i} className="group">
                          <div className="mb-1 flex items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-xs font-medium text-zinc-400">
                              {i + 1}
                            </span>
                            <span className="text-[11px] uppercase tracking-wide text-zinc-600">
                              Image {i + 1}
                            </span>
                          </div>
                          <div className="rounded-xl border border-zinc-700/50 bg-zinc-950/60 px-4 py-3 text-[15px] leading-snug text-zinc-100">
                            {text || "—"}
                          </div>
                          <p className="mt-1.5 text-right text-xs tabular-nums text-zinc-500">
                            {text.length} / 99
                          </p>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {showEmptyOutput && (
                  <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 px-6 text-center">
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
                      <svg
                        className="mx-auto mb-3 h-10 w-10 text-zinc-600"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
                        />
                      </svg>
                      <p className="text-sm font-medium text-zinc-400">No output yet</p>
                      <p className="mt-1 max-w-xs text-xs text-zinc-600">
                        Add at least one image on the left, then click Generate. Results show here.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
