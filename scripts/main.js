import { detectGrid, planAlignment } from "./detect.js";

const MODULE_ID = "grid-autoalign";
const CONFIDENT_Z = 5;
const MAX_CANVAS = 16000;

/* -------------------------------------------- */
/*  Where the background lives (v14 Levels vs v13) */
/* -------------------------------------------- */

/**
 * Find the background image and the document/field that holds its offset.
 * v14: background belongs to a Level (level.background.src, level.textures.offsetX).
 * v13: scene.background.src / scene.background.offsetX.
 */
function getBackgroundInfo(scene) {
  const has = foundry.utils.hasProperty;
  const level = scene.initialLevel ?? scene.firstLevel ?? scene.levels?.contents?.[0] ?? null;
  if (level?.background?.src) {
    const src = level._source ?? level;
    let offsetDoc = level, offsetPath = null;
    if (has(src, "textures.offsetX")) offsetPath = "textures";
    else if (has(src, "background.offsetX")) offsetPath = "background";
    return { src: level.background.src, offsetDoc, offsetPath };
  }
  if (scene.background?.src) {
    const src = scene._source ?? scene;
    const offsetPath = has(src, "background.offsetX") ? "background" : null;
    return { src: scene.background.src, offsetDoc: scene, offsetPath };
  }
  return null;
}

function readOffset(info) {
  if (!info.offsetPath) return { x: 0, y: 0 };
  const g = foundry.utils.getProperty;
  const s = info.offsetDoc._source ?? info.offsetDoc;
  return { x: g(s, `${info.offsetPath}.offsetX`) ?? 0, y: g(s, `${info.offsetPath}.offsetY`) ?? 0 };
}

/* -------------------------------------------- */
/*  Image loading + luminance profiles            */
/* -------------------------------------------- */

const VIDEO_EXT = /\.(webm|mp4|m4v|ogv|ogg)(\?|$)/i;

async function loadMedia(src) {
  if (VIDEO_EXT.test(src)) {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    await new Promise((res, rej) => {
      v.addEventListener("loadeddata", res, { once: true });
      v.addEventListener("error", () => rej(new Error(`Could not load video ${src}`)), { once: true });
    });
    return { el: v, w: v.videoWidth, h: v.videoHeight };
  }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = src;
  await img.decode().catch(() => { throw new Error(`Could not load image ${src}`); });
  return { el: img, w: img.naturalWidth, h: img.naturalHeight };
}

/** Sum luminance per column and per row, processing the image in strips. */
async function luminanceProfiles(media) {
  const f = Math.min(1, MAX_CANVAS / media.w, MAX_CANVAS / media.h);
  const W = Math.max(1, Math.round(media.w * f));
  const H = Math.max(1, Math.round(media.h * f));
  const strip = Math.max(1, Math.min(H, Math.floor(16_000_000 / W)));
  const cvs = document.createElement("canvas");
  cvs.width = W;
  cvs.height = strip;
  const ctx = cvs.getContext("2d", { willReadFrequently: true });
  const colSums = new Float64Array(W);
  const rowSums = new Float64Array(H);
  for (let y0 = 0; y0 < H; y0 += strip) {
    const h = Math.min(strip, H - y0);
    ctx.clearRect(0, 0, W, strip);
    // Source rect in original pixels → destination in scaled pixels
    ctx.drawImage(media.el, 0, y0 / f, media.w, h / f, 0, 0, W, h);
    let data;
    try {
      data = ctx.getImageData(0, 0, W, h).data;
    } catch (err) {
      throw new Error("The browser blocked reading this image (it is probably hosted on another site without CORS).");
    }
    for (let y = 0; y < h; y++) {
      let row = 0;
      const base = y * W * 4;
      for (let x = 0; x < W; x++) {
        const i = base + x * 4;
        const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * (data[i + 3] / 255);
        colSums[x] += lum;
        row += lum;
      }
      rowSums[y0 + y] = row;
    }
    // Let the UI breathe on huge maps
    await new Promise((r) => setTimeout(r, 0));
  }
  return { colSums, rowSums, f };
}

