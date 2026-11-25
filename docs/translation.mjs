import { assistantRequest } from "./assistant-bridge.mjs";
export { assistantRequest as requestAssistant } from "./assistant-bridge.mjs";

export function excerpt(text) {
  return typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
}

let translator;
export async function translateExample(text) {
  if (!globalThis.Translator) return "";
  const options = { sourceLanguage: "en", targetLanguage: "zh" };
  if (!translator) {
    if (await Translator.availability(options) !== "available") return "";
    translator ??= Translator.create(options).catch(error=>{
      translator = undefined;
      throw error;
    });
  }
  return (await (await translator).translate(text)).trim();
}

export async function translateWithGpt(text, context, preferences) {
  const result = await assistantRequest("/explain", {text, context, ...preferences});
  if (!result.answer?.translation || !Array.isArray(result.answer.terms)) {
    throw new Error("没有收到精读结果。请重新打开阅读页再试。");
  }
  return result;
}

