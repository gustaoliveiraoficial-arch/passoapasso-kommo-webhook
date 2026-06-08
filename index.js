const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SUBDOMAIN       = 'passoapassouniformes2025';
const TOKEN           = process.env.KOMMO_TOKEN;
const OPENROUTER_KEY  = process.env.OPENROUTER_API_KEY;
const PIPELINE_ID     = 13368211;
const BOT_USER_ID = 14977039; // Conta "Passo a passo uniformes"

// Etapas do Funil de Vendas
const ETAPA = {
  ENTRADA:          103109571, // Etapa de leads de entrada
  PRIMEIRO_CONTATO: 103109831, // Primeiro Contato
  QUALIFICADO:      103109847, // Qualificado
  LEAD_FRIO:        103109843, // Lead Frio
};

const BASE = `https://${SUBDOMAIN}.kommo.com/api/v4`;
const hdrs = () => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });

// ─── SYSTEM PROMPT DA ATENDENTE ANA ────────────────────────────────────────
const SYSTEM_PROMPT = `
Você é a Ana, atendente virtual da PassoaPasso Uniformes — empresa especializada em uniformes personalizados de qualidade.

Nossas linhas:
- Empresarial: camisas polo, camisetas, uniformes corporativos
- Fitness: leggings, tops, bermudas, conjuntos fitness
- Formandos: camisetas e moletons de turma/formatura
- Futebol: camisas, shorts e conjuntos esportivos
- Inverno: moletons, jaquetas, blusas de frio personalizadas

REGRAS DE ATENDIMENTO:
- Seja cordial, natural e objetiva. Máximo 3 frases curtas por resposta.
- Não use asteriscos nem emojis em excesso (1 por mensagem no máximo).
- Nunca faça mais de 2 perguntas de uma vez.
- Seu objetivo é qualificar: coletar tipo, quantidade, prazo e se tem arte/logo.
- Pedido mínimo: 10 peças. Se quantidade < 10, use ação "sem_perfil".
- Quando tiver tipo + quantidade (≥10) + prazo: use ação "qualificado".
- Após qualificar: avise que um consultor entrará em contato em breve.

RESPONDA SEMPRE EM JSON PURO (sem markdown, sem blocos de código):
{
  "mensagem": "texto da resposta para o cliente",
  "acao": "continuar" | "qualificado" | "sem_perfil",
  "dados": {
    "tipo": "empresarial" | "fitness" | "formandos" | "futebol" | "inverno" | null,
    "quantidade": numero_inteiro_ou_null,
    "prazo": "descrição do prazo ou null",
    "tem_arte": true | false | null
  }
}

FLUXO SUGERIDO:
1. Saudação + pergunta sobre o que procuram
2. Identificar tipo de uniforme
3. Quantidade de peças (se <10 → sem_perfil com mensagem gentil)
4. Prazo de entrega necessário
5. Se tem arte/logo pronto ou precisa criar
6. Quando qualificado → mensagem de encerramento + avisar que consultor vai entrar em contato
`.trim();

// ─── FUNÇÕES DA API KOMMO ───────────────────────────────────────────────────
async function getLead(leadId) {
  const r = await fetch(`${BASE}/leads/${leadId}`, { headers: hdrs() });
  if (!r.ok) { console.error(`[KOMMO] getLead ${leadId} HTTP ${r.status}`); return null; }
  return r.json();
}

async function getTalkByLead(leadId) {
  const r = await fetch(`${BASE}/talks?filter[entity_id]=${leadId}&filter[entity_type]=lead&limit=1`, { headers: hdrs() });
  if (!r.ok) return null;
  const d = await r.json();
  return d._embedded?.talks?.[0] || null;
}

async function getMensagens(talkId) {
  const r = await fetch(`${BASE}/talks/${talkId}/messages?limit=20`, { headers: hdrs() });
  if (!r.ok) { console.error(`[KOMMO] getMensagens talk ${talkId} HTTP ${r.status}`); return []; }
  const d = await r.json();
  return d._embedded?.messages || [];
}

async function enviarMensagem(talkId, texto) {
  // Endpoint para enviar mensagem na conversa
  const r = await fetch(`${BASE}/talks/${talkId}/messages`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({ text: texto, author_id: BOT_USER_ID })
  });

  if (r.ok) return true;

  const errBody = await r.text().catch(() => '');
  console.error(`[SEND] talk ${talkId} HTTP ${r.status} — ${errBody.substring(0, 200)}`);
  return false;
}

