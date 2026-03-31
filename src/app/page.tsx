"use client";

import { useCallback, useId, useRef, useState } from "react";

const MAX_PASTE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 12;

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

const DEFAULT_PROMPT =
  "Generate image alt text for each image in order (first thumbnail = first line).";

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
      if (typeof data.hint === "string" && data.hint) setApiHint(data.hint);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#1a1a1a] p-4 font-sans text-zinc-100 sm:p-8">
      <main className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-white">
          Image alt text
        </h1>
        <p className="mb-2 text-sm text-zinc-500">
          Paste multiple images (Ctrl+V), drop files, or use + — then describe what you want in the prompt.
        </p>
        <p className="mb-6 text-xs text-zinc-600">
          Real descriptions need a key in{" "}
          <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">.env.local</code>
          : prefer{" "}
          <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">GOOGLE_AI_API_KEY</code>{" "}
          (Google AI Studio / Gemini), or{" "}
          <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">OPENAI_API_KEY</code> as
          fallback. See <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">.env.example</code>
          . Restart <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">npm run dev</code> after
          changes.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div
            className={`overflow-hidden rounded-2xl border bg-[#2a2a2a] shadow-xl transition-colors ${
              isDragging ? "border-blue-500/60 ring-2 ring-blue-500/30" : "border-zinc-700/80"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onPasteCapture={onPaste}
          >
            <div className="border-b border-zinc-700/60 p-3">
              <div className="flex min-h-[72px] flex-wrap gap-2">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-zinc-600 bg-zinc-900"
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
                      className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm font-medium text-white opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {images.length === 0 && (
                  <p className="flex flex-1 items-center px-2 text-sm text-zinc-500">
                    No images yet — click below, paste, or drop files here.
                  </p>
                )}
              </div>
            </div>

            <div className="p-3 pt-2">
              <label htmlFor={composerId} className="sr-only">
                Prompt
              </label>
              <textarea
                ref={textareaRef}
                id={composerId}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder={DEFAULT_PROMPT}
                disabled={loading}
                className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-60"
              />
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-zinc-700/60 px-3 py-2.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading || images.length >= MAX_IMAGES}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-700/80 hover:text-white disabled:opacity-40"
                  aria-label="Add images"
                  title="Add images"
                >
                  <span className="text-xl leading-none">+</span>
                </button>
                <span
                  className="relative flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500"
                  title="Accessibility tools"
                  aria-hidden
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500" />
                </span>
              </div>

              <div className="flex items-center gap-2">
                {loading && (
                  <span className="text-sm text-zinc-500">Thinking</span>
                )}
                <button
                  type="submit"
                  disabled={loading || images.length === 0}
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-900 transition-colors hover:bg-white disabled:opacity-40"
                  aria-label="Send"
                  title="Generate alt text"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
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

        {error && (
          <p className="mt-4 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        {altTexts.length > 0 && (
          <div className="mt-8 rounded-2xl border border-zinc-700/80 bg-[#2a2a2a] p-4">
            {apiHint ? (
              <p
                className="mb-4 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm text-amber-100/90"
                role="status"
              >
                {apiHint}
              </p>
            ) : null}
            <h2 className="mb-3 text-sm font-medium text-zinc-300">
              Generated ALT text{" "}
              <span className="font-normal text-zinc-500">(max 99 characters each)</span>
            </h2>
            <ol className="list-decimal space-y-3 pl-5 text-sm text-zinc-200">
              {altTexts.map((text, i) => (
                <li key={i} className="pl-1">
                  <div className="rounded-lg bg-zinc-900/80 px-3 py-2 font-normal">
                    {text || "—"}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {text.length} / 99 characters
                  </p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </main>
    </div>
  );
}
