const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Força stdout sem buffer para logs aparecerem imediatamente no Railway
process.stdout.write = process.stdout.write.bind(process.stdout);

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SUBDOMAIN      = 'passoapassouniformes2025';
const TOKEN          = process.env.KOMMO_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const PIPELINE_ID    = 13368211;
const BOT_USER_ID    = 14977039;

const ETAPA = {
  ENTRADA:          103109571,
  PRIMEIRO_CONTATO: 103109831,
  QUALIFICADO:      103109847,
  LEAD_FRIO:        103109843,
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
- Nunca fale sobre preços, valores ou prazos de entrega — isso é papel do vendedor.
- Seu objetivo é coletar: o que procuram, quantidade, cor do tecido e as estampas/artes.
- Pedido mínimo: 10 peças. Se quantidade < 10, use ação "sem_perfil" com mensagem gentil.
- Quando tiver tipo + quantidade (≥10) + cor + estampa solicitada: use ação "qualificado".
- Após qualificar: avise que um de nossos vendedores vai entrar em contato em breve.

RESPONDA SEMPRE EM JSON PURO (sem markdown, sem blocos de código):
{
  "mensagem": "texto da resposta para o cliente",
  "acao": "continuar" | "qualificado" | "sem_perfil",
  "dados": {
    "tipo": "empresarial" | "fitness" | "formandos" | "futebol" | "inverno" | null,
    "quantidade": numero_inteiro_ou_null,
    "cor": "descrição da cor ou null",
    "estampa": "descricao da estampa/arte ou null"
  }
}

FLUXO SUGERIDO:
1. Saudação calorosa + perguntar o que o cliente procura
2. Identificar o tipo de uniforme
3. Perguntar a quantidade de peças (se <10 → sem_perfil com mensagem gentil)
4. Perguntar a cor do tecido desejada
5. Pedir para o cliente enviar fotos ou imagens das estampas/artes que quer aplicar
6. Quando tiver tipo + quantidade (≥10) + cor + estampa → usar ação "qualificado" e avisar que um vendedor vai entrar em contato
`.trim();

// ─── FUNÇÕES DA API KOMMO ───────────────────────────────────────────────────
async function getLead(leadId) {
  const r = await fetch(`${BASE}/leads/${leadId}`, { headers: hdrs() });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error(`[KOMMO] getLead ${leadId} HTTP ${r.status} — ${body.substring(0, 200)}`);
    return null;
  }
  return r.json();
}

async function getTalkByLead(leadId) {
  // Tenta endpoint de chats/talks vinculados ao lead
  const r = await fetch(`${BASE}/talks?filter[entity_id]=${leadId}&filter[entity_type]=lead&limit=1`, { headers: hdrs() });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error(`[KOMMO] getTalk lead ${leadId} HTTP ${r.status} — ${body.substring(0, 200)}`);
    return null;
  }
  const d = await r.json();
  const talk = d._embedded?.talks?.[0] || null;
  if (!talk) console.log(`[KOMMO] Nenhum talk encontrado para lead ${leadId}`);
  return talk;
}

async function getMensagens(talkId) {
  const r = await fetch(`${BASE}/talks/${talkId}/messages?limit=20`, { headers: hdrs() });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error(`[KOMMO] getMensagens talk ${talkId} HTTP ${r.status} — ${body.substring(0, 200)}`);
    return [];
  }
  const d = await r.json();
  return d._embedded?.messages || [];
}

async function enviarMensagem(talkId, texto) {
  const payload = { text: texto, author_id: BOT_USER_ID };
  const r = await fetch(`${BASE}/talks/${talkId}/messages`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify(payload)
  });

  if (r.ok) return true;

  const errBody = await r.text().catch(() => '');
  console.error(`[SEND] talk ${talkId} HTTP ${r.status} — ${errBody.substring(0, 300)}`);
  return false;
}

async function moverLead(leadId, statusId) {
  const r = await fetch(`${BASE}/leads/${leadId}`, {
    method: 'PATCH',
    headers: hdrs(),
    body: JSON.stringify({ status_id: statusId })
  });
  const label = Object.keys(ETAPA).find(k => ETAPA[k] === statusId) || statusId;
  console.log(`[MOVE] Lead ${leadId} → ${label} | HTTP ${r.status}`);
}

async function salvarNota(leadId, texto) {
  const r = await fetch(`${BASE}/leads/${leadId}/notes`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify([{ note_type: 'common', params: { text: texto } }])
  });
  console.log(`[NOTA] Lead ${leadId} | HTTP ${r.status}`);
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
  console.log(`[PROC] Iniciando lead ${leadId}`);
  const lead = await getLead(leadId);
  if (!lead) return;

  console.log(`[PROC] Lead ${leadId} | status_id=${lead.status_id} | pipeline=${lead.pipeline_id}`);

  if (![ETAPA.ENTRADA, ETAPA.PRIMEIRO_CONTATO].includes(lead.status_id)) {
    console.log(`[SKIP] Lead ${leadId} — etapa ${lead.status_id} não monitorada`);
    return;
  }

  const talk = await getTalkByLead(leadId);
  if (!talk) {
    console.log(`[SKIP] Lead ${leadId} — sem conversa WhatsApp vinculada`);
    return;
  }

  console.log(`[PROC] Talk encontrado: ${talk.talk_id}`);

  const mensagens = await getMensagens(talk.talk_id);
  console.log(`[PROC] Mensagens encontradas: ${mensagens.length}`);
  if (!mensagens.length) return;

  const ultima = mensagens[mensagens.length - 1];
  console.log(`[PROC] Última msg author_type=${ultima.author_type} | text="${(ultima.text || '').substring(0, 60)}"`);

  if (ultima.author_type !== 'contact') {
    console.log(`[SKIP] Lead ${leadId} — última mensagem já é do bot`);
    return;
  }

  const historico = mensagens.slice(-10).map(m => ({
    role: m.author_type === 'contact' ? 'user' : 'assistant',
    content: m.text || '[mensagem de mídia]'
  }));

  console.log(`[IA] Consultando IA para lead ${leadId} | ${historico.length} msgs`);
  const resposta = await consultarIA(historico);

  if (!resposta?.mensagem) {
    console.error(`[IA] Resposta inválida para lead ${leadId}`);
    return;
  }

  console.log(`[IA] Resposta: acao=${resposta.acao} | msg="${resposta.mensagem.substring(0, 80)}"`);

  const enviado = await enviarMensagem(talk.talk_id, resposta.mensagem);
  console.log(`[SEND] Lead ${leadId} | enviado=${enviado}`);

  if (lead.status_id === ETAPA.ENTRADA) {
    await moverLead(leadId, ETAPA.PRIMEIRO_CONTATO);
  }

  if (resposta.acao === 'qualificado') {
    await moverLead(leadId, ETAPA.QUALIFICADO);
    const dados = resposta.dados || {};
    const nota = [
      'Qualificado pela Ana (IA)',
      dados.tipo       ? `Linha: ${dados.tipo}`              : '',
      dados.quantidade ? `Quantidade: ${dados.quantidade} peças` : '',
      dados.cor        ? `Cor: ${dados.cor}`                 : '',
      dados.estampa    ? `Estampa: ${dados.estampa}`         : '',
    ].filter(Boolean).join('\n');
    await salvarNota(leadId, nota);
    console.log(`[QUALIFICADO] Lead ${leadId} qualificado`);
  }

  if (resposta.acao === 'sem_perfil') {
    await moverLead(leadId, ETAPA.LEAD_FRIO);
    await salvarNota(leadId, 'Lead sem perfil (menos de 10 peças) — movido para Lead Frio pela Ana (IA)');
    console.log(`[SEM_PERFIL] Lead ${leadId} → Lead Frio`);
  }
}

// ─── WEBHOOK ────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  try {
    const body = req.body;
    console.log('[WEBHOOK]', JSON.stringify(body).substring(0, 400));
    const agendar = (leadId, delay = 0) => {
      if (!leadId) return;
      const fn = () => processarLead(leadId).catch(e => console.error('[ERRO]', leadId, e.message));
      if (delay) setTimeout(fn, delay); else fn();
    };
    for (const lead of body?.leads?.add || []) {
      if (Number(lead.pipeline_id) !== PIPELINE_ID) continue;
      agendar(lead.id, 2000);
    }
    for (const talk of [...(body?.talks?.add || []), ...(body?.talks?.update || [])]) {
      agendar(talk.entity_id || talk.lead_id, 3000);
    }
  } catch (err) {
    console.error('[WEBHOOK ERRO]', err.message);
  }
});

// ─── POLLING ────────────────────────────────────────────────────────────────
const jaProcessados = new Set();

async function polling() {
  const agora = Math.floor(Date.now() / 1000);
  const duasHorasAtras = agora - 7200;   // janela maior: 2h para ENTRADA
  const quinzeMinAtras = agora - 900;    // 15 min para PRIMEIRO_CONTATO

  try {
    // Leads novos na entrada (últimas 2h)
    const r1 = await fetch(
      `${BASE}/leads?filter[pipeline_id]=${PIPELINE_ID}&filter[status_id]=${ETAPA.ENTRADA}&filter[created_at][from]=${duasHorasAtras}&limit=50`,
      { headers: hdrs() }
    );
    if (r1.ok) {
      const d1 = await r1.json();
      const leads = d1._embedded?.leads || [];
      console.log(`[POLL] Entrada: ${leads.length} leads encontrados`);
      for (const lead of leads) {
        const chave = `${lead.id}-${lead.updated_at}`;
        if (jaProcessados.has(chave)) continue;
        jaProcessados.add(chave);
        console.log(`[POLL] Processando lead ${lead.id} (entrada)`);
        await processarLead(lead.id).catch(e => console.error('[POLL ERRO]', lead.id, e.message));
      }
    } else {
      const err = await r1.text().catch(() => '');
      console.error(`[POLL] Erro buscando entrada: HTTP ${r1.status} — ${err.substring(0, 200)}`);
    }

    // Leads em Primeiro Contato atualizados (últimos 15 min)
    const r2 = await fetch(
      `${BASE}/leads?filter[pipeline_id]=${PIPELINE_ID}&filter[status_id]=${ETAPA.PRIMEIRO_CONTATO}&filter[updated_at][from]=${quinzeMinAtras}&limit=50`,
      { headers: hdrs() }
    );
    if (r2.ok) {
      const d2 = await r2.json();
      const leads = d2._embedded?.leads || [];
      console.log(`[POLL] Primeiro Contato: ${leads.length} leads encontrados`);
      for (const lead of leads) {
        const chave = `${lead.id}-${lead.updated_at}`;
        if (jaProcessados.has(chave)) continue;
        jaProcessados.add(chave);
        console.log(`[POLL] Processando lead ${lead.id} (primeiro contato)`);
        await processarLead(lead.id).catch(e => console.error('[POLL2 ERRO]', lead.id, e.message));
      }
    } else {
      const err = await r2.text().catch(() => '');
      console.error(`[POLL] Erro buscando primeiro contato: HTTP ${r2.status} — ${err.substring(0, 200)}`);
    }

    if (jaProcessados.size > 2000) jaProcessados.clear();
  } catch (err) {
    console.error('[POLLING ERRO]', err.message);
  }
}

setInterval(polling, 45000);
polling(); // Roda imediatamente ao iniciar

// ─── DIAGNÓSTICO ─────────────────────────────────────────────────────────────
app.get('/diagnostico/:leadId', async (req, res) => {
  const leadId = req.params.leadId;
  const resultado = { leadId, etapas: {} };

  // 1. Busca o lead
  const r1 = await fetch(`${BASE}/leads/${leadId}`, { headers: hdrs() });
  resultado.etapas.getLead = { status: r1.status };
  if (r1.ok) {
    const lead = await r1.json();
    resultado.etapas.getLead.dados = { status_id: lead.status_id, pipeline_id: lead.pipeline_id, name: lead.name };
  } else {
    resultado.etapas.getLead.erro = await r1.text().catch(() => '');
  }

  // 2. Busca o talk
  const r2 = await fetch(`${BASE}/talks?filter[entity_id]=${leadId}&filter[entity_type]=lead&limit=1`, { headers: hdrs() });
  resultado.etapas.getTalk = { status: r2.status };
  if (r2.ok) {
    const d = await r2.json();
    const talk = d._embedded?.talks?.[0];
    resultado.etapas.getTalk.talk = talk || null;

    if (talk) {
      // 3. Busca mensagens
      const r3 = await fetch(`${BASE}/talks/${talk.talk_id}/messages?limit=5`, { headers: hdrs() });
      resultado.etapas.getMensagens = { status: r3.status };
      if (r3.ok) {
        const d3 = await r3.json();
        const msgs = d3._embedded?.messages || [];
        resultado.etapas.getMensagens.total = msgs.length;
        resultado.etapas.getMensagens.ultima = msgs[msgs.length - 1] ? {
          author_type: msgs[msgs.length - 1].author_type,
          text: (msgs[msgs.length - 1].text || '').substring(0, 100)
        } : null;
      } else {
        resultado.etapas.getMensagens.erro = await r3.text().catch(() => '');
      }
    }
  } else {
    resultado.etapas.getTalk.erro = await r2.text().catch(() => '');
  }

  res.json(resultado);
});

// Processa um lead manualmente via POST
app.post('/processar/:leadId', async (req, res) => {
  const leadId = req.params.leadId;
  console.log(`[MANUAL] Processando lead ${leadId}`);
  // Remove do cache para forçar reprocessamento
  for (const chave of jaProcessados) {
    if (chave.startsWith(leadId + '-')) jaProcessados.delete(chave);
  }
  processarLead(leadId).catch(e => console.error('[MANUAL ERRO]', e.message));
  res.json({ ok: true, leadId, msg: 'Processamento iniciado — veja os logs' });
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'atendente-ia-ana',
  pipeline: PIPELINE_ID,
  etapas: ETAPA,
  ia: OPENROUTER_KEY ? 'openrouter:configurado' : 'FALTANDO',
  token: TOKEN ? 'configurado' : 'FALTANDO'
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Porta ${PORT}`);
  console.log(`[ANA] Atendente IA iniciada — polling a cada 45s`);
  console.log(`[CONFIG] Pipeline=${PIPELINE_ID} | Token=${TOKEN ? 'OK' : 'FALTANDO'} | IA=${OPENROUTER_KEY ? 'OK' : 'FALTANDO'}`);
});
