import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'

const MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

// Codex 输入条目转成 dsh 的提示词内容；文本合并为一段，图片按 base64 内联。
export async function promptContent(input: any[]): Promise<any[]> {
  if (!Array.isArray(input)) throw new ProtocolError(-32602, 'input 必须是数组')
  const parts: string[] = []
  const images: any[] = []
  for (const item of input) {
    if (item.type === 'text') parts.push(item.text)
    else if (item.type === 'skill') parts.push(`/${item.name}`)
    else if (item.type === 'mention') parts.push(item.path)
    else if (item.type === 'localImage') {
      const mediaType = MEDIA[extname(item.path).toLowerCase()]
      if (!mediaType) throw new ProtocolError(-32602, `不支持的图片类型: ${item.path}`)
      images.push({
        type: 'image',
        mediaType,
        data: (await readFile(item.path)).toString('base64'),
      })
    } else if (item.type === 'image') {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(item.url ?? '')
      if (!match) throw new ProtocolError(-32602, 'dsh 图片输入需要 data URL 或本地文件')
      images.push({ type: 'image', mediaType: match[1], data: match[2] })
    } else throw new ProtocolError(-32602, `不支持输入类型: ${item.type}`)
  }
  const text = parts.join('\n')
  if (!text.trim() && !images.length) throw new ProtocolError(-32602, '输入不能为空')
  return [...(text.trim() ? [{ type: 'text', text }] : []), ...images]
}
