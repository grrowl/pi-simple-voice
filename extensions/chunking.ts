/**
 * Pure text helpers for streaming, verbatim TTS.
 *
 * These have no dependency on the pi runtime — they take strings (or plain
 * message objects) and return strings — so they can be unit-tested in isolation
 * (see chunking.test.ts). The extension (index.ts) imports them.
 *
 * The job: turn a growing stream of assistant text into speakable chunks at
 * sentence boundaries, fast on the first chunk (low time-to-first-audio) and on
 * sentence ends thereafter, while never voicing reasoning/thinking content.
 */

// biome-ignore lint/suspicious/noExplicitAny: message shape varies by runtime
export function getContent(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      // biome-ignore lint/suspicious/noExplicitAny: content parts have varying shapes
      .map((part: any) => {
        if (!part || typeof part.text !== "string") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        return type.includes("thinking") || type.includes("reasoning") ? "" : part.text;
      })
      .join("");
  }
  return "";
}

export function trimChunk(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Strip markdown/code so the model doesn't read symbols aloud.
export function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~>#\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function nextFirstBoundary(text: string): number {
  const punctuation = text.search(/[.!?,;:—-](?:\s|$)/u);
  if (punctuation >= 0) return punctuation + 1;
  const words = text.match(/\S+/g);
  if (!words || words.length < 8) return -1;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\S/.test(text[i]) && (i === 0 || /\s/.test(text[i - 1]))) seen++;
    if (seen === 8) {
      const afterWord = text.slice(i).search(/\s/);
      return afterWord < 0 ? text.length : i + afterWord;
    }
  }
  return -1;
}

export function nextSentenceBoundary(text: string): number {
  const match = /[.!?](?:["')\]]?)(?:\s|$)/u.exec(text);
  return match ? match.index + match[0].trimEnd().length : -1;
}

export function softSplit(text: string, cap: number): number {
  const capped = text.slice(0, cap);
  return Math.max(capped.lastIndexOf(" "), 1);
}

// Pull complete clauses/sentences out of the buffer. The first chunk flushes
// fast (lower time-to-first-audio); subsequent chunks wait for sentence ends.
export function drainBoundaries(
  input: string,
  firstFlushDone: boolean,
): { chunks: string[]; remainder: string } {
  const chunks: string[] = [];
  let remainder = input;

  while (true) {
    const boundary =
      firstFlushDone || chunks.length > 0
        ? nextSentenceBoundary(remainder)
        : nextFirstBoundary(remainder);
    if (boundary <= 0) break;
    const chunk = trimChunk(remainder.slice(0, boundary));
    remainder = remainder.slice(boundary);
    if (chunk) chunks.push(chunk);
  }

  if ((firstFlushDone || chunks.length > 0) && remainder.length >= 200) {
    const split = softSplit(remainder, 200);
    const chunk = trimChunk(remainder.slice(0, split));
    remainder = remainder.slice(split);
    if (chunk) chunks.push(chunk);
  }

  return { chunks, remainder };
}
