const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
process.stdout.write = process.stdout.write.bind(process.stdout);

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SUBDOMAIN      = 'passoapassouniformes2025';
const KOMMO_TOKEN    = process.env.KOMMO_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const META_TOKEN     = process.env.META_TOKEN;
const META_PHONE_ID  = process.env.META_PHONE_ID;
const META_VERIFY    = process.env.META_VERIFY_TOKEN || 'passoapasso_verify_2025';
const PIPELINE_ID    = 13368211;

const ETAPA = {
  ENTRADA:          103109571,
  PRIMEIRO_CONTATO: 103109831,
  QUALIFICADO:      103109847,
  LEAD_FRIO:        103109843,
};

const BASE = `https://${SUBDOMAIN}.kommo.com/api/v4`;
const hdrs = () => ({ Authorization: `Bearer ${KOMMO_TOKEN}`, 'Content-Type': 'application/json' });

// ─── STATE ───────────────────────────────────────────────────────────────────
const conversas       = new Map(); // phone → [{role, content}]
const msgProcessados  = new Set(); // meta message IDs para evitar duplicata
const jaGreetedLeads  = new Set(); // leadId → para não saudar duas vezes

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
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

// ─── META WHATSAPP API ───────────────────────────────────────────────────────
async function enviarMensagemMeta(to, texto) {
  if (!META_TOKEN || !META_PHONE_ID) {
    console.error('[META] META_TOKEN ou META_PHONE_ID não configurado');
    return false;
  }
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${META_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: texto },
      }),
    });
    const d = await r.json();
    if (!r.ok) {
      console.error(`[META SEND] ${r.status} — ${JSON.stringify(d).substring(0, 300)}`);
      return false;
    }
    console.log(`[META SEND] OK → ${to} | msg_id=${d.messages?.[0]?.id}`);
    return true;
  } catch (err) {
    console.error('[META SEND] Erro:', err.message);
    return false;
  }
}

// ─── KOMMO API ───────────────────────────────────────────────────────────────
async function getLead(leadId) {
  const r = await fetch(`${BASE}/leads/${leadId}?with=contacts`, { headers: hdrs() });
  if (!r.ok) { console.error(`[KOMMO] getLead ${leadId} HTTP ${r.status}`); return null; }
  return r.json();
}

async function moverLead(leadId, statusId) {
  const r = await fetch(`${BASE}/leads/${leadId}`, {
    method: 'PATCH',
    headers: hdrs(),
    body: JSON.stringify({ status_id: statusId }),
  });
  const label = Object.keys(ETAPA).find(k => ETAPA[k] === statusId) || statusId;
  console.log(`[MOVE] Lead ${leadId} → ${label} | HTTP ${r.status}`);
}

async function salvarNota(leadId, texto) {
  const r = await fetch(`${BASE}/leads/${leadId}/notes`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify([{ note_type: 'common', params: { text: texto } }]),
  });
  console.log(`[NOTA] Lead ${leadId} | HTTP ${r.status}`);
}

async function getTelefoneContato(contactId) {
  const r = await fetch(`${BASE}/contacts/${contactId}`, { headers: hdrs() });
  if (!r.ok) return null;
  const d = await r.json();
  const phoneField = (d.custom_fields_values || []).find(f => f.field_code === 'PHONE');
  const raw = phoneField?.values?.[0]?.value || '';
  return raw.replace(/\D/g, ''); // só dígitos
}

async function buscarLeadPorTelefone(phoneRaw) {
  // Normaliza: só dígitos
  const phone = phoneRaw.replace(/\D/g, '');

  // Busca contatos pelo telefone
  const r = await fetch(
    `${BASE}/contacts?query=${encodeURIComponent(phone)}&limit=10&with=leads`,
    { headers: hdrs() }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const contacts = d._embedded?.contacts || [];

  for (const contact of contacts) {
    // Verifica se o telefone bate
    const phoneField = (contact.custom_fields_values || []).find(f => f.field_code === 'PHONE');
    const phones = (phoneField?.values || []).map(v => (v.value || '').replace(/\D/g, ''));
    const match = phones.some(p => p.endsWith(phone.slice(-9)) || phone.endsWith(p.slice(-9)));
    if (!match) continue;

    // Busca leads deste contato no pipeline
    const leads = contact._embedded?.leads || [];
    for (const leadRef of leads) {
      const lead = await getLead(leadRef.id);
      if (!lead) continue;
      if (lead.pipeline_id !== PIPELINE_ID) continue;
      if ([ETAPA.ENTRADA, ETAPA.PRIMEIRO_CONTATO].includes(lead.status_id)) return lead;
    }
  }
  return null;
}

// ─── OPENROUTER IA ───────────────────────────────────────────────────────────
async function consultarIA(historico) {
  if (!OPENROUTER_KEY) { console.error('[IA] OPENROUTER_API_KEY não configurada'); return null; }

  const mensagens = [{ role: 'system', content: SYSTEM_PROMPT }, ...historico];
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'HTTP-Referer': 'https://passoapassouniformes2025.kommo.com',
      'X-Title': 'Atendente IA Ana',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      max_tokens: 600,
      messages: mensagens,
    }),
  });

  if (!r.ok) { console.error('[IA] OpenRouter', r.status, await r.text().catch(() => '')); return null; }

  const d = await r.json();
  const texto = d.choices?.[0]?.message?.content?.trim() || '';

  try { return JSON.parse(texto); } catch {
    const match = texto.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch { } }
    console.error('[IA] JSON inválido:', texto.substring(0, 300));
    return null;
  }
}

