import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrismLight as Highlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import ts from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import js from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import py from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'

const langs = { ts, typescript: ts, js, javascript: js, py, python: py, java, cpp, c: cpp, go, sql, bash, sh: bash, shell: bash, json, tsx, jsx: tsx, swift, rust }
for (const [name, def] of Object.entries(langs)) Highlighter.registerLanguage(name, def)

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="code">
      <div className="code-head">
        <span>{lang || 'código'}</span>
        <button
          className="ghost xs"
          onClick={() => {
            void window.lumen.clipboard.write(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <Highlighter
        language={lang in langs ? lang : 'text'}
        style={oneDark}
        customStyle={{ margin: 0, background: 'transparent', padding: '10px 12px', fontSize: 12.5 }}
        codeTagProps={{ style: { background: 'transparent', fontFamily: 'var(--mono)' } }}
        wrapLongLines
      >
        {code}
      </Highlighter>
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className ?? '')
            const content = String(children).replace(/\n$/, '')
            if (!match && !content.includes('\n')) return <code className="inline">{children}</code>
            return <CodeBlock lang={match?.[1]?.toLowerCase() ?? ''} code={content} />
          },
          pre: ({ children }) => <>{children}</>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
