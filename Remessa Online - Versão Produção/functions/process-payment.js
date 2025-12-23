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

// Inicializa Supabase
const supabaseClient = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Helper XML SOAP + CDATA Rígido (\r\n) - Validado no Postman
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, item] of Object.entries(params)) {
        const val = (item.val === null || item.val === undefined) ? '' : String(item.val);
        const type = item.type || 'varchar';
        paramString += `<param name='${key}' type='${type}' value='${val}' />\r\n`;
    }
    // IMPORTANTE: Manter exatamente esta estrutura de CDATA e quebras de linha
    return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv='http://schemas.xmlsoap.org/soap/envelope/' xmlns:tem='http://tempuri.org/'>
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

// Emissão Coris
async function emitirCoris(leadData) {
    const pax1 = leadData.passengers[0];
    let dataNasc = pax1.nascimento;
    
    // Garante formato YYYY-MM-DD ou YYYY/MM/DD para a Coris
    if (dataNasc.includes('/')) {
        const parts = dataNasc.split('/');
        if(parts[0].length === 2) { // DD/MM/YYYY -> YYYY/MM/DD
             dataNasc = `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
    } else if (dataNasc.includes('-')) {
        dataNasc = dataNasc.replace(/-/g, '/');
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
        'sobrenome': { val: pax1.nome.split(' ').slice(1).join(' ') || '.', type: 'varchar' },
        'sexo': { val: pax1.sexo || 'M', type: 'char' },
        'dtnascimento': { val: dataNasc, type: 'varchar' },
        'documento': { val: pax1.cpf.replace(/\D/g,''), type: 'varchar' },
        'tipodoc': { val: 'CPF', type: 'varchar' },
        'file': { val: leadData.leadId || 'site', type: 'varchar' },
        'endereco': { val: leadData.comprador.endereco.logradouro, type: 'varchar' },
        'telefone': { val: (leadData.contactPhone || '11999999999').replace(/\D/g,''), type: 'varchar' },
        'cidade': { val: leadData.comprador.endereco.cidade || 'Sao Paulo', type: 'varchar' },
        'uf': { val: leadData.comprador.endereco.uf || 'SP', type: 'char' },
        'cep': { val: leadData.comprador.endereco.cep.replace(/\D/g,''), type: 'varchar' },
        'contatonome': { val: leadData.contactName || leadData.comprador.nome, type: 'varchar' },
        'contatofone': { val: (leadData.contactPhone || '11999999999').replace(/\D/g,''), type: 'varchar' },
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
        'bairro': { val: leadData.comprador.endereco.bairro || 'Centro', type: 'varchar' },
        'numero': { val: leadData.comprador.endereco.numero || '0', type: 'varchar' },
        'endcomplemento': { val: '', type: 'varchar' },
        'vouchercredito': { val: '0', type: 'varchar' },
        'pet': { val: 0, type: 'int' },
        'p1': { val: '0', type: 'varchar' },
        'p2': { val: '0', type: 'varchar' },
        'p3': { val: '0', type: 'varchar' },
        'pais_origem_passaporte': { val: '', type: 'varchar' },
        'paisEndereco': { val: '', type: 'varchar' }
    };

    // Ajuste para método Familiar (Adiciona pax extras se houver)
    if (leadData.passengers.length > 1) {
        leadData.passengers.forEach((pax, index) => {
            const i = index + 1;
            let dn = pax.nascimento;
            if (dn.includes('/')) {
                const [d, m, y] = dn.split('/');
                dn = `${y}/${m}/${d}`;
            } else {
                dn = dn.replace(/-/g, '/');
            }
            
            insereParams[`nome${i}`] = { val: pax.nome.split(' ')[0], type: 'varchar' };
            insereParams[`sobrenome${i}`] = { val: pax.nome.split(' ').slice(1).join(' ') || '.', type: 'varchar' };
            insereParams[`sexo${i}`] = { val: pax.sexo || 'M', type: 'char' };
            insereParams[`dtnascimento${i}`] = { val: dn, type: 'varchar' };
            insereParams[`documento${i}`] = { val: pax.cpf.replace(/\D/g,''), type: 'varchar' };
            insereParams[`tipodoc${i}`] = { val: 'CPF', type: 'varchar' };
            insereParams[`endereco${i}`] = { val: leadData.comprador.endereco.logradouro, type: 'varchar' };
            insereParams[`telefone${i}`] = { val: '11999999999', type: 'varchar' };
            insereParams[`cidade${i}`] = { val: leadData.comprador.endereco.cidade || 'Sao Paulo', type: 'varchar' };
            insereParams[`uf${i}`] = { val: leadData.comprador.endereco.uf || 'SP', type: 'char' };
            insereParams[`cep${i}`] = { val: leadData.comprador.endereco.cep.replace(/\D/g,''), type: 'varchar' };
            insereParams[`bairro${i}`] = { val: 'Centro', type: 'varchar' };
            insereParams[`numero${i}`] = { val: '0', type: 'varchar' };
            insereParams[`endcomplemento${i}`] = { val: '', type: 'varchar' };
            insereParams[`voucherCreditoPax${i}`] = { val: '', type: 'varchar' };
        });
    }

    const method = leadData.passengers.length > 1 ? 'InsereVoucherFamiliarV13' : 'InsereVoucherIndividualV13';

    const res = await fetch(CORIS_URL, {
        method: 'POST',
        headers: { 
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': `http://tempuri.org/${method}` // Header SOAPAction é crucial para .asmx
        },
        body: createSoapEnvelope(method, insereParams)
    });

    const text = await res.text();
    const erro = extractTagValue(text, 'erro');
    
    // Tratamento de erro específico da Coris
    if (erro && erro !== '0' && erro !== 'OK') {
        const msg = extractTagValue(text, 'mensagem') || 'Erro desconhecido na Coris';
        throw new Error(`Coris Recusou: ${msg} (Cód: ${erro})`);
    }

    const voucher = extractTagValue(text, 'voucher');
    const linkBilhete = `https://evoucher.coris.com.br/evoucher/chubb/bilhete_chubb_assistencia_v1.asp?voucher=${voucher}`;

    return { voucher: voucher || 'EMITIDO_SEM_NUMERO', link: linkBilhete, pedidoId: 'N/A' };
}

