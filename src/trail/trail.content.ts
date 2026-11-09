import { CHEGADA, LARGADA } from './trail.logic';

/**
 * Conteúdo da Trilha da Inovação: Largada, cinco estações em quatro passos e
 * Chegada (1 dor, 1 dado, 1 dono). Cada pessoa percorre a trilha na própria
 * conversa com o Guia; as ideias anotadas formam o piloto de 90 dias da mesa
 * e, na Chegada, a pessoa recebe o próprio plano de ação.
 */
export interface TrailDocument {
  id: string;
  title: string;
  subtitle: string;
  text: string;
}

export interface TrailStep {
  key: string;
  title: string;
  minutes: number;
  /** pergunta que abre o passo */
  ask: string;
  /** respostas sugeridas para a pergunta de abertura */
  options: string[];
  goal: string;
  /** quando o Guia considera o passo concluído */
  done: string;
  /** resposta guardada sem passar pela IA */
  scripted?: boolean;
  /** fala do Guia quando um passo roteirizado encerra a etapa */
  closing?: string;
  /** o que a pessoa leva deste passo; vira um cartão na conversa */
  lesson?: { title: string; text: string };
  /** pede um documento antes de o especialista trabalhar */
  attach?: boolean;
  /** pergunta feita depois do resultado do especialista */
  followUp?: string;
}

export interface TrailStage {
  number: number;
  title: string;
  tagline: string;
  question: string;
  challenge: string;
  care: string;
  /** pessoa no centro da história da estação */
  character: string;
  /** história que abre a conversa da estação */
  scene: string;
  startPrompt: string;
  material: string;
  capabilities: string[];
  attachLabel: string;
  documents: TrailDocument[];
  steps: TrailStep[];
}

/** Os nove campos da Ficha do Piloto, como na apresentação. */
export const SHEET_FIELDS = [
  { key: 'desafio', label: 'Desafio', hint: 'A estação da ideia escolhida' },
  { key: 'problema', label: 'Problema', hint: '"Como podemos...?"' },
  {
    key: 'afetados',
    label: 'Quem é afetado',
    hint: 'O público e o tamanho do problema',
  },
  {
    key: 'dado',
    label: 'Dado disponível',
    hint: 'Onde está e quem cuida dele',
  },
  {
    key: 'indicador',
    label: 'Indicador e meta',
    hint: 'Ponto de partida e meta em 90 dias',
  },
  {
    key: 'solucao',
    label: 'Solução com IA',
    hint: 'Enxergar, prever ou conversar',
  },
  {
    key: 'prototipo',
    label: 'O que o protótipo mostrou',
    hint: 'O que funcionou ao vivo',
  },
  {
    key: 'cuidados',
    label: 'Cuidados',
    hint: 'Dados, revisão humana e transparência',
  },
  {
    key: 'dono',
    label: 'Dono e primeiro passo',
    hint: 'Quem faz o quê na segunda-feira',
  },
] as const;

export type SheetKey = (typeof SHEET_FIELDS)[number]['key'];

const EDITAL_CIDADE_DIGITAL = `FUNDO NACIONAL DE MODERNIZAÇÃO MUNICIPAL
EDITAL DE CHAMAMENTO PÚBLICO Nº 014/2026
PROGRAMA CIDADE DIGITAL

1. OBJETO
Selecionar projetos municipais de transformação digital do atendimento ao cidadão, com foco em canais digitais integrados, redução de filas presenciais e simplificação de serviços.

2. QUEM PODE PARTICIPAR
2.1. Municípios com população acima de 100 mil habitantes.
2.2. O município deve ter plano de transformação digital aprovado por ato do chefe do Poder Executivo.
2.3. É vedada a participação de município com prestação de contas pendente junto ao Fundo.

3. RECURSOS
3.1. Valor total do edital: R$ 24.000.000,00.
3.2. Valor máximo por projeto: R$ 500.000,00.
3.3. A contrapartida do município será definida em regulamento próprio.

4. DESPESAS ADMITIDAS
Licenças de software, desenvolvimento e integração de sistemas, capacitação de servidores e consultoria especializada limitada a 20% do valor do projeto. Não são admitidas despesas com pessoal efetivo, obras civis e aquisição de veículos.

5. DOCUMENTOS EXIGIDOS
a) ofício de apresentação assinado pelo chefe do Poder Executivo;
b) plano de trabalho com cronograma físico-financeiro;
c) certidão negativa de débitos federais;
d) certidão de regularidade junto ao FGTS;
e) comprovante de conta bancária específica para o projeto;
f) declaração de contrapartida.

6. CRONOGRAMA
Publicação do edital: 03/11/2026.
Inscrições: até 30/01/2027, às 18h.
Resultado preliminar: 15/03/2027.
Recursos: até 5 dias úteis após o resultado preliminar.
Resultado final: 05/04/2027.
Assinatura dos termos: até 30 dias após o resultado final.

7. CRITÉRIOS DE SELEÇÃO
Impacto na redução do tempo de atendimento: 40 pontos.
Viabilidade técnica: 30 pontos.
Integração com sistemas existentes: 20 pontos.
Capacitação de servidores: 10 pontos.
Nota mínima para classificação: 60 pontos.

8. EXECUÇÃO E PRESTAÇÃO DE CONTAS
O prazo de execução é de até 12 meses após a assinatura do termo. A prestação de contas final deve ser entregue em até 60 dias após o fim da execução.

9. DISPOSIÇÕES FINAIS
Os casos omissos serão resolvidos pela Comissão de Seleção do Fundo.`;

