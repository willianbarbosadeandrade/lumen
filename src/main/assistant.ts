import { randomUUID } from 'node:crypto'
import { speakerName, type AskRequest, type ChatMessage, type SelectionAction, type Session } from '@shared/types'
import { ContextOverflowError, promptBudget, streamCompletion, type LlmImage, type LlmTurn, type PromptBudget } from './ai'
import { getMode, getSession, getSettings, updateSession } from './store'

const SELECTION_PROMPTS: Record<SelectionAction, string> = {
  explain: 'Explique o texto abaixo de forma clara e curta. Se for código, explique o que ele faz e aponte problemas.',
  summarize: 'Resuma o texto abaixo em tópicos curtos, preservando números e decisões.',
  rewrite: 'Reescreva o texto abaixo para ficar mais claro e profissional, mantendo o tom e o idioma originais. Responda apenas com o texto reescrito.',
  fix: 'Corrija ortografia, gramática e pontuação do texto abaixo sem mudar o sentido nem o idioma. Responda apenas com o texto corrigido.',
  translate: 'Traduza o texto abaixo. Se estiver em português, traduza para inglês; caso contrário, para português do Brasil. Responda apenas com a tradução.',
  reply: 'O texto abaixo é uma mensagem que o usuário recebeu. Escreva uma resposta curta, cordial e objetiva que ele possa enviar. Responda apenas com a mensagem.',
  custom: ''
}

/** Ações cujo resultado pode substituir a seleção original no outro app. */
export const REPLACEABLE: SelectionAction[] = ['rewrite', 'fix', 'translate', 'reply']

const hhmm = (t: number) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

/** Linhas da transcrição no formato "[21:07] Pessoa 1: …" (o horário ajuda a IA a situar cada assunto). */
function transcriptLines(s: Session): string[] {
  const names = s.speakerNames ?? {}
  return s.transcript.map((l) => `[${hhmm(l.at)}] ${l.label ? speakerName(l, names) : l.speaker === 'me' ? 'Eu' : 'Outros'}: ${l.text}`)
}

/** Divide a transcrição em blocos de até `maxChars`, sem quebrar falas no meio. */
export function splitTranscript(lines: string[], maxChars: number): string[] {
  const blocks: string[] = []
  let cur = ''
  for (const line of lines) {
    const l = line.length > maxChars ? line.slice(0, maxChars) : line
    if (cur && cur.length + l.length + 1 > maxChars) {
      blocks.push(cur)
      cur = ''
    }
    cur += (cur ? '\n' : '') + l
  }
  if (cur) blocks.push(cur)
  return blocks
}

function transcriptText(s: Session | undefined, maxChars = 12_000): string {
  if (!s || !s.transcript.length) return ''
  const lines = transcriptLines(s)
  let out = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length + lines[i].length > maxChars) {
      out = '…\n' + out
      break
    }
    out = lines[i] + '\n' + out
  }
  return out.trim()
}

const SUMMARY_TASK =
  '# Tarefa\nGere um resumo da reunião INTEIRA (do começo ao fim, não só o final) com: **Resumo** (4–6 frases), ' +
  '**Assuntos tratados** (em ordem, com o horário aproximado), **Decisões**, **Próximos passos** (com responsáveis quando citados) e **Pontos em aberto**.\n' +
  'Regras importantes: use SOMENTE o que está no material; não invente fatos, nomes, decisões nem próximos passos. ' +
  'Se uma seção não tiver nada explícito, escreva "Nada mencionado". Preserve números, nomes de equipamentos, sistemas e termos técnicos. ' +
  'A transcrição automática pode ter palavras erradas: quando um trecho não fizer sentido, não tente adivinhar — ignore-o ou diga que ficou confuso. ' +
  'Use os nomes de quem fala exatamente como aparecem.'

const NOTES_TASK =
  '# Tarefa\nEste é um trecho de uma reunião mais longa. Anote, em tópicos curtos e fiéis ao texto, tudo o que importa neste trecho: ' +
  'assuntos (com horário), fatos, números, nomes de sistemas e equipamentos, problemas relatados, decisões, tarefas e quem ficou responsável, perguntas sem resposta. ' +
  'Não invente nada; ignore trechos sem sentido. Responda só com os tópicos.'

/**
 * Resumo de reuniões longas: se a transcrição inteira não cabe no modelo, resume em etapas —
 * anota cada bloco e depois junta as anotações no resumo final. Assim nada do começo se perde.
 */
