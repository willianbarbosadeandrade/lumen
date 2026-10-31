import { useCallback, useEffect, useRef, useState } from 'react'
import type { AskRequest } from '@shared/types'

export interface AskState {
  requestId: string | null
  text: string
  status: 'idle' | 'thinking' | 'streaming' | 'done' | 'error'
  error?: string
  configError?: boolean
  label?: string
  notice?: string
}

const IDLE: AskState = { requestId: null, text: '', status: 'idle' }

/** Faz uma pergunta à IA e acompanha o streaming da resposta. */
export function useAsk() {
  const [state, setState] = useState<AskState>(IDLE)
  const current = useRef<string | null>(null)

  useEffect(() => {
    const offs = [
      window.lumen.ai.onChunk(({ requestId, text }) => {
        if (requestId !== current.current) return
        setState((s) => ({ ...s, status: 'streaming', text: s.text + text }))
      }),
      window.lumen.ai.onDone(({ requestId, full }) => {
        if (requestId !== current.current) return
        setState((s) => ({ ...s, status: 'done', text: full }))
      }),
      window.lumen.ai.onNotice(({ requestId, message }) => {
        if (requestId !== current.current) return
        setState((s) => ({ ...s, notice: message }))
      }),
      window.lumen.ai.onError(({ requestId, message, config }) => {
        if (requestId !== current.current) return
        setState((s) => ({ ...s, status: 'error', error: message, configError: config }))
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const ask = useCallback((req: Omit<AskRequest, 'requestId'>, label?: string) => {
    if (current.current) window.lumen.ai.cancel(current.current)
    const requestId = crypto.randomUUID()
    current.current = requestId
    setState({ requestId, text: '', status: 'thinking', label })
    void window.lumen.ai.ask({ ...req, requestId })
    return requestId
  }, [])

  const cancel = useCallback(() => {
    if (current.current) window.lumen.ai.cancel(current.current)
  }, [])

  const reset = useCallback(() => {
    if (current.current) window.lumen.ai.cancel(current.current)
    current.current = null
    setState(IDLE)
  }, [])

  return { state, ask, cancel, reset }
}
