// vision: give non-vision models the ability to see images.
// Derived from alfaoz/opencode-see-image (MIT). Simplified:
//   - single routing path: spawn `opencode run -m opencode/mimo-v2.5-free`
//   - no SDK session.prompt / no HTTP fallback / no auto-update
// Resolution ladder: opencode session parts (SDK) -> opencode.db (bun:sqlite)
// -> filesystem search dirs. Linux-only.
// Tool name: `vision`. The part title is set once via context.metadata; the
// main TUI timeline does not render tool-part titles (upstream #18585).

import { tool } from "@opencode-ai/plugin"
import path from "path"
import os from "os"
import fs from "fs"
import { spawn } from "node:child_process"

const MODEL = process.env.SEE_IMAGE_MODEL || "opencode/mimo-v2.5-free"
const TIMEOUT = parseInt(process.env.SEE_IMAGE_TIMEOUT || "60000", 10)

const EXT_MEDIA = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
}

// -- image resolution -------------------------------------------------

function opencodeDbPaths() {
  const dirs = []
  if (process.env.OPENCODE_DATA_DIR) dirs.push(process.env.OPENCODE_DATA_DIR)
  if (process.env.XDG_DATA_HOME)
    dirs.push(path.join(process.env.XDG_DATA_HOME, "opencode"))
  dirs.push(path.join(os.homedir(), ".local/share/opencode"))
  return dirs
}

function opencodeDbPath() {
  const dirs = opencodeDbPaths()
  for (const dir of dirs) {
    const p = path.join(dir, "opencode.db")
    if (fs.existsSync(p)) return p
  }
  return path.join(dirs[dirs.length - 1], "opencode.db")
}

async function openDb(dbPath) {
  if (typeof Bun !== "undefined") {
    try {
      const { Database } = await import("bun:sqlite")
      const db = new Database(dbPath, { readonly: true })
      return {
        all: (sql, params) => db.query(sql).all(...params),
        close: () => db.close(),
      }
    } catch {}
  }
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(dbPath, { readOnly: true })
    return {
      all: (sql, params) => db.prepare(sql).all(...params),
      close: () => db.close(),
    }
  } catch {}
  return null
}

function isImagePart(p) {
  return (
    p &&
    p.type === "file" &&
    typeof p.url === "string" &&
    p.url.startsWith("data:") &&
    typeof p.mime === "string" &&
    p.mime.startsWith("image/")
  )
}

