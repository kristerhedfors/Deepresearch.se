# ffmpeg recipes beyond the default pipeline

`scripts/capture-edit.mjs` covers the common case: cut the dead air, pick a
speed, deliver an MP4 LinkedIn plays. Everything below is a second pass over
`final.mp4` — deliberately kept out of the CLI so the default path stays one
ffmpeg invocation with one encode.

Run these from the capture directory. Every one of them re-encodes, so apply
them to `final.mp4` and keep it: `final.mp4` is the reproducible artifact,
these are variants of it.

## A caption burned into the frame

A feed video is watched muted, so the first two seconds have to say what this
is. `drawtext` needs a font path; on Debian/Ubuntu the DejaVu package is
almost always present.

```bash
ffmpeg -i final.mp4 -vf "drawtext=\
fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:\
text='Deep research, unedited':fontsize=44:fontcolor=white:\
box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h-160:\
enable='between(t,0,3)'" -c:v libx264 -crf 21 -preset slow \
-pix_fmt yuv420p -movflags +faststart -an captioned.mp4
```

`enable='between(t,0,3)'` is what makes it a title card rather than a
permanent watermark. Escape the colons inside `drawtext` (`\:`) if the text
contains any.

## Subtitles from a file instead

More readable to edit, and it survives a re-encode at a different size.

```bash
ffmpeg -i final.mp4 -vf "subtitles=captions.srt:force_style='FontSize=22,\
PrimaryColour=&H00FFFFFF,BackColour=&H80000000,BorderStyle=3'" \
-c:v libx264 -crf 21 -pix_fmt yuv420p -movflags +faststart -an subbed.mp4
```

## Music under it

The default pipeline is `-an` on purpose (LinkedIn autoplays muted). If a
track is genuinely wanted, add it as a second input and cut it to the video's
length — `-shortest` is what stops a 3-minute track padding a 20-second clip.

```bash
ffmpeg -i final.mp4 -i bed.m4a -filter_complex "[1:a]volume=0.25,\
afade=t=out:st=18:d=2[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 128k \
-shortest -movflags +faststart with-music.mp4
```

`-c:v copy` keeps the video stream untouched — no second generation loss.

## A silent, autoplay-safe GIF (or animated WebP) for a README

GIF needs a palette pass or the gradients band badly.

```bash
ffmpeg -i final.mp4 -vf "fps=12,scale=640:-1:flags=lanczos,palettegen=stats_mode=diff" -y palette.png
ffmpeg -i final.mp4 -i palette.png -lavfi "fps=12,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer" -y clip.gif
```

WebP is usually a third of the size and every current browser plays it:

```bash
ffmpeg -i final.mp4 -vf "fps=15,scale=720:-1:flags=lanczos" -loop 0 -q:v 60 -an clip.webp
```

## Two agents answering the same prompt, side by side

The most useful comparison this pipeline can produce: capture the same starter
under two agents or two models, then stack them. Pad first so both inputs are
the same height, or `hstack` refuses.

```bash
ffmpeg -i a/final.mp4 -i b/final.mp4 -filter_complex \
"[0:v]scale=540:-2,pad=540:1350:0:(oh-ih)/2:color=black[l];\
 [1:v]scale=540:-2,pad=540:1350:0:(oh-ih)/2:color=black[r];\
 [l][r]hstack=inputs=2[v]" -map "[v]" -c:v libx264 -crf 21 \
-pix_fmt yuv420p -movflags +faststart -an compare.mp4
```

`vstack` for a portrait comparison. The two clips will not be the same length;
`hstack` ends with the shortest, which is usually what you want — pass
`shortest=0` and pad with `tpad` if you need the longer one to finish.

## Re-cutting without re-recording

`edit.json` holds the segment list that produced `final.mp4`. To try different
knobs, re-run the edit CLI against the SAME `raw.webm` — never re-encode
`final.mp4`, which is already one generation down:

```bash
node scripts/capture-edit.mjs <dir> --speed 2 --wait cut --out /tmp/faster.mp4
```

## Checking what you actually produced

```bash
ffprobe -v error -show_entries format=duration,size,bit_rate \
        -show_entries stream=codec_name,profile,pix_fmt,width,height,r_frame_rate \
        -of default=noprint_wrappers=1 final.mp4
```

The three lines that decide whether LinkedIn plays it: `codec_name=h264`,
`pix_fmt=yuv420p`, and a `moov` atom at the front — which `+faststart` gives
you and which you can confirm with:

```bash
ffprobe -v trace -i final.mp4 2>&1 | grep -m2 -E "type:'(moov|mdat)'"
```

`moov` must appear before `mdat`.
