# Image ALT Text Generator (MCP Server)

A Next.js app that generates accessible ALT text for images from a URL.

## Tech stack

- **Next.js** (App Router)
- **TypeScript**
- **Tailwind CSS**

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Enter an image URL in the form.
2. Click **Generate ALT Text**.
3. The generated ALT text is shown below the form.

The API route `/api/generate-alt-text` accepts `POST` with JSON body `{ "imageUrl": "https://..." }` and returns `{ "altText": "..." }`. You can replace the placeholder logic in `src/app/api/generate-alt-text/route.ts` with an AI/vision API (e.g. OpenAI GPT-4 Vision) for real alt text generation.
