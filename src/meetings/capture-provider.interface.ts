/** Transcrição normalizada, pronta para virar prompt do agente. */
export interface CapturedTranscript {
  /** Diálogo em texto limpo, formato "Falante: fala". */
  text: string;
  subject: string;
  startedAt?: Date;
}

/**
 * Fonte da transcrição de uma reunião. Isola de onde vem o conteúdo do pipeline
 * de processamento. Hoje há só o `BotCaptureProvider` (aao-scribe grava o áudio
 * e transcreve). A abstração permanece para permitir outras fontes no futuro
 * (ex.: STT self-host) sem refatorar o processamento.
 */
export interface CaptureProvider {
  fetchTranscript(meetingSessionId: string): Promise<CapturedTranscript>;
}

/** Token de injeção do provedor de captura ativo. */
export const CAPTURE_PROVIDER = Symbol('CAPTURE_PROVIDER');
