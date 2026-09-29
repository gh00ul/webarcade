# Arcade Walk

A first-person, walk-around 3D neon arcade that runs in the browser. It ships as **one file, `index.html`**: no build step, no install, no assets. Three.js is loaded from a CDN.

## Run it

- Double-click `index.html` (Chrome, Firefox or Edge), or serve the folder: `python3 -m http.server` and open <http://localhost:8000>.
- Needs an internet connection (Three.js and one web font load from a CDN) and WebGL2.
- To host it, any static host works. On GitHub Pages: Settings → Pages → deploy from `main`, root.

## Controls

| Input | Action |
| --- | --- |
| Click | Enter (captures the mouse) |
| Mouse | Look around |
| W A S D / arrow keys | Walk (3 m/s) |
| Shift | Move faster (5.5 m/s) |
| M | Sound on / off |
| Esc | Release the mouse |

## What's in it

Confetti carpet, exposed ceiling with trusses and ducts, glass entrance doors onto a night street, 24 video cabinets with 16 different animated attract-mode games, a prize counter with a neon sign, pinball machines, claw machines, air hockey, vending and change machines, posters and an LED scoreboard. Bloom and colour grading run as post-processing; quality lowers itself automatically on slow machines. Sound is generated live with Web Audio (no audio files).

## Editing it

`index.html` is assembled from the readable sources in `src/`. Edit those, then rebuild:

```sh
cd src
node build.mjs . --out ../index.html
```

- `src/parts/*.js` are concatenated in filename order into one module: `15-render` (post-processing), `20-lighting`, `30-room`, `40-cabinets`, `45-screens` (the attract-mode art), `50-props`, `55-games` (pinball, claw, air hockey), `60-audio`, plus core/input/main.
- `src/CONTRACT.md` describes the shared API, the floor plan and the performance budget each part follows.
- Lines ending in `//@@DEBUG` are stripped from the production build.
