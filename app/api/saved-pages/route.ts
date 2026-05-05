import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const PAGES_DIR = join(process.cwd(), "output", "latest", "pages");

function pageLabel(file: string) {
  const pageNumber = file.match(/page-(\d+)\.png$/)?.[1] ?? file;
  return `Page ${Number(pageNumber) || pageNumber}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const file = url.searchParams.get("file");

  try {
    if (file) {
      const safeFile = basename(file);

      if (!/^page-\d+\.png$/.test(safeFile)) {
        return NextResponse.json({ error: "Invalid page file." }, { status: 400 });
      }

      const image = await readFile(join(PAGES_DIR, safeFile));

      return new Response(image, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "image/png"
        }
      });
    }

    const files = (await readdir(PAGES_DIR)).filter((item) => /^page-\d+\.png$/.test(item)).sort();
    const pages = await Promise.all(
      files.map(async (item) => {
        const info = await stat(join(PAGES_DIR, item));

        return {
          file: item,
          label: pageLabel(item),
          sizeBytes: info.size,
          url: `/api/saved-pages?file=${encodeURIComponent(item)}`
        };
      })
    );

    return NextResponse.json({ pages });
  } catch (error) {
    const message =
      error instanceof Error && error.message.includes("ENOENT")
        ? "No saved page images found. Run Split PDF first."
        : error instanceof Error
          ? error.message
          : "Could not load saved pages.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
