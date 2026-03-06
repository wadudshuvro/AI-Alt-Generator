import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const imageUrl = body?.imageUrl;

    if (!imageUrl || typeof imageUrl !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid imageUrl." },
        { status: 400 }
      );
    }

    // Validate URL format
    let url: URL;
    try {
      url = new URL(imageUrl);
    } catch {
      return NextResponse.json(
        { error: "Invalid image URL format." },
        { status: 400 }
      );
    }

    // Placeholder: generate simple alt text from URL (e.g. filename).
    // Replace this with your preferred AI/vision API (e.g. OpenAI GPT-4 Vision).
    const pathname = url.pathname || "";
    const filename = pathname.split("/").filter(Boolean).pop() || "image";
    const nameWithoutExt = filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    const altText =
      nameWithoutExt.length > 1
        ? `Image: ${nameWithoutExt}`
        : "Image from provided URL.";

    return NextResponse.json({ altText });
  } catch {
    return NextResponse.json(
      { error: "Failed to process request." },
      { status: 500 }
    );
  }
}
