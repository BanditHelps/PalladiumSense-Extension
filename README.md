# Palladium Sense Extension

A VS Code toolkit for building Palladium addon packs: scaffolding commands, snippets, and an embedded documentation viewer.

## Installation
Extension can be downloaded directly from the VSCode Marketplace.

For source code:
Download the `.vsix` from GitHub (or build with `npm run package`) and install

## Setup
In order to use most features of the extension, you will need to have the .minecraft instance folder open as the workspace.

For standalone .json files, you can set a default path to the palladium documentation folder:
1. Inside of VSCode, go to File > Preferences > Settings
2. Open the Extensions dropdown, and locate PalladiumSense
3. Set the Documentation Path to the absolute file path of the Palladium documentation. Ex: S:\Modrinth\profiles\DevEnv\mods\documentation\palladium

## Features

### Commands
- **New Power** (`palladiumsense.newPower`): prompts for power name/modid/display type and writes a formatted `power.json` under `addonpacks/<pack>/data/<modid>/palladium/powers/`.
- **View Palladium Documentation** (`palladiumsense.viewDocumentation`): opens an in-editor doc viewer with tabs, search, and copy/insert of example snippets into the active editor.
- **Initialize New Addon** (`palladiumsense.initializeAddon`): scaffolds a full addon pack under `addonpacks/<AddonName>/` (data/assets/META-INF, tracked scores, lang, mods.toml, fabric.mod.json, pack.mcmeta) and initializes Git in the new folder. (Only works with Minecraft Instance opened as workspace)
- **Package Addon** (`palladiumsense.packageAddon`): zips an addon pack (excluding `.git`, `packaged_addons`, `.DS_Store`, `Thumbs.db`, plus patterns from `.palladiumignore`) and outputs `<modid>-<timestamp>.jar` into `packaged_addons/`. (Only works with Minecraft Instance opened as workspace)

### Snippets
- Power/ability/condition JSON helpers to speed up authoring Palladium data files. Invoke via IntelliSense while editing JSON files in addon packs.

### Documentation Viewer
- Renders all `mods/documentation/palladium/*.html` files as tabs (Abilities, Conditions first, others alphabetically).
- Search across entries; right-click entries to insert example JSON into the editor or copy to clipboard.
- Formatting helpers normalize examples (adds missing `conditions` block for abilities when needed).
- If your workspace does not contain the documentation, set `palladiumsense.documentationPath` to point at the folder instead.

## Notes
- By default the extension looks under `mods/documentation/palladium/` in the current workspace; configure `palladiumsense.documentationPath` when the files live elsewhere.
- Packaging honors `.palladiumignore` at the addon root for custom excludes.