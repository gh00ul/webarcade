# Arcade Walk v2: shared contract (READ FULLY before you start)

## The product
A first-person, walk-around 3D **arcade** in ONE `index.html`, opened by double-click or a static server.
Three.js r170 (pinned) is loaded from a CDN through an import map; nothing else. No image/model/audio files.
Everything (textures, art, sound) is generated at runtime with canvas 2D, procedural geometry and Web Audio.

The user has seen v1 (plain boxes, flat lighting) and asked to **"greatly improve graphics"** and to
**"make it feel like a real arcade"**. The bar: someone should look at a screenshot and say
"that's a real 90s neon arcade", not "that's a three.js demo". Think: dark room, saturated neon,
glowing screens with animated attract-mode games, glossy cabinets with vinyl side art, that
space-confetti arcade carpet, haze and light beams, prize counter, claw machines, pinball, air hockey,
the hum and bleeps of a crowded arcade.

Kept from v1 and NOT to be broken: click overlay + Pointer Lock, WASD/arrows, Shift to run,
3 m/s walking, frame-rate independent, AABB collision, 20 x 14 x 4 m room, eye height 1.7 m, dot crosshair.
Still out of scope: playable games, jumping, multiplayer, menus, touch/mobile controls.
New: procedural sound (M mutes).

## How the file is built (parts)
`parts/*.js` are concatenated in filename order into ONE `<script type="module">` (see `build.mjs`), so all
parts share one module scope and all top-level names must be unique across parts. Prefix your private
helpers (e.g. `_claw...`, `cab...`, `scr...`) to avoid collisions. `THREE`, `EffectComposer`, `RenderPass`,
`UnrealBloomPass`, `ShaderPass`, `OutputPass` are already imported. For any other addon add a line anywhere in
your part: `//@@import import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';`
(the build hoists it; identical lines are de-duplicated). Only use modules from `three@0.170.0/examples/jsm`.
Lines containing `//@@DEBUG` are stripped from the production build (single-line statements only).

| file | owner | entry point(s) |
|---|---|---|
| 10-core.js | core (do not edit) | shared API below |
| 15-render.js | **look** agent | `setupRenderPipeline()`, `resizeRender(w,h)`, `renderFrame(dt)` |
| 20-lighting.js | **look** agent | `buildLighting()` (runs first) |
| 30-room.js | **room** agent | `buildRoom()` |
| 40-cabinets.js | **cabinets** agent | `buildCabinets()`, `addCabinet(x,z,rot,artIndex)` |
| 45-screens.js | **screens** agent | `makeCabinetArt(index)`, `GAME_COUNT` |
| 50-props.js | **props** agent | `buildProps()` |
| 55-games.js | **games** agent | `buildGameProps()` |
| 60-audio.js | **audio** agent | `setupAudio()`, `startAudio()`, `updateAudio(dt)`, `toggleMute()` |
| 70-input.js | core (do not edit) | input, movement, `hudMessage(text)` |
| 90-main.js | core (do not edit) | build order + render loop |

Build order (90-main.js): setupRenderPipeline, buildLighting, buildRoom, buildCabinets, buildProps, buildGameProps,
setupAudio, setupInput, then the loop: `updatePlayer(dt)`, every `onUpdate` hook, `updateAudio(dt)`, `renderFrame(dt)`.

## Shared API (from 10-core.js)
`ROOM {w:20,d:14,h:4}` (x east-west, z north-south, y up; room centred on origin; floor y=0),
`NEON {pink,cyan,purple,orange,yellow,green,red,blue}` (hex ints), `QUALITY {level,pixelRatio,bloom,adapt}`,
`renderer`, `scene`, `camera`, `canvas`, `player {x,z,yaw,pitch}`, `colliders`, `addCollider(minX,maxX,minZ,maxZ)`,
`onUpdate(fn(t,dt))`, `registry {cabinets[], props[], lights[]}`, `makeCanvas(w,h) -> {canvas,ctx}`,
`canvasTexture(canvas,{srgb,repeat,anisotropy})`, `rng(seed) -> () => [0,1)`, `ARCADE_FONT`, `fontsReady` (promise;
the "Press Start 2P" web font may or may not load, so ALWAYS draw text with `ARCADE_FONT` fallbacks and, for
canvases drawn once, redraw after `fontsReady.then(...)`), `hudMessage(text)`, `THREE`.
Coordinates: yaw 0 looks toward -z (north). A cabinet at rotation 0 faces +z (south); rot = PI/2 faces +x (east); PI faces -z; -PI/2 faces -x.

