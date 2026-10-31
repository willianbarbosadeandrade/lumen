import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, TranscriptLine } from '@shared/types'
import { toWav16k } from './wav'
import { ArchiveRecorder, micStream, SpeechChunker, stopStream, systemAudioStream, type ArchivePart, type Chunk } from './recorder'

export type RecStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'finalizing'

export interface ListeningState {
  status: RecStatus
  session: Session | null
  lines: TranscriptLine[]
  micLevel: number
  sysLevel: number
  systemAudio: 'off' | 'on' | 'failed'
  error?: string
  notice?: string
  /** Tempo gravado (não conta as pausas). */
  elapsed: number
  finalize?: { done: number; total: number }
  /** Sessão que acabou de ser salva (para os botões "Ver sessão" / "Resumo"). */
  savedSessionId?: string
}

const cleanIpcError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * Controla a gravação: Play (inicia/continua), Pause (solta o microfone) e Stop (encerra,
 * salva o áudio e refaz a transcrição completa com o modelo mais preciso).
 */
export function useListening(threshold: number, autoStopMinutes = 10) {
  const [state, setState] = useState<ListeningState>({
    status: 'idle',
    session: null,
    lines: [],
    micLevel: 0,
    sysLevel: 0,
    systemAudio: 'off',
    elapsed: 0
  })

  const sessionRef = useRef<Session | null>(null)
  const statusRef = useRef<RecStatus>('idle')
  const streams = useRef<MediaStream[]>([])
  const chunkers = useRef<SpeechChunker[]>([])
  const archives = useRef<ArchiveRecorder[]>([])
  const queue = useRef(Promise.resolve())
  const lastVoiceAt = useRef(0)
  const recordedMs = useRef(0) // tempo acumulado antes da pausa atual
  const runStartedAt = useRef(0)
  const runToken = useRef(0) // invalida inícios atrasados quando o usuário já parou

  const setStatus = (status: RecStatus, extra: Partial<ListeningState> = {}) => {
    statusRef.current = status
    setState((s) => ({ ...s, status, ...extra }))
  }

  useEffect(() => {
    const off = window.lumen.transcript.onLine(({ sessionId, line, removed }) => {
      if (sessionId !== sessionRef.current?.id) return
      setState((s) => ({
        ...s,
        lines: [...s.lines.filter((l) => !removed?.includes(l.id)), line].sort((a, b) => a.at - b.at)
      }))
    })
    return off
  }, [])

  useEffect(() => chunkers.current.forEach((c) => c.setThreshold(threshold)), [threshold])

  const onChunk = useCallback((c: Chunk) => {
    const session = sessionRef.current
    if (!session) return
    lastVoiceAt.current = Date.now()
    // Fila serial: mantém a ordem e evita rajadas de requisições.
    queue.current = queue.current.then(async () => {
      try {
        const audio = await c.blob.arrayBuffer()
        await window.lumen.transcript.send({ sessionId: session.id, speaker: c.speaker, audio, mime: c.mime, at: c.startedAt })
        setState((s) => (s.error ? { ...s, error: undefined } : s))
      } catch (e) {
        setState((s) => ({ ...s, error: cleanIpcError(e) }))
      }
    })
  }, [])

  const onArchive = useCallback(async (p: ArchivePart) => {
    const session = sessionRef.current
    if (!session) return
    // WAV 16 kHz para a transcrição final com identificação de quem fala (Gemini).
    const wav = await toWav16k(p.blob).catch(() => undefined)
    await window.lumen.sessions.saveAudio({
      sessionId: session.id,
      speaker: p.speaker,
      startedAt: p.startedAt,
      mime: p.mime,
      audio: await p.blob.arrayBuffer(),
      wav
    })
  }, [])

  /** Fecha tudo o que está capturando áudio. Sempre seguro de chamar. */
  const releaseCapture = useCallback(async () => {
    chunkers.current.forEach((c) => c.stop())
    chunkers.current = []
    const arch = archives.current
    archives.current = []
    // Para os gravadores antes de fechar os streams, para o último pedaço ser salvo inteiro.
    const saving = Promise.all(arch.map((a) => a.stop()))
    streams.current.forEach(stopStream)
    streams.current = []
    await saving
  }, [])

  /** Abre microfone (obrigatório) e áudio do sistema (opcional, em segundo plano). */
  const openCapture = useCallback(
    async (token: number) => {
      const mic = await micStream()
      if (token !== runToken.current) return stopStream(mic) // usuário já parou
      streams.current.push(mic)
      const micChunker = new SpeechChunker(mic, 'me', threshold, onChunk)
      micChunker.start()
      chunkers.current.push(micChunker)
      const micArchive = new ArchiveRecorder(mic, 'me', onArchive)
      micArchive.start()
      archives.current.push(micArchive)
      runStartedAt.current = Date.now()
      lastVoiceAt.current = Date.now()
      setStatus('recording', { systemAudio: 'off' })

      // O áudio do sistema entra depois, sem segurar o início da gravação.
      void systemAudioStream()
        .then((sys) => {
          if (token !== runToken.current || statusRef.current !== 'recording') return stopStream(sys)
          streams.current.push(sys)
          const sysChunker = new SpeechChunker(sys, 'them', threshold * 0.7, onChunk)
          sysChunker.start()
          chunkers.current.push(sysChunker)
          const sysArchive = new ArchiveRecorder(sys, 'them', onArchive)
          sysArchive.start()
          archives.current.push(sysArchive)
          setState((s) => ({ ...s, systemAudio: 'on' }))
        })
        .catch(() => {
          if (token === runToken.current) setState((s) => ({ ...s, systemAudio: 'failed' }))
        })
    },
    [threshold, onChunk, onArchive]
  )

  /** ▶ Play: começa uma gravação nova ou continua a pausada. */
  const play = useCallback(
    async (modeId: string) => {
      const st = statusRef.current
      if (st === 'starting' || st === 'recording' || st === 'finalizing') return
      const token = ++runToken.current
      setStatus('starting', { error: undefined, notice: undefined, savedSessionId: undefined })
      try {
        if (!sessionRef.current) {
          const session = await window.lumen.sessions.start(modeId)
          sessionRef.current = session
          recordedMs.current = 0
          setState((s) => ({ ...s, session, lines: [], elapsed: 0 }))
        }
        await openCapture(token)
      } catch (e) {
        await releaseCapture()
        const msg = cleanIpcError(e)
        const error = /microfone|NotAllowed|Permission/i.test(msg)
          ? 'Sem acesso ao microfone. Libere em Ajustes do Sistema → Privacidade e Segurança → Microfone.'
          : msg
        if (recordedMs.current === 0 && sessionRef.current) {
          // Nada foi gravado: descarta a sessão vazia.
          await window.lumen.sessions.stop(sessionRef.current.id, false).catch(() => {})
          sessionRef.current = null
          setStatus('idle', { session: null, error })
        } else {
          setStatus(sessionRef.current ? 'paused' : 'idle', { error })
        }
      }
    },
    [openCapture, releaseCapture]
  )

  /** ⏸ Pause: solta o microfone (o indicador do Mac apaga) e mantém a sessão aberta. */
  const pause = useCallback(async () => {
    if (statusRef.current !== 'recording' && statusRef.current !== 'starting') return
    runToken.current++
    if (runStartedAt.current) recordedMs.current += Date.now() - runStartedAt.current
    runStartedAt.current = 0
    setStatus('paused', { micLevel: 0, sysLevel: 0, systemAudio: 'off' })
    await releaseCapture()
  }, [releaseCapture])

  /** ⏹ Stop: encerra, salva e refaz a transcrição completa a partir do áudio gravado. */
  const stop = useCallback(
    async (reason?: string) => {
      const session = sessionRef.current
      if (!session || statusRef.current === 'finalizing') {
        // Mesmo sem sessão, garante que nada fica capturando.
        await releaseCapture()
        if (statusRef.current !== 'finalizing') setStatus('idle')
        return null
      }
      runToken.current++
      if (runStartedAt.current) recordedMs.current += Date.now() - runStartedAt.current
      runStartedAt.current = 0
      setStatus('finalizing', { micLevel: 0, sysLevel: 0, systemAudio: 'off', notice: reason, finalize: { done: 0, total: 0 } })
      await releaseCapture()
      await queue.current
      try {
        await window.lumen.sessions.stop(session.id, true)
      } catch (e) {
        setState((s) => ({ ...s, error: cleanIpcError(e) }))
      }
      sessionRef.current = null
      setStatus('idle', { session: null, finalize: undefined, savedSessionId: session.id })
      return session
    },
    [releaseCapture]
  )

  // Progresso da transcrição final.
  useEffect(
    () =>
      window.lumen.sessions.onFinalizeProgress((p) => {
        if (statusRef.current === 'finalizing') setState((s) => ({ ...s, finalize: p }))
      }),
    []
  )

  // Medidores, cronômetro e parada automática por silêncio.
  useEffect(() => {
    if (state.status !== 'recording') return
    const id = window.setInterval(() => {
      const [mic, sys] = chunkers.current
      setState((s) => ({
        ...s,
        micLevel: mic?.level ?? 0,
        sysLevel: sys?.level ?? 0,
        elapsed: recordedMs.current + (runStartedAt.current ? Date.now() - runStartedAt.current : 0)
      }))
      if (autoStopMinutes > 0 && Date.now() - lastVoiceAt.current > autoStopMinutes * 60_000) {
        void stop(`Gravação encerrada após ${autoStopMinutes} min sem fala.`)
      }
    }, 150)
    return () => clearInterval(id)
  }, [state.status, autoStopMinutes, stop])

  // Fecha a captura se a janela for recarregada ou fechada.
  useEffect(() => {
    const onUnload = () => streams.current.forEach(stopStream)
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  const dismiss = useCallback(() => setState((s) => ({ ...s, notice: undefined, error: undefined, savedSessionId: undefined })), [])

  return { state, play, pause, stop, dismiss }
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