async function moverLead(leadId, statusId) {
  const r = await fetch(`${BASE}/leads/${leadId}`, {
    method: 'PATCH',
    headers: hdrs(),
    body: JSON.stringify({ status_id: statusId })
  });
  const label = Object.keys(ETAPA).find(k => ETAPA[k] === statusId) || statusId;
  console.log(`[MOVE] Lead ${leadId} → ${label} (${statusId}) | HTTP ${r.status}`);
}

async function salvarNota(leadId, texto) {
  await fetch(`${BASE}/leads/${leadId}/notes`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify([{ note_type: 'common', params: { text: texto } }])
  });
}

// ─── IA VIA OPENROUTER ──────────────────────────────────────────────────────
async function consultarIA(historico) {
  if (!OPENROUTER_KEY) { console.error('[IA] OPENROUTER_API_KEY não configurada'); return null; }

  const mensagens = [{ role: 'system', content: SYSTEM_PROMPT }, ...historico];

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'HTTP-Referer': 'https://passoapassouniformes2025.kommo.com',
      'X-Title': 'Atendente IA Ana'
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      max_tokens: 600,
      messages: mensagens
    })
  });

  if (!r.ok) {
    console.error('[IA] OpenRouter', r.status, await r.text().catch(() => ''));
    return null;
  }

  const d = await r.json();
  const texto = d.choices?.[0]?.message?.content?.trim() || '';

  try {
    return JSON.parse(texto);
  } catch {
    const match = texto.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* ignora */ }
    }
    console.error('[IA] JSON inválido:', texto.substring(0, 300));
    return null;
  }
}

// ─── PROCESSAMENTO DO LEAD ──────────────────────────────────────────────────
async function processarLead(leadId) {
  const lead = await getLead(leadId);
  if (!lead) return;

  // Só age nas etapas de entrada e primeiro contato
  if (![ETAPA.ENTRADA, ETAPA.PRIMEIRO_CONTATO].includes(lead.status_id)) {
    console.log(`[SKIP] Lead ${leadId} já na etapa ${lead.status_id}`);
    return;
  }

  const talk = await getTalkByLead(leadId);
  if (!talk) {
    console.log(`[SKIP] Lead ${leadId} sem conversa no WhatsApp`);
    return;
  }

  const mensagens = await getMensagens(talk.talk_id);
  if (!mensagens.length) return;

  // Verifica se a última mensagem é do cliente (não do bot)
  const ultima = mensagens[mensagens.length - 1];
  if (ultima.author_type !== 'contact') {
    console.log(`[SKIP] Lead ${leadId} — última mensagem já é do bot, aguardando cliente`);
    return;
  }

  // Monta histórico para o Claude (últimas 10 mensagens)
  const historico = mensagens.slice(-10).map(m => ({
    role: m.author_type === 'contact' ? 'user' : 'assistant',
    content: m.text || '[mensagem de mídia]'
  }));

  console.log(`[IA] Lead ${leadId} | talk ${talk.talk_id} | ${historico.length} mensagens`);
  const resposta = await consultarIA(historico);

  if (!resposta?.mensagem) {
    console.error(`[IA] Resposta inválida para lead ${leadId}`);
    return;
  }

  // Envia a resposta ao cliente
  const enviado = await enviarMensagem(talk.talk_id, resposta.mensagem);
  console.log(`[SEND] Lead ${leadId} | ok=${enviado} | ação=${resposta.acao}`);

  // Move para "Primeiro Contato" se ainda está na entrada
  if (lead.status_id === ETAPA.ENTRADA) {
    await moverLead(leadId, ETAPA.PRIMEIRO_CONTATO);
  }

  // Ações pós-resposta
  if (resposta.acao === 'qualificado') {
    await moverLead(leadId, ETAPA.QUALIFICADO);

    const dados = resposta.dados || {};
    const nota = [
      'Qualificado pela Ana (IA)',
      dados.tipo        ? `Linha: ${dados.tipo}`             : '',
      dados.quantidade  ? `Quantidade: ${dados.quantidade} peças` : '',
      dados.prazo       ? `Prazo: ${dados.prazo}`            : '',
      dados.tem_arte !== null && dados.tem_arte !== undefined
        ? `Arte pronta: ${dados.tem_arte ? 'Sim' : 'Nao'}`
        : '',
    ].filter(Boolean).join('\n');

    await salvarNota(leadId, nota);
    console.log(`[QUALIFICADO] Lead ${leadId} movido para Qualificado com nota`);
  }

  if (resposta.acao === 'sem_perfil') {
    await moverLead(leadId, ETAPA.LEAD_FRIO);
    await salvarNota(leadId, 'Lead sem perfil (menos de 10 pecas) — movido para Lead Frio pela Ana (IA)');
    console.log(`[SEM_PERFIL] Lead ${leadId} movido para Lead Frio`);
  }
}

