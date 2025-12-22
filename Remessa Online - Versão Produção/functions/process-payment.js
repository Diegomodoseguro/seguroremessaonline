const fetch = require('node-fetch'); 
const { createClient } = require('@supabase/supabase-js');

// --- CREDENCIAIS CORIS (HARDCODED PARA TESTE/PRODUÇÃO IMEDIATA) ---
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = 'MORJ6750';
const CORIS_SENHA = 'diego@';

// --- OUTRAS CREDENCIAIS (Via Env Vars do Netlify) ---
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const EZSIM_USER = process.env.EZSIM_USER;
const EZSIM_PASS = process.env.EZSIM_PASS;

const MODOSEGURO_API_URL = 'https://portalv2.modoseguro.digital/api/ingest';
const TENANT_ID_REMESSA = 'RODQ19';
const EZSIM_API_URL = 'https://beta.ezsimconnect.com'; 
const TARGET_PLAN_NAME = 'eSIM, 2GB, 15 Days, Global, V2';

if (!SUPABASE_URL || !SUPABASE_KEY) console.error("ERRO CRÍTICO: Variáveis Supabase ausentes.");
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper XML com Tipagem (IMPORTANTE)
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, item] of Object.entries(params)) {
        const val = (item.val === null || item.val === undefined) ? '' : String(item.val);
        const type = item.type || 'varchar';
        paramString += `<param name="${key}" type="${type}" value="${val}" />`;
    }
    return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://www.coris.com.br/WebService/">${paramString}</${method}></soap:Body></soap:Envelope>`;
};

const extractTagValue = (xml, tagName) => {
    const match = xml.match(new RegExp(`<${tagName}>(.*?)</${tagName}>`));
    return match ? match[1] : null;
};

// Emissão Coris (Tipada)
async function emitirCoris(leadData) {
    let listaPassageiros = '';
    leadData.passengers.forEach(p => {
        let dataNasc = p.nascimento;
        if (dataNasc.includes('/')) {
            const [d, m, y] = dataNasc.split('/');
            dataNasc = `${y}-${m}-${d}`;
        }
        listaPassageiros += `${p.nome}:${p.sobrenome || ''}:${p.cpf}:${dataNasc}:${p.sexo}|`; 
    });
    listaPassageiros = listaPassageiros.slice(0, -1);

    const gravarParams = {
        'login': { val: CORIS_LOGIN, type: 'varchar' },
        'senha': { val: CORIS_SENHA, type: 'varchar' },
        'idplano': { val: leadData.planId, type: 'int' },
        'saida': { val: leadData.dates.departure, type: 'varchar' },
        'retorno': { val: leadData.dates.return, type: 'varchar' },
        'destino': { val: leadData.destination, type: 'int' },
        'passageiros': { val: listaPassageiros, type: 'varchar' },
        'contato': { val: leadData.comprador.nome, type: 'varchar' },
        'email': { val: leadData.comprador.email, type: 'varchar' },
        'telefone': { val: (leadData.contactPhone || '00000000000').replace(/\D/g, ''), type: 'varchar' },
        'pagamento': { val: 'CARTAO', type: 'varchar' } 
    };

    const gravarRes = await fetch(CORIS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/GravarPedido' },
        body: createSoapEnvelope('GravarPedido', gravarParams) 
    });
    const gravarText = await gravarRes.text();
    const pedidoId = extractTagValue(gravarText, 'idpedido');
    
    if (!pedidoId || pedidoId === '0') throw new Error(`Coris GravarPedido Falhou: ${extractTagValue(gravarText, 'mensagem')}`);

    const emitirParams = { 
        'login': { val: CORIS_LOGIN, type: 'varchar' },
        'senha': { val: CORIS_SENHA, type: 'varchar' },
        'idpedido': { val: pedidoId, type: 'int' }
    };
    const emitirRes = await fetch(CORIS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/EmitirPedido' },
        body: createSoapEnvelope('EmitirPedido', emitirParams)
    });
    const emitirText = await emitirRes.text();
    const linkBilhete = extractTagValue(emitirText, 'linkbilhete') || extractTagValue(emitirText, 'url');
    
    const vouchers = []; 
    const voucherRegex = /<voucher>(.*?)<\/voucher>/g;
    let vMatch;
    while((vMatch = voucherRegex.exec(emitirText)) !== null) { vouchers.push(vMatch[1]); }

    return { voucher: vouchers.join(', '), link: linkBilhete, pedidoId: pedidoId };
}

