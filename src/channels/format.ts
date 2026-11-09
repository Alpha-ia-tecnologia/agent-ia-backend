/**
 * Converte o Markdown que os agentes produzem para o formato de cada canal.
 * Os LLMs mandam `**negrito**`, `# títulos`, `[link](url)` etc. — que aparecem
 * crus (com asteriscos e cerquilhas) no WhatsApp/Telegram/e-mail.
 */

/** Normalizações comuns antes da formatação específica de cada canal. */
function base(md: string): string {
  return (
    md
      // blockquote "> " no início da linha
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      // régua horizontal (--- *** ___)
      .replace(/^[ \t]{0,3}([-*_])\1{2,}[ \t]*$/gm, '')
      // links [texto](url) → texto (url)
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '$1 ($2)')
      // imagens ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // blocos de código ```...``` → sem as cercas
      .replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, '$1')
      // código inline `x` → x
      .replace(/`([^`]+)`/g, '$1')
  );
}

/** Markdown → formatação do WhatsApp (*negrito*, _itálico_, ~tachado~). */
export function mdToWhatsApp(md: string): string {
  return (
    base(md)
      // títulos "# Título" → linha em *negrito* (sem negrito interno: WhatsApp
      // não aninha, e asteriscos duplicados colidem)
      .replace(
        /^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm,
        (_m, t: string) => `*${t.replace(/(\*\*|__)/g, '').trim()}*`,
      )
      // negrito **x** / __x__ → *x*
      .replace(/(\*\*|__)(.+?)\1/gs, '*$2*')
      // tachado ~~x~~ → ~x~
      .replace(/~~(.+?)~~/gs, '~$1~')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Markdown → texto puro limpo (Telegram/e-mail: sem asteriscos nem cerquilhas). */
export function mdToPlain(md: string): string {
  return (
    base(md)
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, '$1')
      .replace(/(\*\*|__)(.+?)\1/gs, '$2')
      .replace(/~~(.+?)~~/gs, '$2')
      // ênfase simples *x* / _x_ → x (evita bullets "* " e "_" solto)
      .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
