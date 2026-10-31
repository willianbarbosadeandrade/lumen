import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ContextDoc } from '@shared/types'

const MAX_CHARS = 60_000

async function pdfToText(data: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))
  }
  await doc.destroy()
  return pages.join('\n\n')
}

export async function loadDoc(path: string): Promise<ContextDoc> {
  const ext = extname(path).toLowerCase()
  const buf = await readFile(path)
  let text: string
  if (ext === '.pdf') text = await pdfToText(new Uint8Array(buf))
  else text = buf.toString('utf8')
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const truncated = text.length > MAX_CHARS
  if (truncated) text = text.slice(0, MAX_CHARS) + '\n…[documento truncado]'
  return { id: randomUUID(), name: basename(path), chars: text.length, text }
}
