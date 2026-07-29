# The PALAEOGENOMICS variant of the server-side execution image — the analysis
# half of the palaeogenomics agent (sdk/AGENTS.json `palaeogenomics`).
#
# ---- why this exists as a SEPARATE image -----------------------------------
#
# public/js/aadr-core.js answers structured questions about the ancient-sample
# corpus — a region, a date window, a haplogroup, a coverage floor — and says so
# in the block it appends: "these are filters and counts, not f-statistics,
# qpAdm or PCA". That refusal is deliberate and it is what makes the agent
# trustworthy. But the analysis it refuses to fake is real work someone will
# want to do, and it needs real tools against real genotype files. This image is
# where that runs.
#
# It is a SEPARATE Dockerfile, not extra lines in ../Dockerfile, because the
# base image's own header sets the constraint: image size dominates a Cloudflare
# container cold start, and the cold start is what the user waits for on their
# first command. This adds roughly 400 MB of bioinformatics toolchain and an R
# runtime that a Deep Research shell never touches. Making everyone pay that
# cold start for one agent's benefit is the wrong trade, and it is the trade the
# base image is explicitly written to avoid.
#
# ---- the constraint you must know before building it -----------------------
#
# wrangler.toml binds ONE image to the ExecSandbox class:
#
#   [[containers]]
#   image = "registry.cloudflare.com/<account>/deepresearch-exec:1"
#
# There is no per-request image selection and no second binding. So this variant
# is an EITHER/OR with the base image today: building and pointing the binding
# here gives every session the palaeogenomics toolchain (and the slower cold
# start); leaving the binding alone means this image is documented and buildable
# but not deployed. That is the honest state — no deploy carries it, exactly as
# no deploy yet carries the base image (see wrangler.toml's STATUS note).
#
# Supporting both properly needs a second Durable Object class with its own
# [[containers]] block and a backend id the DREE/1 layer can select
# (docs/EXECUTION-ENVIRONMENTS.md). That is a real change to the execution
# seam, not a Dockerfile, so it is not smuggled in here.
#
# ---- building it ------------------------------------------------------------
#
#   docker build --platform linux/amd64 --provenance=false --sbom=false \
#     -t registry.cloudflare.com/<account>/deepresearch-palaeo:1 container/palaeo/
#   npx wrangler containers push registry.cloudflare.com/<account>/deepresearch-palaeo:1
#
# Attestation and SBOM OFF for the same reason the base image documents: they
# turn the result into a manifest list and the managed registry wants a single
# plain manifest. linux/amd64 explicitly — the runtime is amd64 and a silently
# arm64 image fails at start, not at build.

FROM debian:stable-slim

# ---- the base layer, identical to ../Dockerfile -----------------------------
# Kept byte-for-byte the same so a research shell behaves identically whichever
# image is bound: the agent loop proposes ordinary Debian commands and must not
# have to know which environment it landed in.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash coreutils findutils diffutils grep sed gawk \
      tar gzip bzip2 xz-utils zip unzip \
      ca-certificates \
      git \
      python3 python3-venv \
      nodejs \
      jq bc file less tree \
      ripgrep \
      sqlite3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale

# ---- the palaeogenomics layer -----------------------------------------------
#
# Every package below was VERIFIED to exist in Debian stable (2026-07-29,
# packages.debian.org). That check needs care: the site answers 200 with an
# error PAGE for a package that does not exist, so a status-code probe reports
# every name as present — including a deliberately invented control. The greps
# behind this list looked for the error marker in the body.
#
# What is deliberately NOT here, and why it matters more than what is:
#
#   * ADMIXTOOLS (qpAdm, qpGraph, f3/f4) is NOT packaged for Debian. It is the
#     tool an ancestry question actually wants, and its absence is the reason
#     this image cannot answer one out of the box. Installing it means building
#     from source, which needs network at build time and a pinned upstream
#     commit — a deliberate follow-up, not a silent addition.
#   * ANGSD (genotype likelihoods for low-coverage data — the standard way to
#     analyse ancient genomes without calling genotypes) is likewise unpackaged.
#     Same treatment.
#
# So this image supports data handling, damage authentication, alignment and
# phylogenetics. It does NOT support population-genetic inference, and an answer
# built on it must not imply otherwise — the same rule the corpus block states
# for itself.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      # Sequence and alignment data: read, filter, index, convert.
      samtools bcftools tabix bedtools vcftools seqtk \
      # Damage authentication — the check that says whether a read is ancient
      # at all (C→T deamination at fragment ends). Without it every claim in
      # this field is unverified.
      mapdamage \
      # Genotype data wrangling: PLINK 1.9 reads the .bed/.bim/.fam trio the
      # Poseidon packages ship, which is what makes a downloaded package usable
      # here at all.
      plink1.9 \
      # Alignment and phylogenetics, for mitogenome work — the tractable
      # analysis on this hardware, where a nuclear genome is not.
      mafft fasttree iqtree raxml \
      # Homology search, for identifying what a fragment is.
      ncbi-blast+ hmmer emboss \
      # The scientific Python stack, plus Biopython for parsing every format
      # above without shelling out.
      python3-biopython python3-numpy python3-scipy python3-pandas python3-matplotlib \
      # R with ape — mapDamage's plotting depends on R, and ape is what reads a
      # tree back in.
      r-base-core r-cran-ape \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale

# The layout the mount bridge fills in — identical to the base image, because
# src/exec-container.js and public/js/sandbox-files.js write into these paths
# and neither knows which image it is talking to.
RUN mkdir -p /workspace/outbox /mnt /src

WORKDIR /workspace

# No service, no port, no agent: commands are started as separate processes
# through the Durable Object's container API, so the entrypoint exists only to
# keep the instance alive until it is reaped. Same as the base image.
ENTRYPOINT ["sleep", "infinity"]