`registry.cabinets.push({x,z,rot,color,name,art})` (cabinets part). `registry.props.push({kind,x,z,y?,color?,...})` for
anything that should make sound or light. Known kinds: `'pinball' 'claw' 'airhockey' 'prize' 'vending' 'change' 'door' 'sign' 'scoreboard'`.
The audio part must tolerate unknown kinds and missing fields.

`makeCabinetArt(index)` (screens part) returns
`{ name, color (hex int), aspect (4/3), screenTex (canvas 256x192, animated), marqueeTex (512x128),
   sideTex (256x512, vinyl side decal for the ~0.8 m x 2 m cabinet side), panelTex (512x192, control-panel decal) }`.
It animates its own textures via `onUpdate`. `GAME_COUNT` >= 16 distinct games (name/colour/animation).
Other parts may call it (e.g. a pinball backglass) and must not assume more than the fields above.

## Floor plan (zones are exclusive; stay inside yours)
x runs -10 (west wall) .. +10 (east wall), z runs -7 (north wall) .. +7 (south wall). Player starts at (0, 5) facing north.
* **Entrance**: double glass doors in the SOUTH wall, x in [-1.6, 1.6] (room part), with an EXIT sign above (props part, y ~ 2.6-3.2).
* **Prize counter**: x in [-4.5, 4.5], z in [-7, -5.4], against the NORTH wall (props part) + a big neon "ARCADE" sign on the wall above it (y 2.2-3.7) + prize shelves on the wall behind.
* **NW and NE corners**: x in [-10,-6.5] and [6.5,10], z in [-7,-5.2]: token/change machine, drink vending, trash bin etc. (props part).
* **West wall strip**: x in [-10,-8.55], z in [-4.6, 4.6]: video cabinets facing east, packed side by side (cabinets part).
* **Central island**: x in [-2.4, 2.4], z in [-0.95, 0.95]: two back-to-back rows of video cabinets (cabinets part).
* **West-centre**: x in [-7.5,-3.5], z in [-3.5,3.5]: cabinets part MAY add a second island (up to 10 cabinets, footprints inside this box) or leave it open.
* **East wall strip**: x in [8.6, 10], z in [-4.6, 3.6]: pinball machines facing west (games part).
* **South wall, both sides of the door**: x in [-8.5,-2.5] and [2.5, 8.5], z in [5.6, 7]: claw machines facing north (games part).
* **East-centre open floor**: x in [3.5, 7.5], z in [-4, 3]: air hockey table(s) + stools (games part).
* **Walls & ceiling above 2.2 m** are shared decoration space: room part = architecture (ceiling ducts/pipes/tiles, baseboards, wall panels, door frame, neon strips); props part = signs/posters/scoreboard hung on walls (y 1.9-3.7); look part = ceiling spot cans, beams and lights.
* Keep clear walking aisles >= 1.1 m between zones (the player has a 0.3 m radius). Every solid object needs a collider (`addCollider`) sized to its footprint. Nothing may block the start position (0,5) or the doors.