// macOS screenshot names contain a narrow no-break space (U+202F) that the
// model retypes as a normal space; names may be passed as full paths etc.
function normalizeName(name) {
  return path
    .basename(String(name).trim())
    .normalize("NFKC")
    .replace(/[\u202f\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

function wantsLatest(name) {
  return !name || name === "clipboard" || name === "latest"
}

function pickImage(parts, name) {
  if (wantsLatest(name)) return parts.length ? parts[parts.length - 1] : null
  const want = normalizeName(name)
  for (let i = parts.length - 1; i >= 0; i--) {
    const have = parts[i].filename
    if (have && normalizeName(have) === want) return parts[i]
  }
  return null
}

async function sessionImagePartsViaSDK(client, sessionID) {
  try {
    const res = await client.session.messages({ path: { id: sessionID } })
    const parts = []
    for (const message of res?.data ?? []) {
      for (const part of message?.parts ?? []) {
        if (isImagePart(part)) parts.push(part)
      }
    }
    return parts
  } catch {
    return []
  }
}

async function imagePartsViaDb(sessionID, limit = 400) {
  const dbPath = opencodeDbPath()
  if (!fs.existsSync(dbPath)) return []
  const db = await openDb(dbPath)
  if (!db) return []
  try {
    const sessionClause = sessionID ? "session_id = ? AND" : ""
    const rows = db.all(
      `SELECT data FROM part
       WHERE ${sessionClause}
         json_extract(data, '$.type') = 'file'
         AND json_extract(data, '$.url') LIKE 'data:image/%'
       ORDER BY time_created DESC LIMIT ?`,
      sessionID ? [sessionID, limit] : [limit],
    )
    const parts = []
    for (const row of rows) {
      try {
        const part = JSON.parse(row.data)
        if (isImagePart(part)) parts.push(part)
      } catch {}
    }
    return parts.reverse()
  } catch {
    return []
  } finally {
    db.close()
  }
}

function screenshotSearchDirs(cwd) {
  const home = os.homedir()
  const dirs = []
  if (process.env.TMPDIR) dirs.push(process.env.TMPDIR)
  dirs.push("/tmp")
  dirs.push(path.join(home, "Pictures", "Screenshots"))
  dirs.push(path.join(home, "Pictures"))
  dirs.push(path.join(home, "Desktop"))
  dirs.push(path.join(home, "Downloads"))
  dirs.push(cwd)
  return dirs
}

function resolveFromFilesystem(name, cwd) {
  let absPath = null
  if (name.startsWith("~")) name = path.join(os.homedir(), name.slice(1))
  if (path.isAbsolute(name) && fs.existsSync(name)) absPath = name
  else {
    const resolved = path.resolve(cwd, name)
    if (fs.existsSync(resolved)) absPath = resolved
  }
  if (!absPath) {
    for (const dir of screenshotSearchDirs(cwd)) {
      if (!dir) continue
      try {
        const full = path.join(dir, name)
        if (fs.existsSync(full)) {
          absPath = full
          break
        }
      } catch {}
    }
  }
  if (!absPath || !fs.existsSync(absPath)) return null
  const ext = path.extname(absPath).slice(1).toLowerCase()
  const mediaType = EXT_MEDIA[ext] || "image/png"
  const b64 = Buffer.from(fs.readFileSync(absPath)).toString("base64")
  return {
    dataUrl: `data:${mediaType};base64,${b64}`,
    mediaType,
    source: absPath,
  }
}

async function resolveImage(name, cwd, sessionID, client) {
  const latestOnly = wantsLatest(name)

  let sessionParts = []
  if (client && sessionID) {
    sessionParts = await sessionImagePartsViaSDK(client, sessionID)
    const hit = pickImage(sessionParts, name)
    if (hit) return { dataUrl: hit.url, mediaType: hit.mime, source: "session" }
  }

  const dbParts = await imagePartsViaDb(sessionID)
  const hit = pickImage(dbParts, name)
  if (hit) return { dataUrl: hit.url, mediaType: hit.mime, source: "db" }

  if (!latestOnly && sessionID) {
    const hit = pickImage(await imagePartsViaDb(undefined), name)
    if (hit) return { dataUrl: hit.url, mediaType: hit.mime, source: "db" }
  }

  if (!latestOnly) {
    const fromFs = resolveFromFilesystem(name, cwd)
    if (fromFs) return fromFs
  }

  const known = [
    ...new Set([...sessionParts, ...dbParts].map((p) => p.filename).filter(Boolean)),
  ].slice(-5)
  throw new Error(
    `vision: could not find "${name || "any attached image"}". ` +
      (known.length
        ? `Images attached to this session: ${known.map((f) => `"${f}"`).join(", ")}. Call vision again with one of those filenames.`
        : `No images found in this conversation. Ask the user to re-attach the image or provide an absolute file path.`),
  )
}

// ─ vision call ---------------------------------------------------------

function seeImageViaCli(dataUrl, mediaType, prompt, abort) {
  return new Promise((resolve, reject) => {
    const b64 = dataUrl.split(",")[1] || ""
    const ext =
      Object.entries(EXT_MEDIA).find(([, m]) => m === mediaType)?.[0] || "png"
    const tmpPath = path.join(os.tmpdir(), `vision-${Date.now()}.${ext}`)
    fs.writeFileSync(tmpPath, Buffer.from(b64, "base64"))

    const proc = spawn(
      "opencode",
      [
        "run",
        "-f",
        tmpPath,
        "-m",
        MODEL,
        prompt,
        "--format",
        "json",
        "--dangerously-skip-permissions",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SEE_IMAGE_CHILD: "1" },
      },
    )

    let out = ""
    let err = ""
    const timer = setTimeout(() => proc.kill(), TIMEOUT)
    const onAbort = () => proc.kill()
    if (abort) abort.addEventListener("abort", onAbort)

    const finish = () => {
      clearTimeout(timer)
      if (abort) abort.removeEventListener("abort", onAbort)
      try {
        fs.unlinkSync(tmpPath)
      } catch {}
    }

    proc.stdout.on("data", (c) => (out += c))
    proc.stderr.on("data", (c) => (err += c))
    proc.on("error", (e) => {
      finish()
      reject(new Error(`vision: failed to spawn opencode CLI: ${e.message}`))
    })
    proc.on("close", (code) => {
      finish()
      for (const line of out.split("\n")) {
        try {
          const parsed = JSON.parse(line)
          const part = parsed?.part
          if (part?.type === "text" && typeof part.text === "string" && part.text) {
            resolve(part.text.trim())
            return
          }
          if (parsed?.type === "text" && typeof parsed.text === "string" && parsed.text) {
            resolve(parsed.text.trim())
            return
          }
        } catch {}
      }
      reject(
        new Error(
          `vision: CLI returned no text (exit ${code}). stderr: ${err.slice(0, 500)} output: ${out.slice(0, 200)}`,
        ),
      )
    })
  })
}

// ─ model capability detection ---------------------------------------

function modelSupportsVision(model) {
  if (!model) return false
  if (model.capabilities?.input && typeof model.capabilities.input.image === "boolean")
    return model.capabilities.input.image
  if (Array.isArray(model.modalities?.input))
    return model.modalities.input.includes("image")
  if (typeof model.capabilities?.attachment === "boolean")
    return model.capabilities.attachment
  if (typeof model.attachment === "boolean") return model.attachment
  return false
}

// ─ injected instructions for non-vision models -----------------------

const SYSTEM_INSTRUCTIONS = `# Vision bridge

You have a \`vision\` tool. This model cannot view images directly. When the user attaches an image, you may receive an error containing the **filename**, a placeholder like \`[Image #1]\`, or nothing at all. You MUST call \`vision\` to view it — do NOT tell the user you can't see images.

## Call \`vision\` immediately (no confirmation) when:
1. You get an error containing \`Cannot read "...png"\` / \`Cannot read "...jpg"\`.
2. The error says \`this model does not support image input\`.
3. The message contains an image placeholder like \`[Image #1]\`.
4. The user references an image/screenshot ("see this", "look at this", ".png", ".jpg").
5. The user pastes an image path.

## How to use it
- If you know the filename (from the error or user), pass it as \`filePath\` (a bare filename is fine).
- If you do NOT know the filename, call \`vision\` with no \`filePath\` — it uses the most recent image attached to the conversation.
- If the user asked something specific about the image, pass their question verbatim as \`question\` — the vision model then answers it directly (and still transcribes the image). You can also ask your own follow-up question about the image the same way.
- Answer using the returned description as if you saw the image yourself.

## Important
- NEVER just repeat the error to the user — call the tool.
- If \`vision\` fails, its error lists the images attached to this session. Retry with one of those exact filenames.
- Do NOT use it for text files (.ts, .md, .json) — use \`read\`.
- Never guess image contents. If you haven't called \`vision\`, you haven't seen the image.`

const DEFAULT_PROMPT = `Identify this image first, then describe it thoroughly. Work through these four sections.

1. IDENTIFY
- What kind of image is this? (app/site screenshot, terminal, IDE, code, chat/DM, social feed, diagram, chart, photo, document, error screen, PDF page, ...)
- If a screenshot: which website or app is it (e.g. GitHub repo page, X/Twitter, YouTube, Reddit, dashboard)? Light or dark theme? What is the page's main purpose?

2. EXTRACT EVERYTHING (for screenshots)
- Transcribe ALL visible text verbatim, preserving line breaks, code indentation, and special characters (icons, arrows, unicode).
- List each UI component (buttons, inputs, tabs, cards, tables, menus, toasts) with approximate positions.
- Note verbatim: URLs, usernames, timestamps, titles, prices, counts, statuses, error messages.

3. ANALYZE
- If this is a UI review: alignment, spacing, typography, clipping/overlaps, color contrast; report issues as: Issue / Location / Severity (Low|Medium|High|Critical) / Fix.
- If it is a document/code/chart: summarize structure, key values, and main takeaway.
- If no specific question, end with a 1-2 sentence summary of what the image is about.

4. HONESTY
- Never invent text or elements that are not visible. If resolution is low or something is cut off, say exactly that.

This description is consumed verbatim by a non-vision model that must answer the user, so be structured, complete, and accurate.`

function buildPrompt(question) {
  if (!question || !question.trim()) return DEFAULT_PROMPT
  const q = question.trim()
  const spatial = /layout|position|where|align|spacing|overlap|ui|screen|design|diagram|look/i.test(q)
  return `${DEFAULT_PROMPT}

NEXT, THE PARENT AWAITS YOUR ANSWER — answer the user's own question directly and precisely, citing evidence visible in the image:
>>> ${q}
${spatial ? "\nSpatial layout matters here: include a labeled ASCII diagram of the arrangement of the elements discussed." : ""}`
}

// ─ plugin -------------------------------------------------------------

const SeeImagePlugin = async (ctx) => {
  const sessionVision = new Map()
  const rememberVision = (sessionID, model) => {
    if (!sessionID) return
    if (sessionVision.size > 500) sessionVision.clear()
    sessionVision.set(sessionID, modelSupportsVision(model))
  }

  const visionTool = tool({
    description:
      "See an image/screenshot that the current model cannot view. Use when the user attaches an image and you get a \"this model does not support image input\" / \"Cannot read\" error, when the message contains an image placeholder like [Image #1], or when a screenshot/image is referenced (\"see this\", \"can you see\", .png/.jpg). Routes the image to a vision-capable model and returns a detailed textual description you can reason about as if you saw it. Pass filePath as an absolute path or bare filename, or omit it to use the most recently attached image. Do NOT call this if you can already view images natively.",
    args: {
      filePath: tool.schema
        .string()
        .optional()
        .describe(
          'Path to the image. Absolute path, or a bare filename like "Screenshot 2026-06-18 at 17.32.24.png" to auto-locate. Omit entirely (or pass "latest") to use the most recent image attached to this conversation.',
        ),
      question: tool.schema
        .string()
        .optional()
        .describe(
          "The parent agent's question about the image — pass the user's question verbatim (or your own follow-up). The vision model answers it directly, citing visible evidence, in addition to identifying and transcribing the image. Omit only for a plain full description.",
        ),
    },
    async execute(args, context) {
      let resolved
      try {
        resolved = await resolveImage(
          args.filePath || "",
          context.directory,
          context.sessionID,
          ctx.client,
        )
      } catch (e) {
        if (sessionVision.get(context.sessionID)) {
          context.metadata({
            title: "vision: skipped (model has native vision)",
            metadata: { skipped: true, reason: "native image input" },
          })
          return (
            "No bridge needed: the current model supports image input natively, " +
            "so the image was already delivered directly. Answer from what you see — do not call vision again."
          )
        }
        throw e
      }

      try {
        const prompt = buildPrompt(args.question)
        try {
          return await seeImageViaCli(
            resolved.dataUrl,
            resolved.mediaType,
            prompt,
            context.abort,
          )
        } catch (e) {
          if (context.abort?.aborted) throw e
          return await seeImageViaCli(
            resolved.dataUrl,
            resolved.mediaType,
            prompt,
            context.abort,
          )
        }
      } finally {
        context.metadata({
          title: `vision: ${args.filePath || "latest image"}`,
          metadata: { model: MODEL, source: resolved.source },
        })
      }
    },
  })

  return {
    tool: { vision: visionTool },
    "chat.params": async (input) => {
      rememberVision(input.sessionID, input.model)
    },
    "experimental.chat.system.transform": async (input, output) => {
      rememberVision(input.sessionID, input.model)
      if (process.env.SEE_IMAGE_CHILD) return
      if (modelSupportsVision(input.model)) return
      output.system.push(SYSTEM_INSTRUCTIONS)
    },
  }
}

export default SeeImagePlugin