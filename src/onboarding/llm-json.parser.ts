export interface SuggestedAgent {
  name: string;
  role: string;
  department: string;
  systemPrompt: string;
  avatarSeed: string;
}

/**
 * Tolerant parser for LLM JSON output.
 * Accepts raw JSON, ```json fenced blocks, or JSON embedded in prose.
 */
export function parseAgentsJson(raw: string): SuggestedAgent[] {
  if (!raw || !raw.trim()) {
    throw new Error('Resposta vazia do LLM');
  }

  let candidate = raw.trim();

  // Extract fenced code block if present
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  // Fallback: extract first {...} block
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Nenhum JSON encontrado na resposta do LLM');
    }
    candidate = candidate.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('JSON inválido na resposta do LLM');
  }

  const agents = Array.isArray(parsed)
    ? parsed
    : (parsed as { agents?: unknown }).agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error('Resposta do LLM não contém a lista "agents"');
  }

  return agents.map((a: Record<string, unknown>, i: number) => {
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    if (!name) throw new Error(`Agente ${i} sem nome`);
    return {
      name,
      role: typeof a.role === 'string' ? a.role : '',
      department: typeof a.department === 'string' ? a.department : 'Geral',
      systemPrompt: typeof a.systemPrompt === 'string' ? a.systemPrompt : '',
      avatarSeed:
        typeof a.avatarSeed === 'string' && a.avatarSeed
          ? a.avatarSeed
          : name.toLowerCase().replace(/\s+/g, '-'),
    };
  });
}
