#!/usr/bin/env node
// Deterministic manifest of every served asset (public/** at a git commit):
// sorted paths, sha256 per file, canonical serialization — the same commit
// always yields byte-identical output. The attest workflow
// (.github/workflows/attest.yml) signs this file into Sigstore's public
// transparency log on every push to main; an independent verifier regenerates
// it at the same commit and runs `gh attestation verify` against it.
//
// Usage:
//   node scripts/build-manifest.mjs [ref] > manifest.json   (default: HEAD)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { buildManifest, manifestJson } from "./verify-lib.mjs";

const MAX_BUFFER = 256 * 1024 * 1024; // largest asset today is a ~6 MB mp4

function git(...argv) {
  return execFileSync("git", argv, { maxBuffer: MAX_BUFFER });
}

const ref = process.argv[2] || "HEAD";
const commit = git("rev-parse", `${ref}^{commit}`).toString().trim();
const paths = git("ls-tree", "-r", "--name-only", commit, "--", "public")
  .toString()
  .split("\n")
  .filter(Boolean);

const files = paths.map((path) => [
  path,
  createHash("sha256").update(git("show", `${commit}:${path}`)).digest("hex"),
]);

process.stdout.write(manifestJson(buildManifest({ commit, files })));
