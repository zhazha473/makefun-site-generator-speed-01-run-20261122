# Single-pass makefun-site-exact builder, 2.1x less CPU

[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zhazha473/makefun-site-generator-speed-01-run-20261122/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zhazha473/makefun-site-generator-speed-01-run-20261122/reward.svg)](https://make.fun)

A faster drop-in for makefun-site 1.0.0 for the make.fun bounty
[site-generator-speed-01-run-20261122](https://make.fun): `solve.js` answers
exactly as makefun-site does on every case — same output tree, byte for
byte (front matter, slug rule, Markdown subset, template dialect, link
resolution, build report) — but built in a single fused pass instead of
the reference's plugin pipeline with its intermediate token tree.

Measured on the practice set on this machine (median of 5 runs each,
user+sys CPU): this entry 0.697 s, makefun-site 1.273 s end to end, and
0.502 s vs 1.078 s net of the do-nothing entry — 2.15x less CPU. Its
`run()` alone takes about 0.20 s per set against about 0.65 s for the
reference. Verified byte-identical on all 3 practice cases and on 18
further cases drawn fresh from the competition generator.

## How it is faster

- **Fused single pass:** front matter is parsed by scanning line
  boundaries, Markdown is lexed and rendered in the same pass with
  blocks streamed straight into one output array — no token objects,
  no per-character escaping, no string concatenation per node.
- **Flat template ops:** each template is compiled once per case into
  a flat instruction list and rendered into an output array joined
  once; scope lookup walks a short frame stack, and render variables
  are shared through one base frame per case.
- **Memoized includes:** an include is rendered once and reused when
  a static analysis proves it depends only on case-constant values
  (header, navigation) or only on one loop object (a post's card,
  reused across index and tag pages); anything that reads a render
  variable, another loop's variable, or an enclosing `loop` is never
  memoized.
- **Fast paths:** slugs take an ASCII-only path (no NFKD normalisation
  or `\p{M}` work) with the slow path only when non-ASCII appears, and
  slug results are cached; HTML escaping first checks for a special
  character with plain `indexOf` scans; plain inline runs are escaped
  in one bulk replace; a post's card is computed once and reused by
  the index, tag and recent lists.

## Layout

- `solve.js` — the fast implementation; `run(input)` returns
  makefun-site's answer for `{site, templates, files}`.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`.

## Licence

MIT — see [LICENSE](LICENSE).
