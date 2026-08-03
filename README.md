# opencode-vision

Give non-vision opencode models (e.g. `opencode/deepseek-v4-flash-free`) the ability to see images and screenshots by routing them to a vision-capable model.

When a user attaches an image to a text-only model, opencode rejects it with `this model does not support image input`. This plugin registers a `vision` tool that resolves the image and sends it to a vision model, returning a detailed textual description the primary model can reason about.

## How it works

```
user attaches screenshot
        |
        v
opencode rejects it: 'this model does not support image input'
        |
        v
injected system prompt tells the model to call `vision`
        |
        v
vision tool resolves the image:
  1. current session's attachments (via the opencode server API)
  2. opencode.db directly (SQLite, cross-session)
  3. filesystem search (~/Pictures/Screenshots, /tmp, ~/Downloads, cwd, ...)
        |
        v
spawns `opencode run -m opencode/mimo-v2.5-free -f <image>` (CLI fallback)
        |
        v
returns the textual description to the parent model
```

## Install

Place `vision.js` in your plugin directory:

- Global: `~/.config/opencode/plugins/vision.js`
- Project: `.opencode/plugins/vision.js`

Plugins in these directories load automatically at startup. Restart opencode.

## Usage

Nothing to do — the model calls `vision` automatically when you attach an image. The tool accepts:

- `filePath` — absolute path or bare filename (e.g. `Screenshot 2026-06-18 at 17.32.24.png`). Omit to use the most recent attached image.
- `question` — the user's specific question about the image; the vision model answers it directly (and still transcribes the image).

## Configuration

| env var | default | description |
| --- | --- | --- |
| `SEE_IMAGE_MODEL` | `opencode/mimo-v2.5-free` | Vision model ID used for the CLI call |
| `SEE_IMAGE_TIMEOUT` | `60000` | Timeout in ms per CLI call |

## Features

- Resolution ladder: session parts → SQLite DB → filesystem search, with fuzzy filename matching (NFKC-normalized, `U+202F` handled)
- Vision-capability detection — instructions are only injected for models that lack native image input
- Live spinner + elapsed-seconds in the TUI tool title while the vision call runs
- One retry per call, stderr captured in error messages, temp files cleaned up
- Linux-only (screenshot search dirs)

## License

MIT. Derived from [alfaoz/opencode-see-image](https://github.com/alfaoz/opencode-see-image) (MIT).
