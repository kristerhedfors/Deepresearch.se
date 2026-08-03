// Node tests for the MCP server view's connector section (account-mcp.js).
// loadMcpView and the control wiring are DOM work and are verified live like
// the other panel views; what is testable here is the pure builder — and what
// is worth testing is narrow but load-bearing.
//
// The vendor menu paths in that markup cannot be tested: they describe someone
// else's UI, both vendors renamed these menus inside six months, and nothing
// here can notice when they do it again (which is exactly how the /connect/
// page came to print two paths that no longer existed). So these tests pin the
// things that ARE ours: that the two URLs come from the server payload rather
// than being assembled or hard-coded in the client, that they stay distinct,
// and that user-supplied strings cannot escape into the markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectorMarkup } from "./account-mcp.js";

const PAYLOAD = {
  endpoint: "https://mcp.deepresearch.se",
  chatgpt_endpoint: "https://mcp.deepresearch.se/mcp",
  claude_install_url:
    "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=DeepResearch&connectorUrl=https%3A%2F%2Fmcp.deepresearch.se",
};

test("the connector section renders the install button and both vendor walkthroughs", () => {
  const html = connectorMarkup(PAYLOAD);
  assert.match(html, /class="mcp-add"/, "the one call to action on the screen");
  assert.match(html, /Add to Claude/);
  assert.equal((html.match(/<details class="mcp-steps">/g) || []).length, 2);
  assert.match(html, /Claude — by hand/);
  assert.match(html, /ChatGPT — turn on Developer mode first/);
  // The full page stays one tap away rather than being duplicated here.
  assert.match(html, /href="\/connect\/"/);
});

test("the URLs come from the payload — the client assembles neither", () => {
  const html = connectorMarkup(PAYLOAD);
  assert.ok(html.includes(`href="${PAYLOAD.claude_install_url.replace(/&/g, "&amp;")}"`));
  assert.ok(html.includes(PAYLOAD.chatgpt_endpoint));
  // A preview deploy must prefill the preview, not production — if this file
  // ever hard-codes mcp.deepresearch.se, this is what catches it.
  const preview = connectorMarkup({
    endpoint: "http://localhost:8787/mcp",
    chatgpt_endpoint: "http://localhost:8787/mcp",
    claude_install_url: "https://claude.ai/customize/connectors?connectorUrl=http%3A%2F%2Flocalhost%3A8787%2Fmcp",
  });
  assert.ok(!preview.includes("mcp.deepresearch.se"), "no production URL leaks into a preview render");
  assert.ok(preview.includes("localhost%3A8787"));
});

test("the two vendor URLs stay distinct, because the vendors disagree about the path", () => {
  // Claude takes the bare origin, OpenAI's form wants /mcp. Rendering the same
  // string in both places is the bug this section exists to prevent, and it
  // would look completely reasonable in a diff.
  const html = connectorMarkup(PAYLOAD);
  const claudeStep = html.slice(html.indexOf("Claude — by hand"), html.indexOf("ChatGPT —"));
  const chatgptStep = html.slice(html.indexOf("ChatGPT —"));
  assert.ok(!claudeStep.includes("/mcp"), "the Claude walkthrough points at the bare origin");
  assert.match(chatgptStep, /https:\/\/mcp\.deepresearch\.se\/mcp/);
});

test("the honest note about the flow being untried survives", () => {
  // Nobody has completed either flow against a live connector dialog. The page
  // says so; when that changes, this test is the reminder to change it here
  // too rather than leaving a stale warning on a working feature.
  assert.match(connectorMarkup(PAYLOAD), /you may be the first through/i);
});

test("payload strings are escaped, and a missing payload degrades rather than breaking", () => {
  const nasty = connectorMarkup({
    endpoint: '"><script>alert(1)</script>',
    chatgpt_endpoint: '"><img src=x onerror=1>',
    claude_install_url: '" onmouseover="alert(1)',
  });
  assert.ok(!nasty.includes("<script>"), "the endpoint is escaped into the textarea");
  assert.ok(!nasty.includes("<img src=x"), "the ChatGPT URL is escaped");
  assert.ok(!nasty.includes('" onmouseover="'), "the href cannot break out of its attribute");
  // An older server that does not send the connector fields must not render a
  // button pointing at nothing — the walkthroughs still stand on their own.
  const bare = connectorMarkup({ endpoint: "https://mcp.deepresearch.se" });
  assert.ok(!bare.includes('class="mcp-add"'), "no install button without an install URL");
  assert.match(bare, /<details class="mcp-steps">/);
});
