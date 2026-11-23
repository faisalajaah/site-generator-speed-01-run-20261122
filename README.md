# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/faisalajaah/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/faisalajaah/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, for the
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty. `solve.js` answers exactly as makefun-site 1.0.0 does on every
case — same front matter, same template dialect, same Markdown subset,
same slug rule, same build report, byte for byte — and does it faster.
`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## Run it

```sh
node main.ts
```

## How it is faster

The reference is a clean, general implementation; this one keeps its
semantics and removes the work it repeats:

- **Markdown, single pass.** Blocks are classified by character code and
  rendered straight into the output — no token objects, no second pass.
  Inline markup is handled run-based: plain stretches are escaped in
  bulk (one native regex scan) instead of one `escapeHtml` call per
  character.
- **Templates compiled, not interpreted.** Each template is parsed once
  and compiled with `new Function` to a function over a flat frames
  array; rendering is then plain code, with no scope objects allocated
  per loop iteration.
- **Cheap text work.** `slugify` takes an ASCII fast path (no NFKD /
  mark-strip when the text is ASCII) and caches repeated titles, tag
  names and headings; front matter is scanned by line index so the body
  is one slice instead of a split and a join of the whole file.

## Measured

On the practice set (3 cases, 257–486 files each), on this machine:

| | mean of 15 runs |
| --- | --- |
| this entry | ~210 ms |
| makefun-site 1.0.0 | ~468 ms |

about 2.2x faster, steady state about 2.5x. All 3 practice cases are
byte-identical to the kit's expected answers, and 18 further cases drawn
fresh from the kit's generator with new seeds are byte-identical to the
oracle. Two runs of the same input produce byte-identical output.

## Layout

- `solve.js` — the entry. Dependency-free ES module, `run(input)`.
- `main.ts` — the driver. Turns V8 incremental marking off (as the
  house driver does), reads `/input/cases.json`, writes
  `/output/answers.json`.

Referral code: `9eqj58cc` — https://make.fun/r/9eqj58cc

---

<sub>Entered on [make.fun](https://make.fun/?ref=9eqj58cc&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