const EDITAL_CIDADES_RESILIENTES = `AGÊNCIA DE FOMENTO À INOVAÇÃO PÚBLICA
CHAMADA PÚBLICA Nº 07/2026
CIDADES RESILIENTES: PREVENÇÃO DE ALAGAMENTOS

1. FINALIDADE
Apoiar municípios costeiros na implantação de sistemas de monitoramento e alerta de áreas sujeitas a alagamento, com uso de dados de chuva, maré e ocorrências registradas pelos órgãos municipais.

2. ELEGIBILIDADE
2.1. Municípios situados em zona costeira, com Defesa Civil municipal constituída.
2.2. O proponente deve apresentar mapeamento de áreas de risco atualizado nos últimos 5 anos.
2.3. Consórcios intermunicipais podem participar, desde que indiquem um município líder.

3. VALORES
3.1. Valor global da chamada: R$ 36.000.000,00.
3.2. Valor por proposta: de R$ 400.000,00 a R$ 1.200.000,00.
3.3. Contrapartida mínima de 10% do valor solicitado, em recursos financeiros.

4. ITENS FINANCIÁVEIS
Sensores e estações pluviométricas, plataforma de dados, sistemas de alerta à população e capacitação de equipes. Obras de drenagem não são financiáveis por esta chamada.

5. DOCUMENTAÇÃO
a) ofício de adesão assinado pelo chefe do Poder Executivo;
b) proposta técnica com metas e indicadores;
c) mapeamento de áreas de risco;
d) ato de constituição da Defesa Civil municipal;
e) declaração de contrapartida financeira;
f) certidões de regularidade fiscal e trabalhista.

6. PRAZOS
6.1. As propostas devem ser enviadas até 12/02/2027.
6.2. Calendário da chamada:
Abertura: 10/11/2026.
Encerramento das propostas: 15/02/2027.
Análise técnica: até 31/03/2027.
Divulgação dos selecionados: 20/04/2027.
Contratação: até 45 dias após a divulgação.

7. AVALIAÇÃO
População em área de risco beneficiada: 35 pontos.
Qualidade da solução técnica: 30 pontos.
Capacidade de operação após o fim do apoio: 20 pontos.
Articulação com a Defesa Civil estadual: 15 pontos.

8. EXECUÇÃO
Prazo de até 18 meses, prorrogável uma vez por até 6 meses, mediante justificativa. Relatórios técnicos semestrais são obrigatórios.

9. DISPOSIÇÕES GERAIS
A Agência poderá solicitar documentos complementares a qualquer tempo.`;

const EDITAL_ESCOLAS_CONECTADAS = `INSTITUTO NACIONAL DE EDUCAÇÃO CONECTADA
EDITAL Nº 22/2026
ESCOLAS CONECTADAS

1. OBJETO
Financiar a conexão de escolas públicas municipais à internet de alta velocidade e a formação de professores para o uso pedagógico de tecnologias digitais.

2. PARTICIPAÇÃO
2.1. Redes municipais de ensino com ao menos 40 escolas ativas no último Censo Escolar.
2.2. A Secretaria Municipal de Educação é a responsável pela proposta.
2.3. A proposta deve ter parecer favorável do Conselho Municipal de Educação.

3. RECURSOS
3.1. Até R$ 18.000,00 por escola atendida, limitado a R$ 900.000,00 por proposta.
3.2. Não há exigência de contrapartida financeira.
3.3. O município arca com os custos de manutenção após o término do apoio.

4. DESPESAS
Infraestrutura de rede interna, serviço de conexão por até 24 meses e formação de professores, limitada a 15% do valor da proposta. Não são admitidas compras de computadores ou tablets.

5. DOCUMENTOS
a) ofício do chefe do Poder Executivo indicando o responsável pela proposta;
b) lista das escolas atendidas, com código do Censo Escolar;
c) diagnóstico de conectividade de cada escola;
d) plano de formação de professores;
e) parecer do Conselho Municipal de Educação;
f) certidões de regularidade fiscal.

6. CALENDÁRIO
Publicação: 10/11/2026.
Envio das propostas: até 30 dias corridos após a publicação.
Habilitação: até 20/01/2027.
Resultado: 28/02/2027.
Início da execução: até 60 dias após o resultado.

7. SELEÇÃO
Percentual de escolas sem conexão adequada: 40 pontos.
Escolas em áreas rurais e periferias: 30 pontos.
Qualidade do plano de formação: 20 pontos.
Sustentabilidade após o apoio: 10 pontos.

8. ACOMPANHAMENTO
O município informará trimestralmente a velocidade medida em cada escola. O modelo do parecer do Conselho será divulgado oportunamente.

9. DISPOSIÇÕES FINAIS
Dúvidas podem ser enviadas à coordenação do programa em até 10 dias antes do encerramento das propostas.`;

