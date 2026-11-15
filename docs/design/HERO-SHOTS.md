# Hero image — fictional data, no sign-in wall

Status: produced 2026-11-15. Assets: `docs/design/hero/`.

## Why

The README hero must not leak any real project, path, person or session. It is
built from the same **real client bundle** and the same **fictional dataset** as
the demo screenshots (Orion Studio, Nebula API, Atlas Docs — invented paths under
`D:\Demo\…`), captured in a standalone page that mounts the plugin alone. That
page has **no DSH host shell**, so the host's sign-in wall ("Connectez-vous /
Ajouter une clé API") cannot appear — and `metrics.json` proves it was absent at
capture time (`signInOverlay.present: false`, `textSeen: false`,
`overlayElements: 0`).

## How

```powershell
node scripts/capture-demo-screenshots.mjs --hero
python -B scripts/hero-compose.py docs/design/hero/hero-desktop-1440x900.png docs/design/hero/hero-mobile-390x844.png docs/design/hero/hero.png
```

`capture-demo-screenshots.mjs --hero` reuses the demo harness (real client
bundle + fake host state) and captures the cockpit at `deviceScaleFactor: 2`:

1. seeds the UI to the global view with the **Tout / All** filter, so all ten
   invented sessions are visible (attention, running and other sections);
2. asserts the page reports ten `.dab-gcard-wrap` cards, the dark body
   background (`rgb(20, 20, 20)`) and no sign-in text or overlay element;
3. writes `metrics.json` with each shot's viewport, scale, cards, sections,
   titles, the centre hit-test (`reachable`) and the sign-in facts.

`hero-compose.py` (Pillow) picks the backdrop from the desktop capture's measured
luminance (dark panel → dark stage) and lays the desktop panel and the phone on a
2560×1440 canvas with rounded corners, a shadow, a slim phone frame and the
caption.

## Result

| File | Content |
| --- | --- |
| `hero.png` | 2560×1440 composition: desktop panel (left) + phone (right), dark stage, caption |
| `hero-desktop-1440x900.png` | full cockpit panel at 1440×900, `deviceScaleFactor: 2` (2880×1800) |
| `hero-mobile-390x844.png` | phone portrait panel at 390×844, `deviceScaleFactor: 2` (780×1688) |
| `metrics.json` | capture facts, sign-in proof, and the composition geometry |

Measured on this dark run: desktop panel mean luminance **0.149**, composed
canvas **0.130** (34/255), caption band standard deviation **51.9** (the caption
is present), near-white pixels **0.45 %** (text only — no white sign-in panel),
ten cards, filter **Tout**, theme **dark** (`applied: "dark"`).

## Limits

- The capture page is a static harness fed with a fake host state; it renders the
  real client bundle, not a live DSH GUI. The demo screenshots have the same
  status.
- The backdrop, device frame, shadow and caption exist only in `hero.png`; the
  two panel captures are untouched.
- The dataset is fictional and shared with the demo screenshots; no real
  workspace, session id, path or person is read or written.
- The captures reflect the working tree at the time of the run, not a tagged
  release.
