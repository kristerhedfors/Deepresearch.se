// The SSE line-buffer parser as a PURE module (baseplate-client step 3) — the
// smallest exemplar of the shared-core convention. createSseParser() returns a
// stateful { push(chunk) -> events[] } that carries a partial trailing line
// between reads, ignores comment/keepalive lines and the [DONE] terminator, and
// DROPS malformed JSON rather than throwing — a torn frame must never kill the
// render loop. Import-safe in Node, so it is unit-tested without a browser.

export function createSseParser() {
  let buffer = "";
  return {
    /**
     * @param {string} chunk a decoded text chunk from the response stream
     * @returns {any[]} the parsed data events contained in this chunk
     */
    push(chunk) {
      buffer += chunk;
      const events = [];
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith(":")) continue; // blank / keepalive comment
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          events.push(JSON.parse(payload));
        } catch {
          // torn or malformed frame — drop it, keep rendering
        }
      }
      return events;
    },
  };
}