async function issueEzsimChip(leadId) {
    try {
        const tokenResp = await fetch(`${EZSIM_API_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: EZSIM_USER, password: EZSIM_PASS })
        });
        const authData = await tokenResp.json();
        const token = authData.access_token;
        
        if(!token) return { success: false, error: "Auth falhou" };
        
        const listRes = await fetch(`${EZSIM_API_URL}/rest/v1/price_list?select=*`, {
            method: 'GET', headers: { 'Authorization': `Bearer ${token}` }
        });
        const bundles = await listRes.json();
        const target = bundles.find(b => b.description === TARGET_PLAN_NAME || b.name === TARGET_PLAN_NAME) || bundles[0];
        
        if(!target) return { success: false, error: "Plano não encontrado" };

        const cartRes = await fetch(`${EZSIM_API_URL}/rest/v1/cart`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify({ organization_bundle_id: target.id, quantity: 1, reference: leadId })
        });
        
        const orderRes = await fetch(`${EZSIM_API_URL}/rest/v1/sales_order`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify({ reference: leadId })
        });
        
        return { success: true, data: await orderRes.json() };
    } catch (e) { return { success: false, error: e.message }; }
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const body = JSON.parse(event.body);

    try {
        const amountInCents = Math.round(body.amountBRL * 100);
        const msPayload = {
            tenant_id: TENANT_ID_REMESSA, type: "stripe", cliente: body.comprador,
            enderecos: [body.comprador.endereco],
            pagamento: {
                amount_cents: amountInCents, currency: "brl", descricao: `Seguro Coris - ${body.planName}`,
                receipt_email: body.comprador.email, metadata: { lead_id: body.leadId, origem: "lp_remessa" },
                payment_method_id: body.paymentMethodId 
            },
            passageiros_extra: body.passageiros
        };

        const msResponse = await fetch(`${MODOSEGURO_API_URL}?tenant_id=${TENANT_ID_REMESSA}&topic=venda_stripe&source=api_backend`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msPayload)
        });
        if (!msResponse.ok) throw new Error(`Pagamento Recusado: ${await msResponse.text()}`);
        const msResult = await msResponse.json();

        // Processos paralelos de emissão
        let corisData = { voucher: 'PENDENTE_ERRO', link: '#' };
        try { corisData = await emitirCoris(body); } catch(e) { console.error("Erro Coris", e); }

        let ezsimStatus = 'pendente';
        try { 
            const chip = await issueEzsimChip(body.leadId); 
            ezsimStatus = chip.success ? 'emitido' : 'erro';
        } catch(e) { console.error("Erro Chip", e); }

        await supabaseClient.from('remessaonlinesioux_leads').update({
            status: 'venda_concluida', coris_voucher: corisData.voucher, link_bilhete: corisData.link,
            stripe_payment_intent_id: msResult.stripe?.id || 'processed',
            valor_final_brl: body.amountBRL, plano_escolhido: body.planName, passageiros_info: JSON.stringify(body.passageiros),
            recovery_notes: `Chip: ${ezsimStatus}`
        }).eq('id', body.leadId);

        return { statusCode: 200, body: JSON.stringify({ success: true, link: corisData.link }) };

    } catch (error) {
        console.error(error);
        if (body.leadId) await supabaseClient.from('remessaonlinesioux_leads').update({ status: 'pagamento_falhou', last_error_message: error.message }).eq('id', body.leadId);
        return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }
};
