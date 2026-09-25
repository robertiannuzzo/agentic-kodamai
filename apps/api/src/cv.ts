import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import busboy from "busboy";
import { extractText, getDocumentProxy } from "unpdf";

/** The largest CV a candidate may upload. */
export const MAX_CV_BYTES = 5 * 1024 * 1024;
/** Longer PDFs are refused before their text is read. */
export const MAX_CV_PAGES = 20;
/** The same limit pasted CV text had; the kernel frames carry it verbatim. */
export const MAX_CV_TEXT = 50_000;
const MAX_APPLICATION_JSON = 1_000_000;

/** A refused upload. The server maps each code to an HTTP status. */
export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = "UploadError";
  }
}

export interface ApplicationUpload {
  /** The `application` part, parsed as JSON. */
  application: Record<string, unknown>;
  /** The original CV bytes, checked to start with the PDF signature. */
  cv: Buffer;
  /** SHA-256 of the CV bytes: the stored document's version. */
  sha256: string;
}

/**
 * Read one application upload: a `cv` PDF file and an `application` JSON part.
 * Limits are enforced while the request streams in, so an oversized upload is
 * refused without buffering more than the limit.
 */
export function readApplicationUpload(request: IncomingMessage): Promise<ApplicationUpload> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new UploadError(415, "multipart-content-type-required");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > MAX_CV_BYTES + MAX_APPLICATION_JSON + 64 * 1024) throw new UploadError(413, "cv-too-large");

  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: request.headers,
        limits: {
          files: 1,
          fileSize: MAX_CV_BYTES,
          fields: 1,
          fieldSize: MAX_APPLICATION_JSON
        }
      });
    } catch {
      reject(new UploadError(400, "invalid-multipart"));
      return;
    }
    let failure: UploadError | null = null;
    let cv: Buffer | null = null;
    let applicationJson: string | null = null;
    const fail = (error: UploadError): void => {
      if (failure !== null) return;
      failure = error;
      request.unpipe(parser);
      // Discard the rest of the body without keeping it.
      request.resume();
      reject(error);
    };

    parser.on("file", (name, stream) => {
      if (name !== "cv" || cv !== null) {
        stream.resume();
        fail(new UploadError(400, name === "cv" ? "too-many-cvs" : "unexpected-file"));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => fail(new UploadError(413, "cv-too-large")));
      stream.on("end", () => {
        if (failure === null) cv = Buffer.concat(chunks);
      });
    });
    parser.on("field", (name, value, info) => {
      if (name !== "application" || info.valueTruncated) {
        fail(new UploadError(400, "invalid-application"));
        return;
      }
      applicationJson = value;
    });
    parser.on("filesLimit", () => fail(new UploadError(400, "too-many-cvs")));
    parser.on("fieldsLimit", () => fail(new UploadError(400, "invalid-application")));
    parser.on("error", () => fail(new UploadError(400, "invalid-multipart")));
    parser.on("close", () => {
      if (failure !== null) return;
      if (cv === null || cv.length === 0) {
        reject(new UploadError(400, "cv-required"));
        return;
      }
      if (!cv.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        reject(new UploadError(400, "cv-not-pdf"));
        return;
      }
      let application: unknown;
      try {
        application = JSON.parse(applicationJson ?? "") as unknown;
      } catch {
        reject(new UploadError(400, "invalid-application"));
        return;
      }
      if (typeof application !== "object" || application === null || Array.isArray(application)) {
        reject(new UploadError(400, "invalid-application"));
        return;
      }
      resolve({
        application: application as Record<string, unknown>,
        cv,
        sha256: createHash("sha256").update(cv).digest("hex")
      });
    });
    request.on("aborted", () => fail(new UploadError(400, "invalid-multipart")));
    request.pipe(parser);
  });
}

/**
 * The PDF side of the extraction leaf: untrusted bytes in, plain text out.
 * Whatever it returns is only ever passed to the kernel as the stored
 * document's text, exactly as pasted CV text was.
 */
export async function extractCvText(pdf: Buffer): Promise<string> {
  let text: string;
  try {
    const document = await getDocumentProxy(new Uint8Array(pdf), {
      verbosity: 0,
      disableFontFace: true
    });
    try {
      if (document.numPages > MAX_CV_PAGES) throw new UploadError(400, "cv-too-many-pages");
      text = (await extractText(document, { mergePages: true })).text;
    } finally {
      await document.loadingTask.destroy();
    }
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(400, "cv-unreadable");
  }
  const normalised = text
    .replace(/\u0000/gu, "")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
  if (!/[\p{L}\p{N}]/u.test(normalised)) throw new UploadError(400, "cv-no-text");
  if (Array.from(normalised).length > MAX_CV_TEXT) throw new UploadError(400, "cv-text-too-long");
  return normalised;
}
