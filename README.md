# Grid Auto-Align

Install in Foundry: Add-on Modules → Install Module → paste this Manifest URL:

    https://github.com/PsyK2812/foundry-grid-autoalign/releases/latest/download/module.json

One click to line Foundry's grid up with the grid printed on a battle map — across the whole map, not just the middle.

## Why grids drift
Foundry only accepts whole-pixel grid sizes. If the map's squares are really 140.6 px, a 140 or 141 px grid drifts a little more with every square, so it matches in the middle and is off at the edges. This module measures the map's real square size (to a fraction of a pixel), then resizes the scene so each map square is exactly one Foundry grid square and shifts the background so the lines sit on top of each other.

## Use
- **Left toolbar → Tiles → "Auto-Align Grid to Map"** (current scene), or
- **Right-click a scene** in the Scenes sidebar or the top navigation → **Auto-Align Grid**.

A dialog shows the detected square size, map size in squares and a confidence rating. Pick the Foundry grid size (the default keeps the map at its original resolution) and click **Align Grid**.

To revert: right-click the scene → **Undo Grid Auto-Align**.

Macro: `game.modules.get("grid-autoalign").api.align(scene)`

## Notes
- Align a map **before** placing walls, tokens and tiles — existing objects don't move with the map.
- Works with images and video backgrounds. Maps hosted on another website without CORS can't be read.
- Needs a visible printed grid on the map; gridless maps get a "low confidence" warning.
