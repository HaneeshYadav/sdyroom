import {
  docxXmlToText,
  extractDocument,
  MAX_EXTRACTED_BYTES,
} from "@/lib/ai/extract";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PDF = "application/pdf";
const TXT = "text/plain";
const MD = "text/markdown";
const CSV = "text/csv";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fixture(relative: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/${relative}`, import.meta.url)),
  );
}

describe("extractDocument — plain text formats", () => {
  it("decodes txt, md and csv as strict UTF-8", async () => {
    for (const contentType of [TXT, MD, CSV]) {
      const result = await extractDocument(
        bytesOf("Rotational motion notes — τ = Iα"),
        contentType,
      );
      expect(result).toEqual({
        ok: true,
        text: "Rotational motion notes — τ = Iα",
      });
    }
  });

  it("strips a leading BOM (encoding artefact, not content)", async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf("hello")]);
    const result = await extractDocument(withBom, TXT);
    expect(result).toEqual({ ok: true, text: "hello" });
  });

  it("rejects invalid UTF-8 as extract_failed instead of guessing", async () => {
    const result = await extractDocument(
      new Uint8Array([0x68, 0x69, 0xc3, 0x28]),
      TXT,
    );
    expect(result).toEqual({ ok: false, code: "extract_failed" });
  });

  it("caps extracted text at the database's 16 MiB ceiling", async () => {
    const huge = "a".repeat(MAX_EXTRACTED_BYTES + 1);
    const result = await extractDocument(bytesOf(huge), TXT);
    expect(result).toEqual({ ok: false, code: "extracted_too_large" });
  });

  it("answers unsupported content types without touching the bytes", async () => {
    const result = await extractDocument(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "image/png",
    );
    expect(result).toEqual({ ok: false, code: "unsupported_media_type" });
  });
});

describe("extractDocument — PDFs", () => {
  it("extracts the text layer of a real PDF", async () => {
    const result = await extractDocument(fixture("rotational-motion.pdf"), PDF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("Rotational motion notes");
    }
  });

  it("treats a drawing-only PDF as a success with empty text (the DB decides no_text_layer)", async () => {
    const result = await extractDocument(fixture("drawing-only.pdf"), PDF);
    expect(result).toEqual({ ok: true, text: "" });
  });

  it("answers a corrupt PDF container with extract_failed, not a crash", async () => {
    const result = await extractDocument(bytesOf("%PDF-not really"), PDF);
    expect(result).toEqual({ ok: false, code: "extract_failed" });
  });
});

describe("extractDocument — DOCX", () => {
  it("reads word/document.xml out of the ZIP container", async () => {
    const result = await extractDocument(fixture("simple.docx"), DOCX);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("Rotational dynamics.");
      expect(result.text).toContain("Torque equals rate of change");
    }
  });

  it("answers bytes that are not a ZIP (or lack the main part) with extract_failed", async () => {
    const result = await extractDocument(fixture("drawing-only.pdf"), DOCX);
    expect(result).toEqual({ ok: false, code: "extract_failed" });
  });
});

describe("docxXmlToText", () => {
  it("maps paragraphs to newlines, tabs/breaks to their shape", () => {
    const xml =
      "<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p>";
    expect(docxXmlToText(xml)).toBe("A\tB\nC\nD\n");
  });

  it("decodes entities with &amp; last so &amp;lt; cannot become <", () => {
    expect(docxXmlToText("<w:t>&amp;lt;</w:t>")).toBe("&lt;");
    expect(docxXmlToText("<w:t>&lt;tag&gt; &quot;q&quot; &apos;a&apos;</w:t>")).toBe(
      "<tag> \"q\" 'a'",
    );
    expect(docxXmlToText("<w:t>&#x3c;&#60;</w:t>")).toBe("<<");
  });

  it("collapses the document's empty-paragraph padding", () => {
    expect(docxXmlToText("<w:p><w:t>x</w:t></w:p><w:p></w:p><w:p></w:p><w:p><w:t>y</w:t></w:p>")).toBe(
      "x\n\ny\n",
    );
  });

  it("never executes anything from the file — tags simply disappear", () => {
    const hostile = "<w:p><w:r><w:t>hello <script>alert(1)</script></w:t></w:r></w:p>";
    expect(docxXmlToText(hostile)).toBe("hello alert(1)\n");
  });
});
