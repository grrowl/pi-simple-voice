import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTextForSpeech, drainBoundaries, getContent, trimChunk } from "./chunking.ts";

// Why: the fork's defining promise is that it NEVER voices reasoning. If a
// future content shape leaks thinking/reasoning parts into speech, this fails.
test("getContent strips thinking/reasoning parts, keeps spoken text", () => {
  const message = {
    content: [
      { type: "thinking", text: "let me reason about this" },
      { type: "text", text: "Hello there." },
      { type: "reasoning", text: "the user asked X" },
      { type: "output_text", text: " How can I help?" },
    ],
  };
  assert.equal(getContent(message), "Hello there. How can I help?");
});

test("getContent handles string content and missing content", () => {
  assert.equal(getContent({ content: "plain string" }), "plain string");
  assert.equal(getContent({}), "");
  assert.equal(getContent(null), "");
});

// Why: speech is verbatim WORDS, not markdown. The model must not read "asterisk
// asterisk" aloud, but every actual word must survive.
test("cleanTextForSpeech removes markup but keeps words", () => {
  assert.equal(cleanTextForSpeech("**bold** and `code` here"), "bold and code here");
  assert.equal(cleanTextForSpeech("a > b and # heading"), "a b and heading");
  assert.equal(cleanTextForSpeech("before ```\nfenced block\n``` after"), "before after");
});

// Why: time-to-first-audio matters. The FIRST chunk must flush early (at the
// first clause boundary), not wait for a full sentence.
test("drainBoundaries flushes the first chunk fast, at a clause boundary", () => {
  const { chunks } = drainBoundaries("Hello, world this is the rest of it.", false);
  assert.equal(chunks[0], "Hello,");
});

// Why: after the first flush we speak whole sentences and must HOLD an
// incomplete trailing fragment — never speak half a sentence mid-stream.
test("drainBoundaries holds an incomplete trailing fragment in remainder", () => {
  const { chunks, remainder } = drainBoundaries("First sentence. Second incompl", true);
  assert.deepEqual(chunks, ["First sentence."]);
  assert.equal(remainder.trim(), "Second incompl");
});

// Why: verbatim means nothing is dropped. Streaming the text in arbitrary
// pieces must yield the same word sequence as the original, in order.
test("streaming over arbitrary pieces preserves every word in order", () => {
  const full =
    "Hello there. This is a longer message, with several clauses; it should be spoken in full. The end.";
  // Split into jagged streaming pieces.
  const pieces: string[] = [];
  for (let i = 0; i < full.length; i += 7) pieces.push(full.slice(i, i + 7));

  let buffer = "";
  let firstFlushDone = false;
  const spoken: string[] = [];
  for (const piece of pieces) {
    buffer += piece;
    const { chunks, remainder } = drainBoundaries(buffer, firstFlushDone);
    if (chunks.length) firstFlushDone = true;
    spoken.push(...chunks);
    buffer = remainder;
  }
  const tail = trimChunk(buffer);
  if (tail) spoken.push(tail);

  const words = (s: string) => s.replace(/\s+/g, " ").trim().split(" ");
  assert.deepEqual(words(spoken.join(" ")), words(full));
});
