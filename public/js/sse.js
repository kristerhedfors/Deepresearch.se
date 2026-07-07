// Incremental SSE parser — the pure core of stream.js's read loop, extracted
// so the line-buffering rules are testable in Node (no DOM needed). The
// server's stream is `data: <json>` events separated by blank lines, with
// `: keepalive` comment lines interleaved (CLAUDE.md, "/api/chat SSE
// protocol"); this parser owns exactly the byte-to-event step: carry a
// partial trailing line between reads, ignore comments/blank lines and the
// `[DONE]` terminator, and drop malformed JSON rather than throw (a torn
// keepalive or truncated frame must never kill the render loop).

export function createSseParser() {
  let buffer = "";
  return {
    // Feed one decoded chunk; returns the complete parsed events it finished.
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop(); // partial trailing line waits for the next read
      const events = [];
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          events.push(JSON.parse(data));
        } catch { /* ignore non-JSON lines */ }
      }
      return events;
    },
  };
}
