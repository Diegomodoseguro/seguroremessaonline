const fetch = require('node-fetch'); 
const { createClient } = require('@supabase/supabase-js');

// Configurações
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const EZSIM_USER = process.env.EZSIM_USER;
const EZSIM_PASS = process.env.EZSIM_PASS;
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = process.env.CORIS_LOGIN;
const CORIS_SENHA = process.env.CORIS_SENHA;
const MODOSEGURO_API_URL = 'https://portalv2.modoseguro.digital/api/ingest';
const TENANT_ID_REMESSA = 'RODQ19';
const EZSIM_API_URL = 'https://beta.ezsimconnect.com'; 
const TARGET_PLAN_NAME = 'eSIM, 2GB, 15 Days, Global, V2';

if (!SUPABASE_URL || !SUPABASE_KEY) console.error("ERRO CRÍTICO: Variáveis Supabase ausentes.");

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helpers
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, value] of Object.entries(params)) {
        paramString += `<param name="${key}" value="${value}" />`;
    }
    return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://www.coris.com.br/WebService/">${paramString}</${method}></soap:Body></soap:Envelope>`;
};

const extractTagValue = (xml, tagName) => {
    const match = xml.match(new RegExp(`<${tagName}>(.*?)</${tagName}>`));
    return match ? match[1] : null;
};

// Emissão Coris
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
        'login': CORIS_LOGIN, 'senha': CORIS_SENHA, 'idplano': leadData.planId,
        'saida': leadData.dates.departure, 'retorno': leadData.dates.return, 'destino': leadData.destination,
        'passageiros': listaPassageiros, 'contato': leadData.comprador.nome, 'email': leadData.comprador.email,
        'telefone': (leadData.contactPhone || '00000000000').replace(/\D/g, ''), 'pagamento': 'CARTAO' 
    };

    const gravarRes = await fetch(CORIS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/GravarPedido' },
        body: createSoapEnvelope('GravarPedido', gravarParams) 
    });
    const gravarText = await gravarRes.text();
    const pedidoId = extractTagValue(gravarText, 'idpedido');
    
    if (!pedidoId || pedidoId === '0') throw new Error(`Coris GravarPedido Falhou: ${extractTagValue(gravarText, 'mensagem')}`);

    const emitirParams = { 'login': CORIS_LOGIN, 'senha': CORIS_SENHA, 'idpedido': pedidoId };
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

// Emissão Ezsim
async function getEzsimToken() {
    try {
        const response = await fetch(`${EZSIM_API_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: EZSIM_USER, password: EZSIM_PASS })
        });
        const data = await response.json();
        return data.access_token;
    } catch (error) { return null; }
}

async function issueEzsimChip(leadId) {
    try {
        const token = await getEzsimToken();
        if(!token) return { success: false, error: "Auth falhou" };
        
        // Busca Bundle ID (Hardcoded para performance ou busca dinâmica)
        const bundleResponse = await fetch(`${EZSIM_API_URL}/rest/v1/price_list?select=*`, {
            method: 'GET', headers: { 'Authorization': `Bearer ${token}` }
        });
        const bundles = await bundleResponse.json();
        const target = bundles.find(b => b.description === TARGET_PLAN_NAME || b.name === TARGET_PLAN_NAME) || bundles[0];
        if(!target) return { success: false, error: "Plano não encontrado" };

        const cartRes = await fetch(`${EZSIM_API_URL}/rest/v1/cart`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify({ organization_bundle_id: target.id, quantity: 1, reference: leadId })
        });
        if(!cartRes.ok) throw new Error("Falha carrinho");

        const orderRes = await fetch(`${EZSIM_API_URL}/rest/v1/sales_order`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify({ reference: leadId })
        });
        const orderData = await orderRes.json();
        return { success: true, data: orderData };
    } catch (e) { return { success: false, error: e.message }; }
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const body = JSON.parse(event.body);
    const { paymentMethodId, leadId, planId, amountBRL, comprador, passageiros, planName, dates, destination, contactPhone } = body;

    try {
        // 1. Cobrança ModoSeguro/Stripe
        const amountInCents = Math.round(amountBRL * 100);
        const msPayload = {
            tenant_id: TENANT_ID_REMESSA, type: "stripe", cliente: comprador,
            enderecos: [comprador.endereco],
            pagamento: {
                amount_cents: amountInCents, currency: "brl", descricao: `Seguro Coris - ${planName}`,
                receipt_email: comprador.email, metadata: { lead_id: leadId, origem: "lp_remessa" },
                payment_method_id: paymentMethodId 
            },
            passageiros_extra: passageiros
        };

        const msResponse = await fetch(`${MODOSEGURO_API_URL}?tenant_id=${TENANT_ID_REMESSA}&topic=venda_stripe&source=api_backend`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msPayload)
        });
        
        if (!msResponse.ok) throw new Error(`Pagamento Recusado: ${await msResponse.text()}`);
        const msResult = await msResponse.json();

        // 2. Emissão Coris
        let corisData = { voucher: 'ERRO', link: '#' };
        try {
            corisData = await emitirCoris({ leadId, planId, destination, passengers: passageiros, comprador, contactPhone, dates });
        } catch(e) { console.error("Erro Coris", e); }

        // 3. Emissão Chip
        let ezsimData = { status: 'pendente' };
        try {
            const chip = await issueEzsimChip(leadId);
            ezsimData = chip.success ? { status: 'emitido', details: chip.data } : { status: 'erro', error: chip.error };
        } catch(e) { console.error("Erro Chip", e); }

        // 4. Update Supabase
        await supabaseClient.from('remessaonlinesioux_leads').update({
            status: 'venda_concluida',
            coris_voucher: corisData.voucher,
            coris_pedido_id: corisData.pedidoId,
            link_bilhete: corisData.link,
            stripe_payment_intent_id: msResult.stripe?.id || 'processed',
            valor_final_brl: amountBRL,
            plano_escolhido: planName,
            passageiros_info: JSON.stringify(passageiros),
            recovery_notes: `Chip: ${ezsimData.status}`
        }).eq('id', leadId);

        return { statusCode: 200, body: JSON.stringify({ success: true, link: corisData.link }) };

    } catch (error) {
        console.error(error);
        if (leadId) await supabaseClient.from('remessaonlinesioux_leads').update({ status: 'pagamento_falhou', last_error_message: error.message }).eq('id', leadId);
        return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }
};
