import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    PDF_LAMBDA_URL: process.env.PDF_LAMBDA_URL || process.env.NEXT_PUBLIC_PDF_LAMBDA_URL || "",
    NEXT_SERVER_PDF_LAMBDA_URL:
      process.env.NEXT_SERVER_PDF_LAMBDA_URL ||
      process.env.PDF_LAMBDA_URL ||
      process.env.NEXT_PUBLIC_PDF_LAMBDA_URL ||
      "",
    NEXT_PUBLIC_PDF_LAMBDA_URL: process.env.NEXT_PUBLIC_PDF_LAMBDA_URL || process.env.PDF_LAMBDA_URL || "",
    PDF_SPLITTER_URL:
      process.env.PDF_SPLITTER_URL || process.env.PDF_LAMBDA_URL || process.env.NEXT_PUBLIC_PDF_LAMBDA_URL || ""
  },
  turbopack: {
    root: projectRoot
  }
};

export default nextConfig;
