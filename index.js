const { execFile } = require("node:child_process");
const { mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const DEFAULT_DPI = 200;
const MAX_DPI = 300;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function headerValue(headers, name) {
  if (!headers) return "";
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : "";
}

function multipartBoundary(contentType) {
  return contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2] ?? "";
}

function parseMultipart(buffer, boundary) {
  const boundaryText = `--${boundary}`;
  const body = buffer.toString("binary");
  const parts = body.split(boundaryText).slice(1, -1);
  const fields = {};
  let file = null;

  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const separatorIndex = trimmed.indexOf("\r\n\r\n");
    if (separatorIndex === -1) continue;

    const rawHeaders = trimmed.slice(0, separatorIndex);
    const rawContent = trimmed.slice(separatorIndex + 4);
    const disposition = rawHeaders.match(/content-disposition:[^\r\n]*/i)?.[0] ?? "";
    const name = disposition.match(/name="([^"]+)"/)?.[1] ?? "";
    const filename = disposition.match(/filename="([^"]*)"/)?.[1] ?? "";
    const contentType = rawHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "application/octet-stream";
    const content = Buffer.from(rawContent, "binary");

    if (filename) {
      file = {
        fieldName: name,
        filename,
        contentType,
        content
      };
    } else if (name) {
      fields[name] = content.toString("utf8");
    }
  }

  return { fields, file };
}

function parseJsonBody(buffer) {
  const body = JSON.parse(buffer.toString("utf8"));
  const base64 = body.pdfBase64 ?? body.fileBase64 ?? body.data;

  if (!base64 || typeof base64 !== "string") {
    throw new Error("JSON request must include pdfBase64, fileBase64, or data.");
  }

  return {
    fields: {
      dpi: body.dpi ? String(body.dpi) : undefined
    },
    file: {
      filename: body.filename ?? "upload.pdf",
      contentType: "application/pdf",
      content: Buffer.from(base64.replace(/^data:application\/pdf;base64,/, ""), "base64")
    }
  };
}

function requestBuffer(event) {
  if (!event.body) return Buffer.alloc(0);
  return Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
}

function parseUpload(event) {
  const contentType = headerValue(event.headers, "content-type");
  const buffer = requestBuffer(event);

  if (contentType.includes("multipart/form-data")) {
    const boundary = multipartBoundary(contentType);
    if (!boundary) throw new Error("Multipart upload is missing a boundary.");
    return parseMultipart(buffer, boundary);
  }

  if (contentType.includes("application/json")) {
    return parseJsonBody(buffer);
  }

  if (contentType.includes("application/pdf")) {
    return {
      fields: {},
      file: {
        filename: "upload.pdf",
        contentType: "application/pdf",
        content: buffer
      }
    };
  }

  throw new Error(`Unsupported content type: ${contentType || "missing"}`);
}

function normalizedDpi(value) {
  const dpi = Number(value ?? DEFAULT_DPI);
  return Number.isFinite(dpi) ? Math.min(Math.max(Math.round(dpi), 100), MAX_DPI) : DEFAULT_DPI;
}

async function rasterizePdf(pdfPath, outputPrefix, dpi) {
  await execFileAsync("pdftoppm", ["-jpeg", "-jpegopt", "quality=85", "-r", String(dpi), pdfPath, outputPrefix]);
  const outputDir = outputPrefix.slice(0, outputPrefix.lastIndexOf("/"));
  const files = await readdir(outputDir);

  return files
    .filter((file) => file.startsWith("page-") && (file.endsWith(".jpg") || file.endsWith(".jpeg")))
    .sort((first, second) => {
      const firstPage = Number(first.match(/-(\d+)\.jpe?g$/)?.[1] ?? 0);
      const secondPage = Number(second.match(/-(\d+)\.jpe?g$/)?.[1] ?? 0);
      return firstPage - secondPage;
    })
    .map((file) => join(outputDir, file));
}

async function handleRequest(event) {
  if (event.requestContext?.http?.method === "OPTIONS" || event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: ""
    };
  }

  const workspace = await mkdtemp(join(tmpdir(), "pdf-splitter-"));

  try {
    const { fields, file } = parseUpload(event);

    if (!file?.content?.length) {
      return jsonResponse(400, { error: "Upload a PDF file." });
    }

    if (file.content.length > MAX_PDF_BYTES) {
      return jsonResponse(413, { error: "PDF must be 32MB or smaller." });
    }

    const dpi = normalizedDpi(fields.dpi);
    const pdfPath = join(workspace, "input.pdf");
    await writeFile(pdfPath, file.content);

    const pageImages = await rasterizePdf(pdfPath, join(workspace, "page"), dpi);

    if (!pageImages.length) {
      return jsonResponse(422, { error: "No page images were produced from the PDF." });
    }

    const pages = await Promise.all(
      pageImages.map(async (imagePath, index) => ({
        page: index + 1,
        mediaType: "image/jpeg",
        imageBase64: (await readFile(imagePath)).toString("base64")
      }))
    );

    return jsonResponse(200, {
      dpi,
      pageCount: pages.length,
      pages
    });
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "PDF Lambda failed."
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

exports.handler = async (event) => {
  try {
    return await handleRequest(event);
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unhandled PDF Lambda failure."
    });
  }
};
