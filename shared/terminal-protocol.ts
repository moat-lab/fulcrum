// Binary opcode-prefixed frames for the hot terminal I/O path.
//
// Modeled on ttyd (src/server.h). The non-hot path (terminal lifecycle, tabs,
// theme sync, errors, attach snapshot) keeps the existing JSON envelope, so a
// frame whose first byte is `{` is JSON; any other first byte is an opcode.
//
// Why binary at all when bun-pty hands us decoded strings? Two reasons:
//   1. Smaller wire format and no JSON escaping for the byte-heavy stream.
//   2. Sets up a clean entry point for fixing bun-pty's UTF-8 chunk-boundary
//      bug later (replace the producer without touching the protocol).

export const OPCODE_OUTPUT = 0x00 // server -> client: rest = PTY bytes (UTF-8)
export const OPCODE_INPUT = 0x01 // client -> server: rest = user input bytes
export const OPCODE_PAUSE = 0x02 // client -> server: pause output to this client
export const OPCODE_RESUME = 0x03 // client -> server: resume output to this client

// Opcode frames carry a terminal id so a single WebSocket can multiplex many
// terminals. Layout:
//   [0]       opcode (1 byte)
//   [1]       terminalId length N (1 byte, max 255 — uuid v4 is 36)
//   [2..2+N]  terminalId UTF-8 bytes
//   [2+N..]   payload (raw bytes for OUTPUT/INPUT; empty for PAUSE/RESUME)

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8')

export function encodeOpcodeFrame(opcode: number, terminalId: string, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
  const idBytes = textEncoder.encode(terminalId)
  if (idBytes.length > 255) {
    throw new Error(`terminalId exceeds 255 bytes: ${terminalId}`)
  }
  const payloadLen = payload?.length ?? 0
  const buffer = new ArrayBuffer(2 + idBytes.length + payloadLen)
  const frame = new Uint8Array(buffer)
  frame[0] = opcode
  frame[1] = idBytes.length
  frame.set(idBytes, 2)
  if (payload && payloadLen > 0) {
    frame.set(payload, 2 + idBytes.length)
  }
  return frame
}

export interface DecodedFrame {
  opcode: number
  terminalId: string
  payload: Uint8Array
}

export function decodeOpcodeFrame(buf: Uint8Array): DecodedFrame | null {
  if (buf.length < 2) return null
  const opcode = buf[0]
  const idLen = buf[1]
  if (buf.length < 2 + idLen) return null
  const terminalId = textDecoder.decode(buf.subarray(2, 2 + idLen))
  const payload = buf.subarray(2 + idLen)
  return { opcode, terminalId, payload }
}

export function decodePayloadAsString(payload: Uint8Array): string {
  return textDecoder.decode(payload)
}

export function encodeStringPayload(s: string): Uint8Array {
  return textEncoder.encode(s)
}

// Heuristic for branching on the receive side: JSON envelopes start with `{`
// (ASCII 0x7B). Our opcodes are 0x00..0x03, so the byte ranges don't collide.
export function isJsonFrameByte(firstByte: number): boolean {
  return firstByte === 0x7b // '{'
}
