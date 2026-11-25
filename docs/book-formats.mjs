import { readBook as readEpub, chapterFragment as epubChapter } from "./epub.mjs";

export const fileLimit = 96 * 1024 * 1024;
export async function identify(buffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",buffer)),n=>n.toString(16).padStart(2,"0")).join("");
}

export async function readBook(file) {
  if (file.size > fileLimit) throw new Error("请选择 96 MB 以内的电子书。");
  const ext=file.name.split(".").pop().toLowerCase();
  if (ext==="epub") return readEpub(file);
  if (ext==="mobi") return (await import("./mobi.mjs")).readMobi(file);
  if (ext==="pdf") return (await import("./pdf-reader.mjs")).readPdf(file);
  throw new Error("请选择 EPUB、MOBI 或 PDF 文件。");
}

export function chapterFragment(book,path,urls) {
  return book.render ? book.render(path,urls) : epubChapter(book,path,urls);
}
