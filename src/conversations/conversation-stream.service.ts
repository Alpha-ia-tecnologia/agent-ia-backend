import { Injectable } from '@nestjs/common';
import { Observable, ReplaySubject } from 'rxjs';
import type { BridgeEvent } from './bridge.service';

@Injectable()
export class ConversationStreamService {
  private readonly subjects = new Map<string, ReplaySubject<BridgeEvent>>();

  /**
   * Inicia um novo turno: descarta o buffer anterior para que um assinante
   * novo não receba eventos (ex.: final_message) da mensagem passada.
   */
  begin(conversationId: string) {
    this.subjects.set(conversationId, new ReplaySubject<BridgeEvent>(500));
  }

  private subject(conversationId: string): ReplaySubject<BridgeEvent> {
    let s = this.subjects.get(conversationId);
    if (!s) {
      // ReplaySubject: o EventSource do front conecta depois do POST; sem
      // replay, os primeiros eventos do bridge se perderiam na corrida.
      s = new ReplaySubject<BridgeEvent>(500);
      this.subjects.set(conversationId, s);
    }
    return s;
  }

  emit(conversationId: string, event: BridgeEvent) {
    this.subject(conversationId).next(event);
  }

  observe(conversationId: string): Observable<BridgeEvent> {
    return this.subject(conversationId).asObservable();
  }

  /**
   * Turno encerrado: libera o buffer depois de uma folga (um EventSource que
   * conecte atrasado ainda recebe o replay). Sem isto cada conversa guardava
   * até 500 eventos para sempre. Um turno novo no meio troca o subject, e a
   * checagem de identidade evita fechar o dele.
   */
  end(conversationId: string, graceMs = 60_000) {
    const s = this.subjects.get(conversationId);
    if (!s) return;
    setTimeout(() => {
      if (this.subjects.get(conversationId) !== s) return;
      this.subjects.delete(conversationId);
      s.complete();
    }, graceMs).unref();
  }
}