const COMUNICADO_RECADASTRAMENTO = `SECRETARIA MUNICIPAL DE ASSISTÊNCIA SOCIAL
COMUNICADO Nº 118/2026

A Secretaria Municipal comunica aos munícipes que, em conformidade com o disposto na legislação vigente, o recadastramento dos beneficiários do Programa Renda Cidadã deverá ser efetuado impreterivelmente até o dia 20/12/2026, mediante comparecimento presencial a uma das unidades de atendimento, munido de documento oficial com foto e comprovante de residência atualizado, sob pena de suspensão do benefício.

Imagem do comunicado: cartaz com uma pessoa idosa na fila de uma unidade de atendimento, ao lado de uma servidora que aponta para um calendário.`;

const REGRAS_ALVARA = `SECRETARIA MUNICIPAL DE DESENVOLVIMENTO ECONÔMICO
INSTRUÇÃO NORMATIVA Nº 07/2026
ALVARÁ DE FUNCIONAMENTO PARA COMÉRCIO DE BAIXO RISCO

1. Registrar a empresa e obter o CNPJ.
2. Fazer a consulta de viabilidade do endereço no portal da Prefeitura.
3. Enviar contrato social, comprovante de endereço e planta simples do imóvel.
4. Aguardar a análise, que leva até 10 dias úteis.
5. Com o pedido aprovado, pagar a taxa e emitir o alvará no portal.

O valor da taxa consta do Anexo I, a ser publicado.`;

const CARTA_SERVICOS = `CARTA DE SERVIÇOS AO CIDADÃO

Segunda via do IPTU: pelo portal da Prefeitura, sem custo, com o número de inscrição do imóvel.
Marcação de consulta: pelo aplicativo da Saúde ou na unidade básica do bairro, de segunda a sexta, das 8h às 17h.
Poda de árvore: pedido pela central de atendimento, com prazo de até 30 dias.
Coleta de entulho: até 1 metro cúbico por mês, com agendamento pela central de atendimento.`;

const PLANILHA_CHAMADOS = `CHAMADOS AMBIENTAIS DE OUTUBRO DE 2026

protocolo; bairro; ponto; tipo; data
1001; Bairro A; Rua 1; descarte irregular; 03/10/2026
1002; Bairro A; Rua 1; descarte irregular; 07/10/2026
1003; Bairro B; Praça Central; descarte irregular; 08/10/2026
1004; Bairro C; Canal Norte; alagamento; 09/10/2026
1005; Bairro A; Rua 1; descarte irregular; 11/10/2026
1006; Bairro C; Canal Norte; alagamento; 12/10/2026
1007; Bairro D; Avenida 2; coleta atrasada; 13/10/2026
1008; Bairro B; Praça Central; descarte irregular; 14/10/2026
1009; Bairro E; Travessa 3; descarte irregular; 15/10/2026
1010; Bairro C; Canal Norte; alagamento; 16/10/2026
1011; Bairro D; Avenida 2; coleta atrasada; 18/10/2026
1012; Bairro E; Travessa 3; descarte irregular; 19/10/2026
1013; Bairro F; Rua 4; árvore caída; 20/10/2026
1014; Bairro B; Praça Central; descarte irregular; 21/10/2026
1015; Bairro D; Avenida 2; coleta atrasada; 22/10/2026
1016; Bairro F; Rua 4; árvore caída; 23/10/2026`;

export const LARGADA_STAGE: TrailStage = {
  number: LARGADA,
  title: 'Largada',
  tagline: 'Comece aqui',
  question: 'Em qual secretaria ou órgão você trabalha?',
  challenge: 'Conhecer o Guia e começar a trilha.',
  care: 'Não escreva nomes de cidadãos nem dados sigilosos.',
  character: '',
  scene: '',
  startPrompt: '',
  material: '',
  capabilities: [],
  attachLabel: '',
  documents: [],
  steps: [
    {
      key: 'secretaria',
      title: 'Secretaria',
      minutes: 1,
      ask: 'Em qual secretaria ou órgão você trabalha?',
      options: [
        'Saúde',
        'Educação',
        'Assistência Social',
        'Fazenda',
        'Planejamento',
        'Meio Ambiente',
        'Obras',
        'Comunicação',
      ],
      goal: 'Saber a área da pessoa.',
      done: 'A pessoa informou a área.',
      scripted: true,
      closing:
        'Obrigado. Vamos caminhar juntos por cinco estações, cada uma com uma história de São Luís e um desafio real da Prefeitura.\n\nNo final, você define 1 dor, 1 dado e 1 dono da sua área e sai daqui com o seu plano de ação para os próximos 90 dias.',
    },
  ],
};