## Art direction (all parts follow this so the room looks coherent)
"Neon-noir 90s arcade." Near-black room (base #05040a), saturated neon accents (cyan, magenta, purple; orange/yellow/green sparingly), warm white/amber only for the prize counter and exit sign, cool blue-ish bleed from the street through the glass doors.
Surfaces have character: carpet pile + confetti pattern, scuffed vinyl, brushed metal trim, glossy plastic, glass. Lived-in details (stickers, wear, cable clutter, posters) beat clean CG. Scale and proportions must be realistic (cabinet ~2 m tall, claw machine ~1.9 m, pinball 1.5 m long and 0.7 m wide, air hockey table 2.1 x 1.2 x 0.8 m, prize counter 1.05 m high).
HDR guide (post-processing is tone-mapped ACES + bloom): neon tubes `emissiveIntensity` about 2.5-4, glowing plastic/marquees 1.2-2, screens (MeshBasicMaterial) colour multiplier about 1.0-1.4. Never let big flat areas exceed ~1.5 (they bloom into a white wash). Bloom threshold is ~0.8-1.0.

## Performance budget (must feel smooth at 1080p on an integrated GPU / M1)
Whole scene, per frame, including post-processing passes: draw calls <= 350, triangles <= 600k, real lights (Point+Spot+RectArea) <= 10 total across ALL parts (look part owns the budget: props/games/cabinets should NOT add real lights; use emissive materials, additive glow sprites/planes and baked-look tricks instead),
canvas textures re-uploaded per frame <= 20 and each <= 256x192 (throttle animated ones to ~15-20 fps and skip when far/behind the camera), total textures <= 150, JS work per frame <= 2 ms, no per-frame allocation (`new Vector3()` etc.) inside `onUpdate` hooks, share geometries/materials, merge static meshes (`mergeGeometries` from `three/addons/utils/BufferGeometryUtils.js`) or use `InstancedMesh`. Prefer few big textures over many small ones.
Software-GL in the test harness is 20-50x slower than a real GPU: judge performance by the harness *stats* (calls, triangles, textures, lights, jsMs), not by frame rate.

## Code quality (the owner wants to build on this later)
Readable, commented, small clearly-named functions per object type, constants at the top of your part, no dead code, no debug leftovers (except single-line `//@@DEBUG`), no `eval`, no globals on `window` (except in `//@@DEBUG` lines), no external files. Parts may be long, but keep them tidy; a future reader should be able to add another cabinet type or prop by copying a function.

## Tools available to you
* Work in YOUR OWN COPY so agents never clobber each other:
  `mkdir -p WORK/<you> && cp -r ARCADE2/template.html ARCADE2/parts WORK/<you>/` (paths are given in your task).
  Edit only your own part file(s) inside `WORK/<you>/parts/`. Other files/parts in your copy are the plain *skeleton*
  versions (other agents are upgrading theirs in parallel; final integration happens later), so: use only the documented API,
  do not modify other files (changes there are discarded), and make your code robust if other parts behave differently.
* Build: `node ARCADE2/build.mjs WORK/<you> --out WORK/<you>/dist/index.html` (production build; must succeed).
* Look at it: `node ARCADE2/shot.mjs WORK/<you> --out WORK/<you>/shots --views start,island-close --w 960 --h 540`
  (add `--settle 6` for more frames before each shot). It prints a JSON report {errors, warnings, stats}. Then **Read the PNGs**
  (the Read tool shows images) and critique honestly: does it look like a real arcade? iterate. `views.json` lists all camera views
  (`start`, `start-left`, `island-close`, `west-close`, `prize-counter`, `ceiling`, `floor`, ...). The harness page exposes `window.__dbg`
  ({player,camera,colliders,registry,renderer,scene,updaters,QUALITY,frames}); you may write your own small Playwright scripts based on
  shot.mjs (copy it into your workdir) to test something specific (e.g. custom camera poses, `page.evaluate` checks, offline audio rendering).
  The harness is software-GL: one 960x540 frame takes ~0.3-2 s, so take few, well-chosen screenshots (a handful per iteration, not dozens).
* Zero console errors/warnings from your code. Test in production build mode too (no `__dbg`).

## Deliverable
When done, copy your final part file(s) to `ARCADE2/out/<same filename>` (e.g. `ARCADE2/out/40-cabinets.js`), overwriting any earlier copy,
then answer with the JSON the task asks for. Be honest in `knownIssues` (things you could not verify, visual weaknesses you saw, assumptions about other parts).
