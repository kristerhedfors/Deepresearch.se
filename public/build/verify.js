// Fills the "Verify what this site serves" section on /build/ with the
// currently-served commit from /version.json (the deploy-time stamp,
// public route — see scripts/stamp-version.mjs). Fail-soft: the section
// reads fine without it. External module rather than inline so the CSP
// script-src story stays hash-free ('self' covers it).
const el = document.getElementById("served-commit");
if (el) {
  fetch("/version.json")
    .then((res) => (res.ok ? res.json() : null))
    .then((stamp) => {
      if (!stamp || !stamp.commit) {
        el.textContent = "not stamped on this deploy";
        return;
      }
      const link = document.createElement("a");
      link.href =
        "https://github.com/kristerhedfors/Deepresearch.se/commit/" +
        encodeURIComponent(stamp.commit);
      link.textContent = stamp.commit.slice(0, 12);
      el.textContent = "";
      el.append("commit ", link, stamp.branch ? ` (branch ${stamp.branch})` : "");
    })
    .catch(() => {
      el.textContent = "unavailable";
    });
}