// Emissão Chip (eSIM)
async function issueEzsimChip(leadId) {
    if (!EZSIM_USER || !EZSIM_PASS) return { success: false, error: "Credenciais EzSim não configuradas" };
    
    try {
        const authRes = await fetch(`${EZSIM_API_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: EZSIM_USER, password: EZSIM_PASS })
        });
        const authData = await authRes.json();
        const token = authData.access_token;
        if(!token) return { success: false, error: "Auth EzSim falhou" };
        
        const listRes = await fetch(`${EZSIM_API_URL}/rest/v1/price_list?select=*`, {
            method: 'GET', headers: { 'Authorization': `Bearer ${token}` }
        });
        const bundles = await listRes.json();
        const target = bundles.find(b => b.description === TARGET_PLAN_NAME || b.name === TARGET_PLAN_NAME) || bundles[0];
        
        if (!target) return { success: false, error: "Plano eSIM não encontrado" };

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
    // Headers CORS para permitir chamadas do front
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };
    
    const body = JSON.parse(event.body);

    try {
        // 1. Processar Pagamento (Via API ModoSeguro/Stripe)
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
        
        if (!msResponse.ok) {
            const errorText = await msResponse.text();
            throw new Error(`Pagamento Recusado: ${errorText}`);
        }
        
        const msResult = await msResponse.json();

        // 2. Processos de Emissão (Paralelos)
        let corisData = { voucher: 'PENDENTE', link: '#' };
        let erroCoris = null;
        
        try { 
            corisData = await emitirCoris(body); 
        } catch(e) { 
            console.error("Erro Coris Emissão", e); 
            erroCoris = e.message;
        }

        let ezsimData = { status: 'pendente' };
        try { 
            const chip = await issueEzsimChip(body.leadId); 
            ezsimData = chip.success ? { status: 'emitido' } : { status: 'erro', detail: chip.error };
        } catch(e) { console.error("Erro Chip", e); }

        // 3. Atualizar Lead no Supabase
        if (supabaseClient && body.leadId) {
            await supabaseClient.from('remessaonlinesioux_leads').update({
                status: 'venda_concluida', 
                coris_voucher: corisData.voucher, 
                link_bilhete: corisData.link,
                stripe_payment_intent_id: msResult.stripe?.id || 'processed',
                valor_final_brl: body.amountBRL, 
                plano_escolhido: body.planName, 
                passageiros_info: JSON.stringify(body.passageiros),
                recovery_notes: `CorisErr: ${erroCoris || 'N'} | Chip: ${ezsimData.status}`
            }).eq('id', body.leadId);
        }

        if (erroCoris) {
            // Pagamento passou, mas emissão falhou. Retornar sucesso parcial ou erro tratado?
            // Melhor retornar sucesso do pagamento e avisar que o voucher será enviado por email.
            return { 
                statusCode: 200, 
                headers,
                body: JSON.stringify({ 
                    success: true, 
                    warning: "Pagamento aprovado, mas houve um atraso na emissão do voucher. Nossa equipe processará manualmente.",
                    voucher: "EM PROCESSAMENTO",
                    link: "#"
                }) 
            };
        }

        return { statusCode: 200, headers, body: JSON.stringify({ success: true, voucher: corisData.voucher, link: corisData.link }) };

    } catch (error) {
        if (supabaseClient && body.leadId) {
            await supabaseClient.from('remessaonlinesioux_leads').update({ 
                status: 'pagamento_falhou', 
                last_error_message: error.message 
            }).eq('id', body.leadId);
        }
        return { statusCode: 400, headers, body: JSON.stringify({ error: error.message }) };
    }
};
