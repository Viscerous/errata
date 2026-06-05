/**
 * Runs Piper neural TTS off the main thread. The ONNX model + phonemizer live
 * here and stay warm across chunks, so synthesis never freezes the UI and the
 * model isn't reloaded per sentence.
 *
 * Protocol: post { id, type:'synth', voiceId, text }; receive
 * { id, ok:true, buf:ArrayBuffer, mime } or { id, ok:false, error }.
 */
import * as piper from '@mintplex-labs/piper-tts-web'

// Piper's emscripten phonemizer probes a few web-only globals; provide harmless
// shims so it runs inside a module worker (no window/document there).
const g = globalThis as unknown as Record<string, unknown>
if (g.window === undefined) g.window = globalThis
if (g.document === undefined) g.document = {}

// Must match the pinned onnxruntime-web version in package.json.
const ONNX_WASM_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/'

interface WorkerCtx {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void
}
const ctx = self as unknown as WorkerCtx

let session: { predict(text: string): Promise<Blob> } | null = null
let currentVoiceId: string | null = null

async function getSession(voiceId: string) {
  if (session && currentVoiceId === voiceId) return session
  const base = (piper as { WASM_BASE?: string }).WASM_BASE
  const wasmPaths = base
    ? { onnxWasm: ONNX_WASM_BASE, piperWasm: `${base}.wasm`, piperData: `${base}.data` }
    : undefined
  session = await piper.TtsSession.create({ voiceId, ...(wasmPaths ? { wasmPaths } : {}) })
  currentVoiceId = voiceId
  return session
}

ctx.addEventListener('message', async (e: MessageEvent) => {
  const { id, type, voiceId, text } = e.data as { id: number; type: string; voiceId: string; text: string }
  if (type !== 'synth') return
  try {
    const s = await getSession(voiceId)
    const blob = await s.predict(text)
    const buf = await blob.arrayBuffer()
    ctx.postMessage({ id, ok: true, buf, mime: blob.type || 'audio/x-wav' }, [buf])
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
