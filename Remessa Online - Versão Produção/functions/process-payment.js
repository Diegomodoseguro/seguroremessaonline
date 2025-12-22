const fetch = require('node-fetch'); 
const { createClient } = require('@supabase/supabase-js');

// Configs
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const EZSIM_USER = process.env.EZSIM_USER;
const EZSIM_PASS = process.env.EZSIM_PASS;
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = 'MORJ6750';
const CORIS_SENHA = 'diego@';
const MODOSEGURO_API_URL = 'https://portalv2.modoseguro.digital/api/ingest';
const TENANT_ID_REMESSA = 'RODQ19';
const EZSIM_API_URL = 'https://beta.ezsimconnect.com'; 
const TARGET_PLAN_NAME = 'eSIM, 2GB, 15 Days, Global, V2';

if (!SUPABASE_URL || !SUPABASE_KEY) console.error("ERRO: Variáveis Supabase ausentes.");
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper XML Idêntico ao Proxy (Com quebras de linha)
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, item] of Object.entries(params)) {
        const val = (item.val === null || item.val === undefined) ? '' : String(item.val);
        const type = item.type || 'varchar';
        paramString += `<param name='${key}' type='${type}' value='${val}' />\n`;
    }
    return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
<soapenv:Header/>
<soapenv:Body>
<tem:${method}>
<tem:strXML>
<![CDATA[
<execute>
${paramString}</execute>
]]>
</tem:strXML>
</tem:${method}>
</soapenv:Body>
</soapenv:Envelope>`;
};

const extractTagValue = (xml, tagName) => {
    const match = xml.match(new RegExp(`<${tagName}>(.*?)</${tagName}>`));
    return match ? match[1] : null;
};

async function emitirCoris(leadData) {
    const pax1 = leadData.passengers[0];
    let dataNasc = pax1.nascimento;
    if (dataNasc.includes('/')) {
        const [d, m, y] = dataNasc.split('/');
        dataNasc = `${y}-${m}-${d}`; 
    }

    const insereParams = {
        'login': { val: CORIS_LOGIN, type: 'varchar' },
        'senha': { val: CORIS_SENHA, type: 'varchar' },
        'idplano': { val: leadData.planId, type: 'int' },
        'qtdpaxes': { val: leadData.passengers.length, type: 'int' },
        'familiar': { val: 'N', type: 'char' },
        'inicioviagem': { val: leadData.dates.departure.replace(/-/g, '/'), type: 'varchar' },
        'fimviagem': { val: leadData.dates.return.replace(/-/g, '/'), type: 'varchar' },
        'destino': { val: leadData.destination, type: 'int' },
        'nome': { val: pax1.nome.split(' ')[0], type: 'varchar' },
        'sobrenome': { val: pax1.nome.split(' ').slice(1).join(' '), type: 'varchar' },
        'sexo': { val: pax1.sexo || 'M', type: 'char' },
        'dtnascimento': { val: dataNasc, type: 'varchar' },
        'documento': { val: pax1.cpf.replace(/\D/g,''), type: 'varchar' },
        'tipodoc': { val: 'CPF', type: 'varchar' },
        'file': { val: leadData.leadId, type: 'varchar' },
        'endereco': { val: leadData.comprador.endereco.logradouro, type: 'varchar' },
        'telefone': { val: leadData.contactPhone.replace(/\D/g,''), type: 'varchar' },
        'cidade': { val: leadData.comprador.endereco.cidade, type: 'varchar' },
        'uf': { val: leadData.comprador.endereco.uf, type: 'char' },
        'cep': { val: leadData.comprador.endereco.cep.replace(/\D/g,''), type: 'varchar' },
        'contatonome': { val: leadData.contactName, type: 'varchar' },
        'contatofone': { val: leadData.contactPhone.replace(/\D/g,''), type: 'varchar' },
        'contatoendereco': { val: leadData.comprador.endereco.logradouro, type: 'varchar' },
        'formapagamento': { val: 'FA', type: 'varchar' }, 
        'processo': { val: 0, type: 'int' },
        'meio': { val: 0, type: 'int' },
        'email': { val: leadData.comprador.email, type: 'varchar' },
        'angola': { val: 'N', type: 'char' },
        'furtoelet': { val: 0, type: 'int' },
        'bagagens': { val: 0, type: 'int' },
        'morteac': { val: 0, type: 'int' },
        'mortenat': { val: 0, type: 'int' },
        'cancplus': { val: 0, type: 'int' },
        'cancany': { val: 0, type: 'int' },
        'codigofree': { val: '', type: 'varchar' },
        'valorvenda': { val: '00.00', type: 'float' },
        'categoria': { val: 1, type: 'int' }, 
        'danosmala': { val: 0, type: 'int' },
        'dataitemviagem': { val: '', type: 'varchar' },
        'bairro': { val: leadData.comprador.endereco.bairro, type: 'varchar' },
        'numero': { val: leadData.comprador.endereco.numero, type: 'varchar' },
        'endcomplemento': { val: '', type: 'varchar' },
        'vouchercredito': { val: '', type: 'varchar' },
        'pet': { val: 0, type: 'int' },
        'p1': { val: '', type: 'varchar' },
        'p2': { val: '', type: 'varchar' },
        'p3': { val: '', type: 'varchar' },
        'pais_origem_passaporte': { val: '', type: 'varchar' },
        'paisEndereco': { val: '', type: 'varchar' }
    };

    const method = leadData.passengers.length > 1 ? 'InsereVoucherFamiliarV13' : 'InsereVoucherIndividualV13';

    const res = await fetch(CORIS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `http://tempuri.org/${method}` },
        body: createSoapEnvelope(method, insereParams)
    });

    const text = await res.text();
    const erro = extractTagValue(text, 'erro');
    if (erro && erro !== '0' && erro !== 'OK') {
        throw new Error(`Coris Emissão Falhou: ${extractTagValue(text, 'mensagem') || 'Erro desconhecido'}`);
    }

    const voucher = extractTagValue(text, 'voucher');
    const linkBilhete = `https://evoucher.coris.com.br/evoucher/chubb/bilhete_chubb_assistencia_v1.asp?voucher=${voucher}`;
    return { voucher: voucher || 'EMITIDO', link: linkBilhete, pedidoId: 'N/A' };
}

