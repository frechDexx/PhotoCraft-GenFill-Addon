# PhotoCraft-GenFill Addon

**Generative Fill for the PhotoCraft image editor, powered by Google Gemini image models ("Nano Banana").**

Select an area in PhotoCraft, press `Ctrl+Alt+G`, describe what should go there, and get three variants as new masked layers. Browse them, keep one, discard the rest. It works like Generative Fill in Photoshop.

- Floating prompt bar that opens at your mouse with a global shortcut
- Several variants per click (generated in parallel), browsable with thumbnails or `Alt+←/→`
- Results land as layers on top of your document, masked by your selection (soft edges included)
- Non-destructive: your own layers are never changed, every step is in PhotoCraft's history
- Empty prompt = remove the content and reconstruct the background
- Any Gemini image model your API key can use: Nano Banana, Nano Banana Pro (up to 4K) and newer ones

> This is an independent community tool. It is not affiliated with or endorsed by the PhotoCraft project or Google.

---

## Requirements

- **Windows 10/11** (PhotoCraft's control bridge and the launch scripts are Windows-based)
- **PhotoCraft** with `photocraft.exe` and `photocraft-cli.exe` in its install folder
- **Node.js 20 or newer** ([nodejs.org](https://nodejs.org), the LTS version is fine)
- A **Gemini API key** with billing enabled (see below)

## Download

**[⬇ Download the latest release (ZIP)](https://github.com/frechDexx/PhotoCraft-GenFill-Addon/releases/latest)**: open the release and pick `PhotoCraft-GenFill-Addon-vX.Y.Z.zip` under *Assets*. Or clone the repository:

```bash
git clone https://github.com/frechDexx/PhotoCraft-GenFill-Addon.git
```

## Installation

1. Unzip the download (or clone the repository) into a folder of your choice, e.g. `C:\Tools\PhotoCraft-GenFill-Addon`.
2. Double-click **`Start GenFill.vbs`**. On the first start it installs the dependencies (about a minute), then the prompt bar opens with its settings.
3. In the settings:
   - **PhotoCraft folder**: click *Browse…* and choose the folder that contains `photocraft.exe`.
   - **Gemini API key**: paste your key (see next section).
   - Click **Save**.
4. Close PhotoCraft if it is running, then click **Start PhotoCraft** (or restart GenFill). GenFill starts PhotoCraft with its control interface enabled.
5. Optional: double-click **`Create Desktop Shortcut.vbs`**. You get a "PhotoCraft (GenFill)" icon that starts both together, with no console window.

From then on, start PhotoCraft through that shortcut (or `Start GenFill.vbs`). A PhotoCraft started the normal way does not have its control interface open, and GenFill cannot talk to it.

## Getting a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in.
2. Click **Create API key**. AI Studio creates a project for it.
3. **Enable billing for that project** (*Set up billing* next to the key). Image models have **no free quota** on the Free Tier; without billing every request fails with a "quota exceeded … Free Tier" error. Prepaid credit (for example 10 USD) is enough to start.
4. Paste the key into GenFill's settings.

A Google AI Pro / Gemini app subscription does **not** include API usage. The API is billed separately, per generated image. Each variant is one image, so 3 variants per click cost three images. Set *Variants per click* to 1 to save money while testing.

Tip: in the Google Cloud Console, *Billing → Budgets & alerts* lets you set a monthly budget with e-mail warnings.

## Usage

1. In PhotoCraft, make a selection (any tool, feathering is respected).
2. Press **`Ctrl+Alt+G`**. The bar appears at your mouse.
3. Type what should appear in the selection, e.g. *"a sailing boat in the distance"*, and press **Enter**. Leave it empty to remove what is there.
4. Wait. Gemini usually takes 10 to 30 seconds, sometimes longer. **Don't click in PhotoCraft while variants are being placed**; GenFill briefly opens and closes a helper tab for each one.
5. Browse the variants with the thumbnails or `Alt+←` / `Alt+→`.
6. **Keep** deletes the other variants, **Discard** deletes all of them. **Generate** again on the same selection adds more variants to the set.

`Esc` hides the bar. GenFill keeps running in the background; quit it from the settings (`⋯` → *Quit*).

### Choosing a model

Open the settings, click **Load** next to *Model* to list the image models your key can use, pick one and **Save**.

| Model | Notes |
|---|---|
| `gemini-2.5-flash-image` (Nano Banana) | Fast and cheap. Default. |
| `gemini-3-pro-image-preview` (Nano Banana Pro) | Noticeably better detail and prompt understanding, up to 4K. Slower, more expensive. Set *Output size* to 2K or 4K. |
| newer Nano Banana releases | Show up under *Load* when your key has access. |

## Settings

All settings are stored in `config.json` in the GenFill folder (template: `config.example.json`). Relative paths are relative to that folder.

| Setting | Default | Meaning |
|---|---|---|
| Gemini API key | | Also read from the `GEMINI_API_KEY` environment variable. Stored in plain text in `config.json`, so don't share that file. |
| Model | `gemini-2.5-flash-image` | Gemini image model id. |
| Variants per click | 3 | 1 to 4, generated in parallel. |
| Context around selection | 0.35 | How much surrounding image Gemini sees, as a fraction of the selection's longer side. More context blends better but leaves fewer pixels for the selection itself. |
| Output size | model default | 1K / 2K / 4K for models that support it. |
| Shortcut | `Control+Alt+G` | [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator) syntax. |
| PhotoCraft folder | | Folder with `photocraft.exe` and `photocraft-cli.exe`. |
| Start PhotoCraft together with GenFill | on | Starts PhotoCraft with the right parameters if it isn't running. |
| Control port | 47821 | Port of PhotoCraft's control interface. |
| Exchange folder | `exchange` | Where images are exchanged with PhotoCraft. Given to PhotoCraft as automation read and write root. Old jobs can be deleted any time. |

## How it works

```
 PhotoCraft (GUI, --control)  ◄──MCP bridge──►  photocraft-cli mcp --bridge  ◄──stdio──►  GenFill (Electron)  ──HTTPS──►  Gemini API
```

PhotoCraft plug-ins are sandboxed WebAssembly modules without network access, so a plug-in cannot call Gemini. GenFill is a separate app that drives the running PhotoCraft through its official automation interface (`photocraft-cli mcp --bridge`):

1. **Read the selection** (`doc_inspect` → `selectionBounds`) and **export** the flattened image to the exchange folder.
2. **Crop** the selection plus some context, grow the crop to an aspect ratio Gemini supports, and build a black/white mask.
3. **Ask Gemini** for N variants in parallel (image + mask + instructions).
4. **Scale** each result back to the exact crop size.
5. **Bring it into PhotoCraft.** Bridge mode deliberately blocks every command that reads a file by path (Place, Replace Contents, Smart Object via Copy) and `doc_close`. The only way in is `doc_open`, so GenFill does what you would do by hand: open the result, Select All, Copy, undo back to a clean state, close the helper tab through the menu, switch back, *Paste in Place*, move the layer to the crop position and bring it to the front.
6. **Mask** it: the selection is saved to a temporary alpha channel before pasting (pasting drops the selection), loaded again, and applied with *Reveal Selection*. The temporary channel is removed afterwards and your selection stays active.

Gemini does not follow masks pixel-exactly and often repaints the whole crop. That's fine: the layer mask is what decides what you see.

## Limitations

- **Gemini gets a rectangular mask.** It receives the bounding box of your selection. The exact shape (lasso, ellipse, feathered edges) is applied afterwards by the layer mask, so for very irregular selections Gemini paints a bit more than ends up visible.
- **Resolution.** The models return roughly 1 to 2 megapixels (Pro up to 4K). Large selections are upscaled and look softer. Use a higher output size or fill large areas in parts.
- **Results are pixel layers,** not Smart Objects (bridge mode cannot create Smart Objects from files).
- **Don't use PhotoCraft while variants are being placed.** The helper tab and the tab switching are visible, and clicking around can confuse them.
- Windows only for now.

## Troubleshooting

| Message | Fix |
|---|---|
| *Cannot reach PhotoCraft* / *Control token missing* | PhotoCraft was started the normal way. Close it and start it through GenFill (*Start PhotoCraft* in the settings, or the desktop shortcut). Keep the control port the same everywhere. |
| *… on the Free Tier, where image models have no quota* | Enable billing for the API key's project in Google AI Studio (see above). Check that the key belongs to the project that has billing. |
| *No selection* | Make a selection in the active document first. |
| *Export not found* | PhotoCraft was not started with the exchange folder as automation root. Start it through GenFill. |
| *Shortcut … is taken* | Another app uses the shortcut. Pick another one in the settings. |
| *PhotoCraft command not found* | Your PhotoCraft version names a command differently. Run *Test connection* and open an issue with `probe-report.json` attached (it contains no image data). |
| The bar is blank | Quit GenFill (Task Manager → Electron) and start it again with `Start GenFill.vbs`. |

GenFill writes a log to `genfill.log` in its folder. `start-debug.cmd` runs it with a visible console, `F12` in the bar opens the developer tools.

## Development

```bash
npm install
npm test           # unit tests: crop/ratio/mask math, doc_inspect parsing
npm run test:e2e   # full flow against a mock PhotoCraft (test/mock-photocraft.js) and a fake Gemini
npm run probe      # writes probe-report.json from a running PhotoCraft
npm start          # build and run the bar
```

The mock PhotoCraft behaves like the real bridge mode, including the commands it refuses, so the end-to-end test catches regressions without PhotoCraft or an API key.

| File | Purpose |
|---|---|
| `src/photocraft.ts` | Everything PhotoCraft-specific: MCP bridge, command names, placing and masking. |
| `src/gemini.ts` | Gemini API: generation and model list. |
| `src/imaging.ts` | Crop planning, aspect ratios, mask, scaling back. |
| `src/genfill.ts` | The generate / browse / keep / discard flow. |
| `src/main.ts` | Electron app: window, global shortcut, starting PhotoCraft, IPC. |
| `ui/` | The prompt bar. |

Contributions are welcome. Ideas: other image backends (local ComfyUI / Flux Fill, other APIs), an exact selection mask for Gemini, macOS/Linux launchers.

## License

[MIT](LICENSE)