export const CHEGADA_STAGE: TrailStage = {
  number: CHEGADA,
  title: 'Chegada',
  tagline: '1 dor · 1 dado · 1 dono',
  question: 'O que você leva desta trilha para o seu trabalho?',
  challenge:
    'Definir 1 dor, 1 dado e 1 dono da própria área e transformar isso em um plano de 90 dias.',
  care: 'Não escreva nomes de cidadãos nem dados sigilosos.',
  character: '',
  scene: '',
  startPrompt: '',
  material: '',
  capabilities: [],
  attachLabel: '',
  documents: [],
  steps: [
    {
      key: 'dor',
      title: '1 dor',
      minutes: 1,
      lesson: {
        title: 'Uma dor por vez',
        text: 'Um plano que tenta resolver tudo não começa. Escolher uma dor é o que torna a mudança possível.',
      },
      ask: 'Qual é a sua dor: o problema que o cidadão sente na pele no seu serviço?',
      options: [],
      goal: 'Nomear um problema real que o cidadão sente.',
      done: 'A pessoa descreveu um problema, mesmo em poucas palavras.',
    },
    {
      key: 'dado',
      title: '1 dado',
      minutes: 1,
      lesson: {
        title: 'Comece com o que existe',
        text: 'Uma planilha imperfeita que existe hoje vale mais que o sistema ideal que ainda não chegou.',
      },
      ask: 'Qual planilha ou sistema mostra esse problema?',
      options: [
        'Uma planilha da equipe',
        'Um sistema da Prefeitura',
        'Ainda não temos esse dado',
      ],
      goal: 'Indicar a planilha ou o sistema que mostra o problema.',
      done: 'A pessoa indicou uma fonte de dado ou disse que ela ainda não existe.',
    },
    {
      key: 'dono',
      title: '1 dono',
      minutes: 1,
      lesson: {
        title: 'Todo plano precisa de um dono',
        text: 'Sem alguém responsável por acompanhar o andamento, até a melhor ideia fica no papel.',
      },
      ask: 'Quem poderia cuidar disso nos próximos 90 dias? Diga o cargo ou o setor, sem nome de pessoas.',
      options: ['Minha equipe', 'A coordenação da área', 'Ainda não sei'],
      goal: 'Indicar quem cuida do plano nos próximos 90 dias.',
      done: 'A pessoa indicou um cargo ou setor, ou disse que ainda não sabe.',
    },
  ],
};

