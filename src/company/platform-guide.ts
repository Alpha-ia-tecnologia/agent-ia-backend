/**
 * Guia da plataforma servido aos agentes pela tool `guia_plataforma`, para que
 * expliquem ao usuário como usar cada recurso do Alpha Agents Office.
 */
export const PLATFORM_GUIDE: Record<
  string,
  { titulo: string; conteudo: string }
> = {
  conector: {
    titulo: 'Conector local — compartilhar pastas do computador',
    conteudo: `O conector local permite que os agentes leiam e criem arquivos em pastas escolhidas de um computador da empresa (nunca excluem nada). Passo a passo:

1. No menu lateral, abra **Configurações → aba "Conector local"**.
2. Dê um nome (ex.: "Computador da recepção") e clique em **Criar conector**.
3. Copie o comando exibido — o token aparece só uma vez. Exemplo:
   npx @alphatech/aao-connector --token aaoc_xxx --pasta "C:\\Documentos" --pasta "C:\\Contratos:ro"
4. No computador que terá as pastas compartilhadas, instale o Node.js (versão 20+) e execute o comando num terminal. Use ":ro" no fim de uma pasta para permitir apenas leitura.
5. Em alguns segundos o conector aparece como **Online** na mesma tela, com as pastas listadas.
6. Pronto: em qualquer conversa, peça ao agente coisas como "liste meus arquivos locais" ou "leia o contrato X". Se o conector estiver desligado, basta rodar o comando de novo.

Para revogar o acesso, clique em **Revogar** na lista de conectores.`,
  },
  projetos: {
    titulo: 'Projetos, tarefas e kanban',
    conteudo: `1. No menu lateral, abra **Projetos** e clique em **+ Novo projeto**: dê nome, descrição, escolha os setores (ou todos) e anexe um documento se quiser.
2. Na página do projeto, use **"Analisar com a equipe"** para a IA levantar requisitos e sugerir as primeiras tarefas no backlog.
3. A aba **Kanban** mostra as colunas A fazer / Em andamento / Em revisão / Concluída — arraste os cards para mudar o status. A aba **Listas** organiza tarefas em listas (como sprints).
4. Tarefas podem ter como membros agentes e usuários. A aba **Conversas** abre chats no contexto do projeto: os agentes conhecem o projeto e podem criar, atribuir e mover tarefas por você.
5. O status do projeto muda no topo da página (Aguardando início → Em andamento → Finalizado, com reabertura). Tarefas sem projeto ficam em "Tarefas avulsas" na página de Projetos.`,
  },
  conhecimento: {
    titulo: 'Base de conhecimento e busca inteligente',
    conteudo: `1. No menu lateral, abra **Conhecimento**: envie arquivos (PDF, DOCX, TXT, MD, CSV), cole textos ou adicione links. Escolha se ficam visíveis para todos os agentes ou só para um.
2. Os agentes consultam essa base automaticamente para responder com contexto da empresa.
3. Para busca por significado (encontra conteúdo mesmo sem as palavras exatas), ative a seção **"Busca inteligente (embeddings)"** na mesma página: selecione uma chave OpenAI/Google/compatível, informe o modelo (ex.: text-embedding-3-small) e clique em Reindexar.`,
  },
  agentes: {
    titulo: 'Agentes e setores',
    conteudo: `1. No menu lateral, abra **Escritório** para ver agentes, usuários e setores. Crie agentes manualmente ou com ajuda da IA.
2. Cada agente tem página própria (clique nele na sidebar) com abas: **Configuração** (nome, cargo, prompt, modelo/temperatura), **Ferramentas** (quais ferramentas HTTP ele pode usar) e **Acesso** (quais usuários podem acioná-lo).
3. O Agente Gerente coordena os demais: fale com ele no chat e ele aciona os especialistas certos.`,
  },
  usuarios: {
    titulo: 'Usuários e acessos',
    conteudo: `1. Em **Escritório → aba Usuários**, um administrador pode convidar novos usuários (nome, e-mail e papel: Admin ou Membro).
2. No MVP a senha temporária é exibida na criação — repasse ao novo usuário com segurança.
3. O acesso de cada usuário aos agentes é controlado na página do agente, aba **Acesso**.`,
  },
  ferramentas: {
    titulo: 'Ferramentas personalizadas (integrações HTTP)',
    conteudo: `1. No menu lateral, abra **Ferramentas** e clique em criar: dê nome, descrição (em português, dizendo quando usar), método/URL da API do seu sistema e os parâmetros.
2. Headers secretos (tokens) são criptografados.
3. Vincule a ferramenta aos agentes que podem usá-la (página do agente, aba Ferramentas). A partir daí, os agentes chamam seu sistema quando a conversa pedir.`,
  },
};

export function guideIndex(): string {
  return Object.entries(PLATFORM_GUIDE)
    .map(([key, g]) => `- ${key}: ${g.titulo}`)
    .join('\n');
}