async function summarizeWhole(session: Session, budget: PromptBudget, h: RunHandlers): Promise<string> {
  const lines = transcriptLines(session)
  const system = buildSystem(session.modeId, 0)
  const full = lines.join('\n')
  if (full.length <= budget.fullTranscriptChars) {
    return streamCompletion({
      system,
      turns: [{ role: 'user', text: `# Transcrição completa\n${full}\n\n${SUMMARY_TASK}` }],
      signal: h.signal,
      maxTokens: 2000,
      onText: h.onText,
      onFallback: h.onFallback
    })
  }
  const blocks = splitTranscript(lines, budget.fullTranscriptChars)
  h.onNotice?.(`Reunião longa: resumindo em ${blocks.length} partes para não perder nada.`)
  const notes: string[] = []
  for (const [i, block] of blocks.entries()) {
    const note = await streamCompletion({
      system,
      turns: [{ role: 'user', text: `# Trecho ${i + 1} de ${blocks.length}\n${block}\n\n${NOTES_TASK}` }],
      signal: h.signal,
      maxTokens: 900,
      onText: () => {}
    })
    notes.push(`## Trecho ${i + 1} de ${blocks.length}\n${note.trim()}`)
  }
  // Se nem as anotações couberem juntas, corta cada uma proporcionalmente.
  const per = Math.floor(budget.fullTranscriptChars / notes.length)
  const material = notes.map((n) => clip(n, per)).join('\n\n')
  return streamCompletion({
    system,
    turns: [{ role: 'user', text: `# Anotações de cada trecho da reunião, em ordem\n${material}\n\n${SUMMARY_TASK}` }],
    signal: h.signal,
    maxTokens: 2000,
    onText: h.onText,
    onFallback: h.onFallback
  })
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '\n…[cortado]' : text)

function buildSystem(modeId: string, docsChars: number): string {
  const s = getSettings()
  const mode = getMode(modeId)
  // Divide o espaço disponível entre os documentos do modo.
  const perDoc = mode.docs.length ? Math.floor(docsChars / mode.docs.length) : 0
  const docs = mode.docs.length && perDoc > 200
    ? '\n\n# Documentos de referência\n' + mode.docs.map((d) => `## ${d.name}\n${clip(d.text, perDoc)}`).join('\n\n')
    : ''
  return [
    `Você é o Lumen, um copiloto de IA que roda no Mac do usuário. Modo atual: ${mode.name}.`,
    mode.prompt,
    `Responda em ${s.answerLanguage}, a menos que o usuário peça outro idioma.`,
    'Formate em Markdown. O usuário lê numa janela pequena: vá direto ao ponto.',
    'Se receber uma captura de tela, use-a como contexto, mas não descreva a tela inteira sem necessidade.',
    'Na transcrição, "Eu"/"Você" é o usuário; "Outros", "Participante N" ou "Pessoa N" são as demais pessoas (o usuário pode ter renomeado). A transcrição automática pode conter erros: nunca invente o que não está escrito.'
  ].join('\n') + docs
}

function buildUserTurn(req: AskRequest, session: Session | undefined, transcriptChars: number): string {
  const transcript = transcriptText(session, transcriptChars)
  const whole = !transcript.startsWith('…') // não foi cortada
  const ctx = transcript ? `# ${whole && session?.endedAt ? 'Transcrição completa' : 'Transcrição recente'}\n${transcript}\n\n` : ''
  switch (req.kind) {
    case 'suggest':
      return (
        ctx +
        '# Tarefa\nCom base no que acabou de ser dito (e na tela, se houver), sugira o que eu devo falar agora. ' +
        'Dê uma resposta pronta para falar em voz alta, em até 4 frases, e depois 1–3 tópicos de apoio.'
      )
    case 'summary':
      return ctx + SUMMARY_TASK
    case 'selection': {
      const sel = req.selection!
      const instruction = sel.action === 'custom' ? req.prompt ?? '' : SELECTION_PROMPTS[sel.action]
      return `${instruction}\n\n"""\n${sel.text}\n"""`
    }
    default: {
      const q = req.prompt?.trim()
      if (q) return ctx + `# Pergunta\n${q}`
      return (
        ctx +
        '# Tarefa\nOlhe a tela e ajude com o que for mais útil agora: se houver uma pergunta, problema ou exercício visível, resolva; senão, resuma o que importa.'
      )
    }
  }
}

export interface RunHandlers {
  onText: (delta: string) => void
  signal: AbortSignal
  screen?: LlmImage
  onFallback?: (from: string, to: string) => void
  onNotice?: (message: string) => void
}