export const TRAIL_STATIONS: TrailStage[] = [
  {
    number: 1,
    title: 'Captação de recursos',
    tagline: 'Editais e propostas',
    question: 'Como captar mais recursos com menos retrabalho?',
    challenge:
      'Ler um edital com a IA e chegar ao checklist de requisitos, documentos e prazos.',
    care: 'Confira cada item no edital original. Nenhum número entra na proposta sem fonte.',
    character: 'Socorro',
    scene:
      'Sexta-feira, fim de tarde, e o Gabinete pede uma posição até segunda: há editais abertos e a Prefeitura não pode perder o prazo. Socorro, da equipe de captação, olha para três editais na mesa e tem um medo: deixar passar um detalhe e perder o recurso.',
    startPrompt:
      'Você é analista de captação da Prefeitura de São Luís. Liste em tabela os requisitos, documentos e prazos deste edital. Marque o que não estiver claro.',
    material: 'Um edital público e a lista de projetos da Prefeitura',
    capabilities: ['Conversar'],
    attachLabel: 'Escolha o edital para anexar',
    documents: [
      {
        id: 'cidade-digital',
        title: 'Edital nº 014/2026: Programa Cidade Digital',
        subtitle: 'Fundo Nacional de Modernização Municipal · até R$ 500 mil',
        text: EDITAL_CIDADE_DIGITAL,
      },
      {
        id: 'cidades-resilientes',
        title: 'Chamada nº 07/2026: Cidades Resilientes',
        subtitle: 'Agência de Fomento à Inovação Pública · até R$ 1,2 milhão',
        text: EDITAL_CIDADES_RESILIENTES,
      },
      {
        id: 'escolas-conectadas',
        title: 'Edital nº 22/2026: Escolas Conectadas',
        subtitle: 'Instituto Nacional de Educação Conectada · até R$ 900 mil',
        text: EDITAL_ESCOLAS_CONECTADAS,
      },
    ],
    steps: [
      {
        key: 'agenda',
        title: 'Agenda',
        minutes: 3,
        lesson: {
          title: 'Problema antes da ferramenta',
          text: 'Antes de pensar em IA, diga quem sofre e o que precisa mudar. A tecnologia vem depois.',
        },
        ask: 'E na sua área, onde a correria aperta mais: achar o edital, montar a proposta ou prestar contas?',
        options: ['Achar o edital', 'Montar a proposta', 'Prestar contas'],
        goal: 'Ter o problema em uma frase e quem é afetado.',
        done: 'A pessoa disse o que trava e quem é afetado, mesmo de forma breve.',
      },
      {
        key: 'dados',
        title: 'Dados',
        minutes: 2,
        lesson: {
          title: 'O indicador conta a história',
          text: 'Um bom indicador é um número simples que mostra se o problema está melhorando.',
        },
        ask: 'Que dado mostra esse problema?',
        options: [
          'Propostas enviadas por semestre',
          'Prazos perdidos',
          'Ainda não medimos isso',
        ],
        goal: 'Apontar um dado e um indicador que mostram o problema. Se ajudar, sugira este indicador: propostas enviadas por semestre.',
        done: 'A pessoa citou um dado ou indicador, ou disse como passaria a medir.',
      },
      {
        key: 'solucao',
        title: 'Solução',
        minutes: 5,
        lesson: {
          title: 'As partes de um bom pedido',
          text: 'Diga à IA quem ela é, o que fazer, para quem, em que formato e o que ela não pode fazer.',
        },
        ask: 'Anexe o edital: eu leio e devolvo o checklist de requisitos, documentos e prazos.',
        options: [],
        goal: 'A IA lê o edital e devolve o checklist de requisitos, documentos e prazos. A pessoa avalia o resultado e aponta o que não está claro.',
        done: 'A pessoa comentou o resultado ou apontou algo que precisa ser esclarecido.',
        attach: true,
        followUp:
          'Qual item do checklist mais preocupa você para a Prefeitura participar?',
      },
      {
        key: 'cuidados',
        title: 'Cuidados',
        minutes: 2,
        lesson: {
          title: 'A IA também erra com confiança',
          text: 'Ela pode inventar um requisito ou um prazo com toda a segurança. Por isso, todo número volta à fonte.',
        },
        ask: 'Antes de usar esse resultado, o que você confere no edital original?',
        options: ['Os prazos', 'Os valores', 'Os documentos exigidos'],
        goal: 'Conferir o resultado: nenhum número entra na proposta sem fonte.',
        done: 'A pessoa disse o que confere antes de usar o resultado.',
      },
    ],
  },
  {
    number: 2,
    title: 'Acessibilidade',
    tagline: 'Serviços sem barreiras',
    question: 'Como tornar um serviço acessível a todas as pessoas?',
    challenge:
      'Reescrever um comunicado em linguagem simples e descrever a imagem em texto.',
    care: 'Valide com pessoas com deficiência e idosos antes de publicar.',
    character: 'Seu Raimundo',
    scene:
      'Seu Raimundo, 71 anos, morador do Anjo da Guarda, recebeu o comunicado de recadastramento. Leu duas vezes, não entendeu o que precisava fazer e pegou dois ônibus até o balcão. Na fila, descobriu que muita gente estava ali pelo mesmo motivo.',
    startPrompt:
      'Reescreva este comunicado da Prefeitura em linguagem simples, com frases curtas, sem perder prazos nem informações. Depois, descreva a imagem em texto.',
    material: 'Um comunicado, formulário ou página do site da Prefeitura',
    capabilities: ['Conversar', 'Enxergar'],
    attachLabel: 'Escolha o comunicado para anexar',
    documents: [
      {
        id: 'recadastramento',
        title: 'Comunicado nº 118/2026: Recadastramento',
        subtitle: 'Secretaria Municipal de Assistência Social',
        text: COMUNICADO_RECADASTRAMENTO,
      },
    ],
    steps: [
      {
        key: 'agenda',
        title: 'Agenda',
        minutes: 3,
        lesson: {
          title: 'Quem fica de fora?',
          text: 'Um serviço difícil falha primeiro para quem tem menos apoio. Comece por essa pessoa.',
        },
        ask: 'E no seu serviço, quem seria o Seu Raimundo? Qual comunicado ou serviço mais gera dúvida, e quem mais sofre para usá-lo?',
        options: [
          'Pessoas idosas',
          'Pessoas com deficiência',
          'Quem tem pouca leitura',
        ],
        goal: 'Escolher um serviço ou comunicado real e quem tem mais dificuldade de usá-lo.',
        done: 'A pessoa citou um serviço ou comunicado, ou um público com dificuldade.',
      },
      {
        key: 'dados',
        title: 'Dados',
        minutes: 2,
        lesson: {
          title: 'Pedido de ajuda também é dado',
          text: 'Cada ligação e cada dúvida no balcão mostram onde o serviço cria uma barreira.',
        },
        ask: 'Que pedidos de ajuda mostram essa barreira?',
        options: [
          'Ligações repetidas',
          'Filas no balcão',
          'Tempo para concluir o serviço',
        ],
        goal: 'Apontar os pedidos de ajuda que mostram a barreira e um indicador. Se ajudar, sugira este indicador: tempo para concluir o serviço.',
        done: 'A pessoa citou um sinal da barreira ou um indicador.',
      },
      {
        key: 'solucao',
        title: 'Solução',
        minutes: 5,
        lesson: {
          title: 'Linguagem simples é técnica',
          text: 'Frases curtas, uma ideia por vez e a ação logo no início. Simplificar não é tirar informação.',
        },
        ask: 'Anexe o comunicado: eu reescrevo em linguagem simples e descrevo a imagem em texto.',
        options: [],
        goal: 'A IA reescreve o comunicado em linguagem simples e descreve a imagem. Para Libras, a indicação é o VLibras. A pessoa avalia o resultado.',
        done: 'A pessoa comentou o resultado ou disse o que ajustaria.',
        attach: true,
        followUp: 'O que ficou melhor, e o que você ajustaria nesse texto?',
      },
      {
        key: 'cuidados',
        title: 'Cuidados',
        minutes: 2,
        lesson: {
          title: 'Quem usa é quem valida',
          text: 'A IA ajuda a escrever, mas quem diz se ficou claro são as pessoas idosas e com deficiência.',
        },
        ask: 'Quem precisa validar esse texto antes de publicar?',
        options: [
          'Pessoas com deficiência',
          'Pessoas idosas',
          'A equipe do serviço',
        ],
        goal: 'Validar com pessoas com deficiência e idosos antes de publicar.',
        done: 'A pessoa indicou quem valida o texto.',
      },
    ],
  },
  {
    number: 3,
    title: 'IA para negócios',
    tagline: 'Quem empreende em São Luís',
    question: 'Como facilitar a vida de quem empreende em São Luís?',
    challenge:
      'Montar com a IA um assistente que explica o passo a passo com base nas regras oficiais.',
    care: 'A IA orienta, não concede licença. Toda regra precisa de fonte oficial.',
    character: 'Dona Célia',
    scene:
      'Dona Célia decidiu abrir uma lanchonete no João Paulo. Já foi ao balcão três vezes por causa do alvará, e a cada ida descobre um papel diferente que faltava. Enquanto isso, o aluguel do ponto continua correndo.',
    startPrompt:
      'Você atende empreendedores na Prefeitura de São Luís. Só com as regras abaixo, explique em 5 passos como tirar o alvará. Se faltar algo, avise.',
    material: 'As dúvidas mais comuns do empreendedor e as regras do alvará',
    capabilities: ['Conversar'],
    attachLabel: 'Escolha o documento para anexar',
    documents: [
      {
        id: 'alvara',
        title: 'Instrução Normativa nº 07/2026: Alvará',
        subtitle: 'Secretaria Municipal de Desenvolvimento Econômico',
        text: REGRAS_ALVARA,
      },
    ],
    steps: [
      {
        key: 'agenda',
        title: 'Agenda',
        minutes: 3,
        lesson: {
          title: 'Siga o caminho de quem usa',
          text: 'Percorra o serviço como o cidadão percorre. O problema costuma estar na passagem de uma etapa para outra.',
        },
        ask: 'Pensando em quem é como a Dona Célia, em qual momento quem empreende mais sofre: abrir a empresa, tirar o alvará ou vender à Prefeitura?',
        options: ['Abrir empresa', 'Tirar alvará', 'Vender à Prefeitura'],
        goal: 'Escolher um momento de quem empreende e dizer quem é afetado.',
        done: 'A pessoa escolheu um momento ou descreveu uma dificuldade de quem empreende.',
      },
      {
        key: 'dados',
        title: 'Dados',
        minutes: 2,
        lesson: {
          title: 'Tempo de espera é custo',
          text: 'Cada dia a mais para um alvará é dinheiro que quem empreende deixa de ganhar. Medir o tempo mostra isso.',
        },
        ask: 'Quais dúvidas mais chegam ao atendimento?',
        options: [
          'Quais documentos levar',
          'Quanto custa',
          'Quanto tempo demora',
        ],
        goal: 'Apontar as dúvidas mais comuns e um indicador. Se ajudar, sugira este indicador: dias para obter o alvará.',
        done: 'A pessoa citou uma dúvida frequente ou um indicador.',
      },
      {
        key: 'solucao',
        title: 'Solução',
        minutes: 5,
        lesson: {
          title: 'IA com fonte responde melhor',
          text: 'Quando a IA responde só com as regras que você entregou, ela inventa menos e avisa o que falta.',
        },
        ask: 'Anexe as regras do alvará: eu monto o passo a passo com base nelas.',
        options: [],
        goal: 'A IA explica o passo a passo com base nas regras oficiais. A pessoa avalia se um empreendedor entenderia e o que falta nas regras.',
        done: 'A pessoa comentou o resultado ou apontou o que falta.',
        attach: true,
        followUp: 'Um empreendedor entenderia esse passo a passo? O que falta?',
      },
      {
        key: 'cuidados',
        title: 'Cuidados',
        minutes: 2,
        lesson: {
          title: 'A IA orienta, o servidor responde',
          text: 'Explicar o caminho pode ser automático. Conceder ou negar continua sendo ato de uma pessoa responsável.',
        },
        ask: 'A IA orienta, mas não concede licença. Quem responde pela informação, e qual fonte oficial sustenta cada regra?',
        options: [],
        goal: 'Deixar claro que a IA orienta e não concede licença, e que toda regra precisa de fonte oficial.',
        done: 'A pessoa indicou quem responde ou qual fonte confere.',
      },
    ],
  },
  {
    number: 4,
    title: 'IA para o cidadão',
    tagline: 'Atendimento rápido e claro',
    question: 'Qual atendimento pode ficar mais rápido e mais claro?',
    challenge:
      'Montar um atendimento de WhatsApp com a IA, baseado na carta de serviços.',
    care: 'Avise que é uma IA, garanta a saída para um humano e não use dados pessoais.',
    character: 'Luana',
    scene:
      'Luana usou o intervalo do trabalho só para saber se o exame da mãe foi marcado. Ligou para a central e o intervalo acabou antes de alguém atender. Do outro lado da linha, uma atendente responde a mesma pergunta o dia inteiro.',
    startPrompt:
      'Você é o assistente da Prefeitura no WhatsApp. Responda só com base na carta de serviços abaixo, em até 3 frases. Fora dela, ofereça um atendente.',
    material:
      'As 10 perguntas mais comuns do atendimento e a carta de serviços',
    capabilities: ['Conversar'],
    attachLabel: 'Escolha o documento para anexar',
    documents: [
      {
        id: 'carta-servicos',
        title: 'Carta de Serviços ao Cidadão',
        subtitle: 'Prefeitura de São Luís',
        text: CARTA_SERVICOS,
      },
    ],
    steps: [
      {
        key: 'agenda',
        title: 'Agenda',
        minutes: 3,
        lesson: {
          title: 'Repetição é um sinal',
          text: 'Quando a mesma pergunta volta todo dia, o problema não é de quem pergunta: é de como a informação chega.',
        },
        ask: 'E no seu serviço, qual atendimento tem fila, demora ou gente ligando de novo pelo mesmo motivo?',
        options: [],
        goal: 'Escolher um atendimento com fila, demora ou ligações repetidas.',
        done: 'A pessoa citou um atendimento com dificuldade.',
      },
      {
        key: 'dados',
        title: 'Dados',
        minutes: 2,
        lesson: {
          title: 'Resolver na primeira vez',
          text: 'Casos resolvidos no primeiro contato mostram mais que velocidade: mostram se a pessoa saiu com a resposta.',
        },
        ask: 'Quais são as perguntas mais frequentes?',
        options: [
          'Segunda via de documentos',
          'Marcação de atendimento',
          'Prazo de um pedido',
        ],
        goal: 'Apontar as perguntas mais frequentes e um indicador. Se ajudar, sugira este indicador: casos resolvidos no primeiro contato.',
        done: 'A pessoa citou uma pergunta frequente ou um indicador.',
      },
      {
        key: 'solucao',
        title: 'Solução',
        minutes: 5,
        lesson: {
          title: 'O limite é o que dá confiança',
          text: 'Um bom assistente sabe o que não sabe: responde só com a base e chama um atendente para o resto.',
        },
        ask: 'Anexe a carta de serviços: eu atendo pelo WhatsApp só com base nela.',
        options: [],
        goal: 'A IA faz o atendimento de WhatsApp com base na carta de serviços. Enquanto a pessoa escrever como cidadão, responda como o assistente, em até 3 frases, e pergunte se a resposta serviu.',
        done: 'A pessoa escreveu ao menos uma pergunta de cidadão e disse se a resposta serviu.',
        attach: true,
        followUp: 'Agora escreva como um cidadão escreveria no WhatsApp.',
      },
      {
        key: 'cuidados',
        title: 'Cuidados',
        minutes: 2,
        lesson: {
          title: 'O cidadão precisa saber',
          text: 'Avise que é uma IA e deixe sempre aberta a saída para falar com uma pessoa.',
        },
        ask: 'Como o cidadão fica sabendo que fala com uma IA, e como chega a um atendente?',
        options: [],
        goal: 'Avisar que é uma IA, garantir saída para um humano e não usar dados pessoais.',
        done: 'A pessoa disse como avisa que é uma IA ou como chega a um atendente.',
      },
    ],
  },
  {
    number: 5,
    title: 'Sustentabilidade',
    tagline: 'Dados para a cidade',
    question: 'Que problema ambiental os dados podem ajudar a resolver?',
    challenge:
      'Organizar os chamados com a IA e chegar a um mapa de prioridades ou uma rota de vistoria.',
    care: 'A IA aponta prioridades; a fiscalização e a decisão continuam com a equipe.',
    character: 'Marcos',
    scene:
      'Choveu forte em São Luís e os chamados se acumularam. Marcos, fiscal ambiental, tem uma pilha de ocorrências, uma equipe pequena e uma decisão para tomar logo cedo: por onde começar? Se errar a ordem, um ponto de descarte entope a galeria e a rua alaga de novo.',
    startPrompt:
      'Você é analista ambiental da Prefeitura. Agrupe os chamados desta planilha por bairro, aponte os 5 pontos mais recorrentes e sugira uma rota de vistoria.',
    material: 'Uma planilha de chamados ou ocorrências, sem dados pessoais',
    capabilities: ['Enxergar', 'Prever'],
    attachLabel: 'Escolha a planilha para anexar',
    documents: [
      {
        id: 'chamados',
        title: 'Chamados ambientais: outubro de 2026',
        subtitle: 'Planilha com 16 registros',
        text: PLANILHA_CHAMADOS,
      },
    ],
    steps: [
      {
        key: 'agenda',
        title: 'Agenda',
        minutes: 3,
        lesson: {
          title: 'Use o que a cidade já tem',
          text: 'Chamados, rotas e registros antigos já contam onde o problema se repete. Nem sempre é preciso criar dado novo.',
        },
        ask: 'Olhando para a sua região, o que pesa mais: descarte irregular, alagamento, coleta ou arborização?',
        options: ['Descarte irregular', 'Alagamento', 'Coleta', 'Arborização'],
        goal: 'Escolher um problema ambiental concreto e quem é afetado.',
        done: 'A pessoa escolheu um problema concreto.',
      },
      {
        key: 'dados',
        title: 'Dados',
        minutes: 2,
        lesson: {
          title: 'Dado bom não tem nome',
          text: 'Para achar padrões, não é preciso saber quem reclamou. Tire nome, telefone e endereço de quem abriu o chamado.',
        },
        ask: 'Que dados existem sobre isso: chamados, chuva, rotas ou fotos?',
        options: [
          'Chamados',
          'Dados de chuva',
          'Rotas de coleta',
          'Fotos do local',
        ],
        goal: 'Apontar os dados existentes e um indicador. Se ajudar, sugira este indicador: chamados atendidos no prazo.',
        done: 'A pessoa citou um dado ou um indicador.',
      },
      {
        key: 'solucao',
        title: 'Solução',
        minutes: 5,
        lesson: {
          title: 'Enxergar padrões, definir prioridades',
          text: 'A IA junta o que está espalhado e mostra o que se repete. É assim que uma pilha vira uma ordem de trabalho.',
        },
        ask: 'Anexe a planilha de chamados: eu organizo os dados e proponho uma rota de vistoria.',
        options: [],
        goal: 'A IA organiza os dados e propõe um mapa de prioridades ou uma rota de vistoria. A pessoa avalia se faz sentido para quem conhece o território.',
        done: 'A pessoa comentou o resultado ou disse o que mudaria.',
        attach: true,
        followUp: 'Essa prioridade faz sentido para quem conhece o território?',
      },
      {
        key: 'cuidados',
        title: 'Cuidados',
        minutes: 2,
        lesson: {
          title: 'Prioridade não é sentença',
          text: 'A IA sugere por onde começar. Quem conhece o território confere e decide.',
        },
        ask: 'A IA aponta prioridades. Quem decide a fiscalização, e o que a equipe confere antes de ir a campo?',
        options: [],
        goal: 'Deixar claro que a fiscalização e a decisão continuam com a equipe.',
        done: 'A pessoa disse quem decide ou o que confere.',
      },
    ],
  },
];

export const stationByNumber = (n: number) =>
  TRAIL_STATIONS.find((s) => s.number === n);

/** A Largada, uma das cinco estações ou a Chegada. */
export const stageByNumber = (n: number) => {
  if (n === LARGADA) return LARGADA_STAGE;
  if (n === CHEGADA) return CHEGADA_STAGE;
  return stationByNumber(n);
};
