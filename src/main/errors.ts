import { AiConfigError, ModelUnavailableError, TransientError } from './ai'
import { ContextOverflowError, OllamaModelMissingError, OllamaOfflineError } from './ollama'

/** Converte erros técnicos (JSON do provedor, falhas de rede) numa mensagem curta e acionável. */
export function humanizeError(err: unknown): { message: string; config: boolean } {
  const e = err as Error
  const raw = e?.message ?? String(err)
  if (err instanceof AiConfigError) return { message: raw, config: true }
  if (err instanceof OllamaOfflineError || err instanceof OllamaModelMissingError) return { message: raw, config: true }
  if (err instanceof ContextOverflowError) {
    return { message: 'A pergunta ficou maior que a memória do modelo local. Aumente a memória em Configurações → Ollama ou use um modelo na nuvem.', config: true }
  }
  if (err instanceof ModelUnavailableError) {
    return { message: 'O modelo configurado não está mais disponível no provedor. Escolha outro em Configurações → Provedor de IA.', config: true }
  }
  if (err instanceof TransientError) {
    return { message: `${err.provider} está sobrecarregado agora. Tente de novo em alguns segundos.`, config: false }
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(raw)) {
    return { message: 'Sem conexão com o provedor de IA. Verifique a internet e tente de novo.', config: false }
  }
  // Remove o JSON cru do fim da mensagem, mantendo o essencial.
  const clean = raw.replace(/\s*[[{].*$/s, '').trim()
  return { message: clean || 'Algo deu errado ao gerar a resposta. Tente de novo.', config: false }
}