async function issueEzsimChip(leadId) {
    try {
        const authRes = await fetch(`${EZSIM_API_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: EZSIM_USER, password: EZSIM_PASS })
        });
        const authData = await authRes.json();
        const token = authData.access_token;
        if(!token) return { success: false, error: "Auth falhou" };
        
        const listRes = await fetch(`${EZSIM_API_URL}/rest/v1/price_list?select=*`, {
            method: 'GET', headers: { 'Authorization': `Bearer ${token}` }
        });
        const bundles = await listRes.json();
        const target = bundles.find(b => b.description === TARGET_PLAN_NAME || b.name === TARGET_PLAN_NAME) || bundles[0];
        
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

        // Processos paralelos
        let corisData = { voucher: 'PENDENTE', link: '#' };
        try { corisData = await emitirCoris(body); } catch(e) { console.error("Erro Coris Emissão", e); }

        let ezsimData = { status: 'pendente' };
        try { 
            const chip = await issueEzsimChip(body.leadId); 
            ezsimData = chip.success ? { status: 'emitido' } : { status: 'erro' };
        } catch(e) { console.error("Erro Chip", e); }

        await supabaseClient.from('remessaonlinesioux_leads').update({
            status: 'venda_concluida', coris_voucher: corisData.voucher, link_bilhete: corisData.link,
            stripe_payment_intent_id: msResult.stripe?.id || 'processed',
            valor_final_brl: body.amountBRL, plano_escolhido: body.planName, passageiros_info: JSON.stringify(body.passageiros),
            recovery_notes: `Chip: ${ezsimData.status}`
        }).eq('id', body.leadId);

        return { statusCode: 200, body: JSON.stringify({ success: true, link: corisData.link }) };

    } catch (error) {
        if (body.leadId) await supabaseClient.from('remessaonlinesioux_leads').update({ status: 'pagamento_falhou', last_error_message: error.message }).eq('id', body.leadId);
        return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }
};
