// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：单帧规避连续帧解码截断；记录：.codex/doc/change-history/CHG-20261113-zstd-single-b8023110.md
// 变更追溯：标准独立Zstd帧兼容性；记录：.codex/doc/change-history/CHG-20261111-zstd-frames-b8023110.md
// 变更追溯：Codex无损HTTP压缩；记录：.codex/doc/change-history/CHG-20261103-transport-zstd-b8023110.md
// Adapted from Pi v1.5.0, Copyright (c) 2025 Mario Zechner (MIT).
// Source: earendil-works/pi f9a26365568127461c47a07a37dcb42c140a3ac5,
// packages/ai/src/api/openai-codex-responses.ts:204-236,391-398; notice: LICENSES/pi-MIT.txt.
import * as zlib from 'node:zlib'
import { withAbortSignal } from './common.js'
import type { RequestBodyStats } from '../call-audit.js'

export type CodexRequestCompression = 'none' | 'zstd'

/** 单帧避免连续帧解码截断；64KiB匹配窗口不限制总输入。 */
async function compressRequestBodyZstd(json: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted()
  const raw = Buffer.from(json, 'utf8')
  // 当前Node支持pledgedSrcSize；项目旧版Node类型尚未声明该字段。
  const options = { pledgedSrcSize: raw.length, params: {
    [zlib.constants.ZSTD_c_compressionLevel]: 1,
    [zlib.constants.ZSTD_c_windowLog]: 16,
    [zlib.constants.ZSTD_c_checksumFlag]: 1,
  } }
  const compressed = await new Promise<Buffer>((resolve, reject) => {
    zlib.zstdCompress(raw, options, (error, result) => { if (error) reject(error); else resolve(result) })
  })
  signal?.throwIfAborted()
  return new Uint8Array(compressed)
}

export async function codexHttpBody(
  json: string, mode: CodexRequestCompression = 'none', signal?: AbortSignal,
  compress: (json: string, signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>> = compressRequestBodyZstd,
): Promise<{ body: string | Uint8Array<ArrayBuffer>; stats: RequestBodyStats }> {
  signal?.throwIfAborted()
  const plainBytes = Buffer.byteLength(json, 'utf8')
  if (mode === 'none') return { body: json, stats: { plainBytes, wireBytes: plainBytes, encoding: 'identity', compressionMs: 0, result: 'disabled' } }
  const started = performance.now()
  try {
    const body = await withAbortSignal(() => compress(json, signal), signal)
    signal?.throwIfAborted()
    return { body, stats: { plainBytes, wireBytes: body.byteLength, encoding: 'zstd', compressionMs: performance.now() - started, result: 'compressed', codec: 'zstd-single64k-l1-v1', frames: 1 } }
  } catch {
    signal?.throwIfAborted()
    return { body: json, stats: { plainBytes, wireBytes: plainBytes, encoding: 'identity', compressionMs: performance.now() - started, result: 'fallback' } }
  }
}