// ─── PROCESSAMENTO DE MENSAGEM ────────────────────────────────────────────────
async function processarMensagem(from, texto) {
  console.log(`[PROC] Mensagem de ${from}: "${texto.substring(0, 100)}"`);

  // Histórico em memória
  if (!conversas.has(from)) conversas.set(from, []);
  const historico = conversas.get(from);
  historico.push({ role: 'user', content: texto });
  if (historico.length > 20) historico.splice(0, historico.length - 20);

  // IA
  const resposta = await consultarIA(historico);
  if (!resposta?.mensagem) { console.error(`[IA] Resposta inválida para ${from}`); return; }

  historico.push({ role: 'assistant', content: resposta.mensagem });
  console.log(`[IA] acao=${resposta.acao} | msg="${resposta.mensagem.substring(0, 100)}"`);

  // Envia via Meta
  await enviarMensagemMeta(from, resposta.mensagem);

  // Atualiza Kommo
  const lead = await buscarLeadPorTelefone(from);
  if (!lead) { console.log(`[KOMMO] Nenhum lead ativo encontrado para ${from}`); return; }

  console.log(`[KOMMO] Lead ${lead.id} (status=${lead.status_id})`);

  if (lead.status_id === ETAPA.ENTRADA) {
    await moverLead(lead.id, ETAPA.PRIMEIRO_CONTATO);
  }

  if (resposta.acao === 'qualificado') {
    await moverLead(lead.id, ETAPA.QUALIFICADO);
    const dados = resposta.dados || {};
    const nota = [
      'Qualificado pela Ana (IA) via WhatsApp',
      dados.tipo       ? `Linha: ${dados.tipo}` : '',
      dados.quantidade ? `Quantidade: ${dados.quantidade} peças` : '',
      dados.cor        ? `Cor: ${dados.cor}` : '',
      dados.estampa    ? `Estampa: ${dados.estampa}` : '',
    ].filter(Boolean).join('\n');
    await salvarNota(lead.id, nota);
    console.log(`[QUALIFICADO] Lead ${lead.id} qualificado e movido`);
  }

  if (resposta.acao === 'sem_perfil') {
    await moverLead(lead.id, ETAPA.LEAD_FRIO);
    await salvarNota(lead.id, 'Lead sem perfil (menos de 10 peças) — Lead Frio pela Ana (IA)');
    console.log(`[SEM_PERFIL] Lead ${lead.id} → Lead Frio`);
  }
}

// ─── POLLING — PRIMEIRO CONTATO PROATIVO ─────────────────────────────────────
async function enviarSaudacaoProativa(leadId) {
  if (jaGreetedLeads.has(leadId)) return;

  const lead = await getLead(leadId);
  if (!lead || lead.status_id !== ETAPA.ENTRADA) return;
  if (lead.pipeline_id !== PIPELINE_ID) return;

  // Pega telefone do primeiro contato do lead
  const contactId = lead._embedded?.contacts?.[0]?.id;
  if (!contactId) { console.log(`[SAUDACAO] Lead ${leadId} sem contato`); return; }

  const phone = await getTelefoneContato(contactId);
  if (!phone) { console.log(`[SAUDACAO] Lead ${leadId} sem telefone`); return; }

  console.log(`[SAUDACAO] Lead ${leadId} → phone=${phone}`);
  jaGreetedLeads.add(leadId);

  // Gera saudação via IA (histórico vazio = primeiro contato)
  const resposta = await consultarIA([]);
  if (!resposta?.mensagem) return;

  conversas.set(phone, [{ role: 'assistant', content: resposta.mensagem }]);
  await enviarMensagemMeta(phone, resposta.mensagem);
  await moverLead(leadId, ETAPA.PRIMEIRO_CONTATO);
  await salvarNota(leadId, 'Saudação inicial enviada pela Ana (IA)');
  console.log(`[SAUDACAO] Lead ${leadId} saudado e movido para Primeiro Contato`);
}

// ─── WEBHOOK META ─────────────────────────────────────────────────────────────
// GET: verificação do webhook pela Meta
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY) {
    console.log('[WEBHOOK] Meta webhook verificado');
    return res.send(challenge);
  }
  console.warn('[WEBHOOK] Verificação falhou — token recebido:', token);
  res.sendStatus(403);
});

