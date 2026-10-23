export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const DEFAULT_FLOW = {
  name: 'Exemplo de comentários e DM',
  account: 'example_creator',
  reel: 'https://www.instagram.com/reel/EXAMPLE/',
  enabled: true,
  trigger: 'any',
  keywords: 'quero, link',
  publicReplies: [
    '🦀🧀 caranqueijo [raro] te enviou o link na dm',
    '🪳🍩 barata na rosquinha [comum] te enviou o link',
    '🍄🛹 cogumelo skatista [comum] te enviou o link na dm',
  ],
  firstMessage: 'Ooopa!\nAqui está o link do meu app de anúncio https://example.com/product\n\nClica no link abaixo caso queira testar o produto de graça!',
  optInLabel: 'Quero testar de graça',
  secondMessage: 'Então tome 🫢',
  linkLabel: 'resgatar créditos',
  linkUrl: 'https://example.com/try',
  recoveryMessage: 'Ooopa! Vi seu comentário no meu reel 😊\nAqui está o link do meu app de anúncio: https://example.com/product\n\nE aqui está o link para resgatar os créditos e testar o produto: https://example.com/try',
};

export function validateFlow(flow) {
  const errors = [];
  for (const [field, label] of [['name', 'Nome'], ['firstMessage', 'Primeira mensagem'], ['optInLabel', 'Botão de interação'], ['secondMessage', 'Segunda mensagem'], ['linkLabel', 'Texto do link']]) {
    if (typeof flow[field] !== 'string' || !flow[field].trim()) errors.push(`${label}: preencha o campo.`);
  }
  for (const [field, label] of [['reel', 'Publicação'], ['linkUrl', 'Link de destino']]) {
    try { if (new URL(flow[field]).protocol !== 'https:') throw new Error(); }
    catch { errors.push(`${label}: use uma URL completa com https://.`); }
  }
  if (!['any', 'keyword'].includes(flow.trigger)) errors.push('Escolha um tipo de comentário.');
  if (typeof flow.keywords !== 'string' || (flow.trigger === 'keyword' && !flow.keywords.trim())) errors.push('Informe as palavras-chave como texto.');
  if (!Array.isArray(flow.publicReplies) || flow.publicReplies.length !== 3 || flow.publicReplies.some(x => typeof x !== 'string' || !x.trim())) errors.push('Preencha as três respostas públicas.');
  return errors;
}

export function createSession(now = Date.now()) {
  return { now, initialNow: now, comment: null, seenCommentIds: [], privateReplied: false, interactedAt: null, continued: false, human: false, logs: [] };
}

function log(state, kind, text, extra = {}) {
  const next = { ...state, logs: [...state.logs, { at: state.now, kind, text, ...extra }] };
  return next;
}
function blocked(state, text) { return log(state, 'blocked', text); }

export function addComment(state, flow, comment) {
  if (state.seenCommentIds.includes(comment.commentId)) return blocked(state, 'Evento repetido: esta resposta privada já foi processada.');
  if (state.comment) return blocked(state, 'Esta simulação já tem uma conversa. Reinicie para testar outra pessoa.');
  const next = { ...state, comment, seenCommentIds: [...state.seenCommentIds, comment.commentId] };
  const received = log(next, 'comment', comment.text, { username: comment.username });
  if (!flow.enabled) return blocked(received, 'Automação pausada. Nenhuma mensagem simulada foi enviada.');
  if (state.human) return blocked(received, 'Atendimento assumido. A automação está pausada nesta conversa.');
  if (!Number.isFinite(comment.createdAt) || comment.createdAt > state.now) return blocked(received, 'O horário do comentário é inválido.');
  if (state.now - comment.createdAt > 7 * DAY) return blocked(received, 'O comentário tem mais de 7 dias. A primeira resposta privada foi bloqueada.');
  const terms = flow.keywords.split(',').map(x => x.trim().toLocaleLowerCase('pt-BR')).filter(Boolean);
  if (flow.trigger === 'keyword' && !terms.some(term => comment.text.trim().toLocaleLowerCase('pt-BR') === term)) return log(received, 'note', 'O comentário não contém a palavra-chave.');
  const replied = log(received, 'public', flow.publicReplies[0]);
  return { ...log(replied, 'outgoing', flow.firstMessage, { button: flow.optInLabel }), privateReplied: true };
}

export function receiveInteraction(state, text) {
  if (!state.privateReplied) return blocked(state, 'É preciso receber a primeira DM antes de interagir com ela.');
  if (state.human) return blocked(state, 'Atendimento assumido. Continue manualmente.');
  return { ...log(state, 'incoming', text), interactedAt: state.now };
}

export function sendContinuation(state, flow) {
  if (!flow.enabled) return blocked(state, 'Automação pausada. Nenhuma mensagem simulada foi enviada.');
  if (state.human) return blocked(state, 'Atendimento assumido. A automação está pausada nesta conversa.');
  if (state.continued) return blocked(state, 'A segunda mensagem já foi enviada. O evento repetido foi ignorado.');
  if (!state.privateReplied || state.interactedAt === null) return blocked(state, 'Aguardando interação: o comentário sozinho não libera a segunda DM.');
  if (state.now - state.interactedAt >= DAY) return blocked(state, 'A janela de 24 horas terminou. Uma nova interação é necessária.');
  return { ...log(state, 'outgoing', flow.secondMessage, { button: flow.linkLabel, href: flow.linkUrl }), continued: true };
}

export function advanceClock(state, duration) { return { ...state, now: state.now + duration }; }
export function takeOver(state) { return { ...log(state, 'note', 'Atendimento assumido. Automação pausada nesta conversa.'), human: true }; }
export function windowRemaining(state) { return state.interactedAt === null ? 0 : Math.max(0, DAY - (state.now - state.interactedAt)); }
