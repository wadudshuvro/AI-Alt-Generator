"use client";

import { useState } from "react";

export default function Home() {
  const [imageUrl, setImageUrl] = useState("");
  const [altText, setAltText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setAltText("");
    if (!imageUrl.trim()) {
      setError("Please enter an image URL.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/generate-alt-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: imageUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to generate alt text.");
        return;
      }
      setAltText(data.altText ?? "");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8 font-sans dark:bg-zinc-900">
      <main className="mx-auto max-w-xl">
        <h1 className="mb-8 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Image ALT Text Generator
        </h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label htmlFor="image-url" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Image URL
          </label>
          <input
            id="image-url"
            type="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://example.com/image.jpg"
            className="rounded border border-zinc-300 px-3 py-2 text-zinc-900 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded bg-zinc-900 px-4 py-2 font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? "Generating…" : "Generate ALT Text"}
          </button>
        </form>
        {error && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        {altText && (
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Generated ALT text
            </h2>
            <div className="rounded border border-zinc-200 bg-white p-4 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              {altText}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
