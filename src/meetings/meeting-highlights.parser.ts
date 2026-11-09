/** Um ponto importante da reunião, ancorado num instante da gravação. */
export interface MeetingHighlight {
  kind: 'decision' | 'action' | 'topic';
  /** Segundos desde o início da reunião (clicável no player). */
  ts: number;
  text: string;
  speaker?: string;
}

/**
 * Parse tolerante da resposta do modelo em highlights normalizados. Aceita JSON
 * puro, cercado por ```json ou embutido em prosa. Nunca lança: entrada inválida
 * vira lista vazia (o processamento não pode cair por causa dos highlights).
 */
export function parseHighlights(raw: string): MeetingHighlight[] {
  const stripped = raw.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  let parsed: { highlights?: unknown };
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1)) as {
      highlights?: unknown;
    };
  } catch {
    return [];
  }

  const list = Array.isArray(parsed.highlights) ? parsed.highlights : [];
  const out: MeetingHighlight[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const h = item as Record<string, unknown>;
    const text = typeof h.text === 'string' ? h.text.trim() : '';
    if (!text) continue;
    out.push({
      kind: normalizeKind(h.kind),
      ts: hmsToSeconds(typeof h.ts === 'string' ? h.ts : ''),
      text: text.slice(0, 500),
      ...(typeof h.speaker === 'string' && h.speaker.trim()
        ? { speaker: h.speaker.trim().slice(0, 120) }
        : {}),
    });
  }
  return out;
}

export function normalizeKind(value: unknown): MeetingHighlight['kind'] {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  if (v === 'decision' || v === 'action' || v === 'topic') return v;
  return 'topic';
}

/** "HH:MM:SS" ou "MM:SS" → segundos. Inválido → 0. */
export function hmsToSeconds(hms: string): number {
  const parts = hms
    .trim()
    .split(':')
    .map((p) => Number.parseInt(p, 10));
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}
