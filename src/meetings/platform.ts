/**
 * Detecção e validação de link de reunião (lado do aao-api, espelha a do
 * aao-scribe). Explícito-por-design: só aceitamos URLs que casam com um padrão
 * conhecido de Teams ou Meet.
 */
export type MeetingPlatform = 'TEAMS' | 'MEET';

const MEET_RE =
  /^https:\/\/meet\.google\.com\/([a-z0-9]{3,}-[a-z0-9]{3,}-[a-z0-9]{3,}|lookup\/[^/?#]+)(?:[/?#].*)?$/i;

// Aceita meetup-join (corporativo antigo), /meet/ (formato novo) e Teams pessoal.
const TEAMS_RE =
  /^https:\/\/(teams\.microsoft\.com\/l\/meetup-join\/|teams\.microsoft\.com\/meet\/|teams\.live\.com\/meet\/)/i;

export function detectPlatform(url: string): MeetingPlatform | null {
  const u = (url ?? '').trim();
  if (MEET_RE.test(u)) return 'MEET';
  if (TEAMS_RE.test(u)) return 'TEAMS';
  return null;
}