/* -------------------------------------------- */
/*  Main action                                   */
/* -------------------------------------------- */

async function analyse(scene) {
  const info = getBackgroundInfo(scene);
  if (!info) throw new Error(`Scene "${scene.name}" has no background image.`);
  const media = await loadMedia(info.src);
  if (!media.w || !media.h) throw new Error("Could not read the background image size.");
  const { colSums, rowSums, f } = await luminanceProfiles(media);
  const det = detectGrid(colSums, rowSums, { minP: Math.max(8, 20 * f), maxP: 600 * f });
  if (!det?.x || !det?.y) throw new Error("No grid could be found on this map.");
  // Back to original image pixels
  for (const a of [det.x, det.y]) { a.period /= f; a.phase /= f; }
  return { info, det, imgW: media.w, imgH: media.h };
}

let busy = false;
async function alignScene(scene) {
  if (busy) return;
  busy = true;
  try { return await _alignScene(scene); } finally { busy = false; }
}

async function _alignScene(scene) {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can align the grid.");
  scene ??= canvas.scene;
  if (!scene) return ui.notifications.warn("No scene to align.");

  const note = ui.notifications.info(`Grid Auto-Align: analysing "${scene.name}"…`, { permanent: true });
  let result;
  try {
    result = await analyse(scene);
  } catch (err) {
    console.error(`${MODULE_ID} |`, err);
    return ui.notifications.error(`Grid Auto-Align: ${err.message}`);
  } finally {
    try { ui.notifications.remove?.(note); } catch (e) { /* older API */ }
  }

  const { info, det, imgW, imgH } = result;
  const minZ = Math.min(det.x.z, det.y.z);
  const confident = minZ >= CONFIDENT_Z;
  const defaultSize = Math.max(50, Math.round((det.x.period + det.y.period) / 2));
  const placed = ["tokens", "walls", "tiles", "lights", "drawings", "notes", "regions", "sounds"]
    .reduce((n, k) => n + (scene[k]?.size ?? 0), 0);

  const content = `
    <div class="grid-autoalign-dialog">
      <p>Found the map's printed grid:</p>
      <ul>
        <li>Square size on the image: <strong>${det.x.period.toFixed(2)} × ${det.y.period.toFixed(2)} px</strong></li>
        <li>Map size: about <strong>${(imgW / det.x.period).toFixed(1)} × ${(imgH / det.y.period).toFixed(1)}</strong> squares</li>
        <li>Confidence: <strong style="color:${confident ? "#4caf50" : "#e0a020"}">${confident ? "good" : "low — check the result"}</strong> (${minZ.toFixed(1)})</li>
      </ul>
      ${placed ? `<p style="color:#e0a020"><strong>Note:</strong> this scene already has ${placed} placed object(s) (walls, tokens, tiles…). They won't move with the map.</p>` : ""}
      ${info.offsetPath ? "" : `<p style="color:#e0a020">Couldn't find the background offset setting in this Foundry version, so only size and grid will be set.</p>`}
      <div class="form-group">
        <label>Foundry grid size (px)</label>
        <input type="number" name="gridSize" value="${defaultSize}" min="50" step="1">
      </div>
      <p class="hint">Default keeps the map at its original resolution.</p>
    </div>`;

  const gridSize = await foundry.applications.api.DialogV2.wait({
    window: { title: `Grid Auto-Align: ${scene.name}`, icon: "fa-solid fa-border-all" },
    content,
    buttons: [
      {
        action: "apply", label: "Align Grid", icon: "fa-solid fa-check", default: true,
        callback: (_e, button) => Number(button.form.elements.gridSize.value)
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null }
    ],
    rejectClose: false
  });
  if (!gridSize || !Number.isFinite(gridSize) || gridSize < 1) return;

  const plan = planAlignment(det, imgW, imgH, Math.round(gridSize));
  const before = {
    width: scene.width, height: scene.height, gridSize: scene.grid.size,
    offset: readOffset(info), offsetPath: info.offsetPath,
    offsetDocId: info.offsetDoc === scene ? null : info.offsetDoc.id
  };

  await scene.update({
    width: plan.width,
    height: plan.height,
    "grid.size": plan.gridSize,
    [`flags.${MODULE_ID}.undo`]: before
  });
  if (info.offsetPath) {
    await info.offsetDoc.update({
      [`${info.offsetPath}.offsetX`]: plan.offsetX,
      [`${info.offsetPath}.offsetY`]: plan.offsetY
    });
  }
  ui.notifications.info(
    `Grid Auto-Align: grid ${plan.gridSize}px, scene ${plan.width}×${plan.height}, offset ${plan.offsetX}/${plan.offsetY}. Right-click the scene → "Undo Grid Auto-Align" to revert.`
  );
}

async function undoAlign(scene) {
  scene ??= canvas.scene;
  const before = scene?.getFlag(MODULE_ID, "undo");
  if (!before) return ui.notifications.warn("Nothing to undo for this scene.");
  await scene.update({
    width: before.width, height: before.height, "grid.size": before.gridSize,
    [`flags.${MODULE_ID}.-=undo`]: null
  });
  if (before.offsetPath) {
    const doc = before.offsetDocId ? scene.levels?.get(before.offsetDocId) : scene;
    await doc?.update({
      [`${before.offsetPath}.offsetX`]: before.offset.x,
      [`${before.offsetPath}.offsetY`]: before.offset.y
    });
  }
  ui.notifications.info(`Grid Auto-Align: restored "${scene.name}".`);
}

/* -------------------------------------------- */
/*  UI hooks                                      */
/* -------------------------------------------- */

function sceneFromLi(li) {
  const el = li?.[0] ?? li;
  const id = el?.dataset?.entryId ?? el?.dataset?.documentId ?? el?.dataset?.sceneId
    ?? li?.data?.("documentId") ?? li?.data?.("entryId");
  return game.scenes.get(id);
}

function contextEntries() {
  return [
    {
      name: "Auto-Align Grid", label: "Auto-Align Grid",
      icon: '<i class="fa-solid fa-border-all"></i>',
      condition: () => game.user.isGM,
      visible: () => game.user.isGM,
      callback: (li) => alignScene(sceneFromLi(li)),
      onClick: (_e, li) => alignScene(sceneFromLi(li))
    },
    {
      name: "Undo Grid Auto-Align", label: "Undo Grid Auto-Align",
      icon: '<i class="fa-solid fa-rotate-left"></i>',
      condition: (li) => game.user.isGM && !!sceneFromLi(li)?.getFlag(MODULE_ID, "undo"),
      visible: (li) => game.user.isGM && !!sceneFromLi(li)?.getFlag(MODULE_ID, "undo"),
      callback: (li) => undoAlign(sceneFromLi(li)),
      onClick: (_e, li) => undoAlign(sceneFromLi(li))
    }
  ];
}

const addContext = (_app, options) => { options.push(...contextEntries()); };
Hooks.on("getSceneContextOptions", addContext);          // v13+ sidebar
Hooks.on("getSceneDirectoryEntryContext", addContext);   // v12 sidebar
Hooks.on("getSceneNavigationContext", addContext);        // top navigation bar

// Button in the left toolbar (Tiles controls) — one click aligns the current scene
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tool = {
    name: "grid-autoalign",
    title: "Auto-Align Grid to Map",
    icon: "fa-solid fa-border-all",
    button: true,
    visible: true,
    order: 99,
    onChange: () => alignScene(canvas.scene)
  };
  if (Array.isArray(controls)) {
    const tiles = controls.find((c) => c.name === "tiles");
    tiles?.tools.push({ ...tool, onClick: () => alignScene(canvas.scene), onChange: undefined });
  } else {
    const tiles = controls.tiles;
    if (tiles?.tools) tiles.tools[tool.name] = tool;
  }
});

Hooks.once("init", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { align: alignScene, undo: undoAlign, analyse };
});
