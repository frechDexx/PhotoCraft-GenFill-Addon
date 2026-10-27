First public release of **PhotoCraft-GenFill Addon**: Generative Fill for the PhotoCraft image editor, powered by Google Gemini image models ("Nano Banana").

### Download
Get **`PhotoCraft-GenFill-Addon-v1.0.0.zip`** below, unzip it, and double-click **`Start GenFill.vbs`**. Full setup in the [README](https://github.com/frechDexx/PhotoCraft-GenFill-Addon#installation).

Requires Windows 10/11, PhotoCraft, Node.js 20+ and a Gemini API key with billing enabled.

### Features
- Floating prompt bar, opens at the mouse with `Ctrl+Alt+G`
- Several variants per click in parallel, browse with thumbnails or `Alt+←/→`, Keep / Discard
- Results as masked layers on top of your document, your own layers stay untouched
- Empty prompt removes content and rebuilds the background
- Any Gemini image model your key can use (Nano Banana, Nano Banana Pro up to 4K, newer)
- Starts PhotoCraft with its control interface enabled
- Unit tests and an end-to-end test against a mock PhotoCraft