// ─── ROTA WEBHOOK ───────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.json({ ok: true }); // Responde imediatamente ao Kommo

  try {
    const body = req.body;
    console.log('[WEBHOOK]', JSON.stringify(body).substring(0, 400));

    const agendarProcessamento = (leadId, delay = 0) => {
      if (!leadId) return;
      const executar = () => processarLead(leadId).catch(e => console.error('[ERRO]', leadId, e.message));
      if (delay) setTimeout(executar, delay);
      else executar();
    };

    // Novo lead adicionado
    for (const lead of body?.leads?.add || []) {
      if (Number(lead.pipeline_id) !== PIPELINE_ID) continue;
      console.log(`[WEBHOOK] Novo lead: ${lead.id}`);
      agendarProcessamento(lead.id, 2000); // 2s para garantir que dados estão salvos
    }

    // Nova mensagem no chat (talk adicionado ou atualizado)
    for (const talk of [...(body?.talks?.add || []), ...(body?.talks?.update || [])]) {
      const leadId = talk.entity_id || talk.lead_id;
      console.log(`[WEBHOOK] Talk evento | lead ${leadId}`);
      agendarProcessamento(leadId, 3000); // 3s para garantir que mensagem foi gravada
    }
  } catch (err) {
    console.error('[WEBHOOK ERRO]', err.message);
  }
});

// ─── POLLING (fallback para plano sem webhooks) ─────────────────────────────
const jaProcessados = new Set(); // Controla quais leads/estado já foram processados

async function polling() {
  try {
    const trintaMinAtras = Math.floor(Date.now() / 1000) - 1800;
    const cincoMinAtras  = Math.floor(Date.now() / 1000) - 300;

    // Busca leads novos em "Etapa de entrada" (últimos 30 min)
    const r1 = await fetch(
      `${BASE}/leads?filter[pipeline_id]=${PIPELINE_ID}&filter[status_id]=${ETAPA.ENTRADA}&filter[created_at][from]=${trintaMinAtras}&limit=50`,
      { headers: hdrs() }
    );
    if (r1.ok) {
      const d1 = await r1.json();
      for (const lead of d1._embedded?.leads || []) {
        const chave = `${lead.id}-${lead.updated_at}`;
        if (jaProcessados.has(chave)) continue;
        jaProcessados.add(chave);
        console.log(`[POLL] Novo lead na entrada: ${lead.id}`);
        await processarLead(lead.id).catch(e => console.error('[POLL ERRO]', lead.id, e.message));
      }
    }

    // Busca leads atualizados em "Primeiro Contato" (últimos 5 min = cliente respondeu)
    const r2 = await fetch(
      `${BASE}/leads?filter[pipeline_id]=${PIPELINE_ID}&filter[status_id]=${ETAPA.PRIMEIRO_CONTATO}&filter[updated_at][from]=${cincoMinAtras}&limit=50`,
      { headers: hdrs() }
    );
    if (r2.ok) {
      const d2 = await r2.json();
      for (const lead of d2._embedded?.leads || []) {
        const chave = `${lead.id}-${lead.updated_at}`;
        if (jaProcessados.has(chave)) continue;
        jaProcessados.add(chave);
        console.log(`[POLL] Resposta do cliente detectada: lead ${lead.id}`);
        await processarLead(lead.id).catch(e => console.error('[POLL2 ERRO]', lead.id, e.message));
      }
    }

    // Limpa cache para evitar crescimento indefinido
    if (jaProcessados.size > 2000) jaProcessados.clear();
  } catch (err) {
    console.error('[POLLING ERRO]', err.message);
  }
}

setInterval(polling, 45000); // Verifica a cada 45 segundos
console.log('[ANA] Atendente IA iniciada — polling a cada 45 segundos');

// ─── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'atendente-ia-ana',
  pipeline: PIPELINE_ID,
  ia: OPENROUTER_KEY ? 'openrouter:configurado' : 'FALTANDO'
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] Porta ${PORT}`));