// POST: mensagens recebidas da Meta
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde imediatamente

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msgs  = value?.messages;
    if (!msgs?.length) return;

    for (const msg of msgs) {
      // Evita processar a mesma mensagem duas vezes
      if (msgProcessados.has(msg.id)) continue;
      msgProcessados.add(msg.id);
      if (msgProcessados.size > 1000) {
        const iter = msgProcessados.values();
        for (let i = 0; i < 200; i++) msgProcessados.delete(iter.next().value);
      }

      const from = msg.from;
      let texto;
      if (msg.type === 'text') {
        texto = msg.text?.body || '';
      } else if (['image', 'document', 'audio', 'video'].includes(msg.type)) {
        texto = `[${msg.type}]`;
      } else {
        continue;
      }

      if (!texto) continue;
      processarMensagem(from, texto).catch(e => console.error('[PROC ERRO]', from, e.message));
    }
  } catch (err) {
    console.error('[WEBHOOK ERRO]', err.message);
  }
});

// ─── POLLING ─────────────────────────────────────────────────────────────────
async function polling() {
  const agora = Math.floor(Date.now() / 1000);
  const duasHorasAtras = agora - 7200;

  try {
    const r = await fetch(
      `${BASE}/leads?filter[pipeline_id]=${PIPELINE_ID}&filter[status_id]=${ETAPA.ENTRADA}&filter[created_at][from]=${duasHorasAtras}&limit=50`,
      { headers: hdrs() }
    );
    if (!r.ok) { console.error(`[POLL] HTTP ${r.status}`); return; }
    const d = await r.json();
    const leads = d._embedded?.leads || [];
    console.log(`[POLL] ${leads.length} leads na entrada`);

    for (const lead of leads) {
      enviarSaudacaoProativa(lead.id).catch(e => console.error('[SAUDACAO ERRO]', lead.id, e.message));
    }
  } catch (err) {
    console.error('[POLL ERRO]', err.message);
  }
}

// ─── ADMIN ENDPOINTS ──────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()) + 's',
    conversas: conversas.size,
    leadsGreetados: jaGreetedLeads.size,
    meta_phone_id: META_PHONE_ID,
    meta_token: META_TOKEN ? 'ok' : 'FALTANDO',
    kommo_token: KOMMO_TOKEN ? 'ok' : 'FALTANDO',
    openrouter: OPENROUTER_KEY ? 'ok' : 'FALTANDO',
    verify_token: META_VERIFY,
  });
});

// Testa envio direto para um número
app.post('/testar/:phone', async (req, res) => {
  const phone = req.params.phone;
  const texto = req.body?.texto || 'Olá! Sou a Ana da PassoaPasso Uniformes. Como posso ajudar?';
  res.json({ ok: true, phone, msg: 'Enviando...' });
  const ok = await enviarMensagemMeta(phone, texto);
  console.log(`[TESTAR] ${phone} enviado=${ok}`);
});

// Simula recebimento de mensagem (para debug)
app.post('/simular/:phone', async (req, res) => {
  const phone = req.params.phone;
  const texto = req.body?.texto || 'Olá';
  res.json({ ok: true, phone, msg: 'Processando...' });
  processarMensagem(phone, texto).catch(e => console.error('[SIMULAR ERRO]', e.message));
});

// Diagnóstico de um lead
app.get('/diagnostico/:leadId', async (req, res) => {
  const lead = await getLead(req.params.leadId).catch(() => null);
  const contactId = lead?._embedded?.contacts?.[0]?.id;
  const phone = contactId ? await getTelefoneContato(contactId).catch(() => null) : null;
  res.json({ lead: lead ? { id: lead.id, status_id: lead.status_id, pipeline_id: lead.pipeline_id } : null, contactId, phone });
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[SERVER] Atendente IA Ana — Meta WhatsApp Cloud API`);
  console.log(`[SERVER] Porta: ${PORT}`);
  console.log(`[CONFIG] META_PHONE_ID: ${META_PHONE_ID || 'FALTANDO'}`);
  console.log(`[CONFIG] META_TOKEN: ${META_TOKEN ? 'configurado' : 'FALTANDO'}`);
  console.log(`[CONFIG] META_VERIFY_TOKEN: ${META_VERIFY}`);
  console.log(`[CONFIG] KOMMO_TOKEN: ${KOMMO_TOKEN ? 'configurado' : 'FALTANDO'}`);
  console.log(`[CONFIG] OPENROUTER_KEY: ${OPENROUTER_KEY ? 'configurado' : 'FALTANDO'}`);
  console.log(`[WEBHOOK] URL para registrar na Meta: https://passoapasso-kommo-webhook-production-145a.up.railway.app/webhook`);

  // Polling a cada 60s
  polling().catch(console.error);
  setInterval(() => polling().catch(console.error), 60_000);
});