export async function runAsk(req: AskRequest, h: RunHandlers): Promise<{ full: string; messageId?: string }> {
  const settings = getSettings()
  const session = req.sessionId ? getSession(req.sessionId) : undefined
  const modeId = session?.modeId ?? settings.activeModeId

  const attempt = (budget: PromptBudget, screen?: LlmImage) => {
    // Mantém as últimas trocas da sessão como histórico (só para perguntas e continuações).
    const history: LlmTurn[] =
      session && (req.kind === 'ask' || req.kind === 'followup')
        ? session.messages.slice(-budget.historyTurns).map((m) => ({ role: m.role, text: clip(m.content, budget.historyChars) }))
        : []
    // Depois que a reunião acabou, perguntas sobre ela usam a transcrição inteira (quando cabe).
    const chars = session?.endedAt && (req.kind === 'ask' || req.kind === 'followup') ? budget.fullTranscriptChars : budget.transcriptChars
    const userText = buildUserTurn(req, session, chars)
    const turns: LlmTurn[] = [...history, { role: 'user', text: userText, images: screen ? [screen] : undefined }]
    return streamCompletion({
      system: buildSystem(modeId, budget.docsChars),
      turns,
      signal: h.signal,
      maxTokens: req.kind === 'summary' ? 1500 : 2048,
      onText: h.onText,
      onFallback: h.onFallback
    })
  }

  const budget = promptBudget(undefined, !!h.screen)
  let full: string
  try {
    full = req.kind === 'summary' && session ? await summarizeWhole(session, budget, h) : await attempt(budget, h.screen)
  } catch (err) {
    if (!(err instanceof ContextOverflowError)) throw err
    // Ainda não coube (documentos grandes, imagem pesada): tenta com metade do contexto e sem a imagem.
    h.onNotice?.('A pergunta não coube na memória do modelo local; respondi com um contexto menor e sem a tela. Dá para aumentar a memória em Configurações → Ollama.')
    const half = {
      ...budget,
      transcriptChars: Math.floor(budget.transcriptChars / 3),
      docsChars: Math.floor(budget.docsChars / 3),
      historyTurns: 0
    }
    full =
      req.kind === 'summary' && session
        ? await summarizeWhole(session, { ...half, fullTranscriptChars: Math.floor(budget.fullTranscriptChars / 2) }, h)
        : await attempt(half)
  }

  if (!session || req.kind === 'selection') return { full }

  const now = Date.now()
  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    kind: req.kind,
    content:
      req.kind === 'suggest'
        ? 'O que eu digo agora?'
        : req.kind === 'summary'
          ? 'Resumo da sessão'
          : req.prompt?.trim() || 'Ajude com o que está na tela',
    at: now,
    withScreen: !!h.screen
  }
  const aiMsg: ChatMessage = { id: randomUUID(), role: 'assistant', kind: req.kind, content: full, at: Date.now() }
  updateSession(session.id, (s) => {
    s.messages.push(userMsg, aiMsg)
    if (req.kind === 'summary') s.summary = full
  })
  return { full, messageId: aiMsg.id }
}

/** Gera um título curto para a sessão a partir da transcrição. Falhas são silenciosas. */
export async function autoTitle(sessionId: string): Promise<void> {
  const s = getSession(sessionId)
  // Só troca o título automático ("Sessão de …"); nunca um nome dado pelo usuário.
  if (!s || s.transcript.length < 4 || !/^Sessão de /.test(s.title)) return
  try {
    const title = await streamCompletion({
      system: 'Gere um título de 3 a 6 palavras, sem aspas e sem ponto final, para a conversa a seguir.',
      turns: [{ role: 'user', text: transcriptText(s, Math.min(4000, promptBudget().transcriptChars)) }],
      maxTokens: 30,
      signal: AbortSignal.timeout(15_000),
      onText: () => {}
    })
    const clean = title.trim().replace(/^["'#\s]+|["'.\s]+$/g, '').slice(0, 80)
    if (clean) updateSession(sessionId, (x) => (x.title = clean))
  } catch {
    /* o título padrão continua */
  }
}

export function sessionToMarkdown(s: Session): string {
  const mode = getMode(s.modeId)
  const date = new Date(s.startedAt).toLocaleString('pt-BR')
  const parts = [`# ${s.title}`, `_${date} · ${mode.name}_`]
  if (s.summary) parts.push('## Resumo', s.summary)
  if (s.messages.length) {
    parts.push('## Respostas do Lumen')
    for (const m of s.messages) parts.push(m.role === 'user' ? `**Você:** ${m.content}` : m.content)
  }
  if (s.transcript.length) {
    parts.push('## Transcrição')
    parts.push(
      s.transcript
        .map((l) => `- **${speakerName(l, s.speakerNames)}** (${new Date(l.at).toLocaleTimeString('pt-BR')}): ${l.text}`)
        .join('\n')
    )
  }
  return parts.join('\n\n') + '\n'
}
