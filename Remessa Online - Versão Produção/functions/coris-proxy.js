const fetch = require('node-fetch');

// --- CREDENCIAIS ---
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = 'MORJ6750';
const CORIS_SENHA = 'diego@';

// Helper: Cria o Envelope SOAP EXATO (Padrão Postman Validado)
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, item] of Object.entries(params)) {
        const val = (item.val === null || item.val === undefined) ? '' : String(item.val);
        const type = item.type || 'varchar';
        paramString += `<param name="${key}" type="${type}" value="${val}" />`;
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${method} xmlns="http://tempuri.org/">
      <strXML><![CDATA[<execute>${paramString}</execute>]]></strXML>
    </${method}>
  </soap:Body>
</soap:Envelope>`;
};

const extractTagValue = (xml, tagName) => {
    const match = xml.match(new RegExp(`<${tagName}>(.*?)</${tagName}>`));
    return match ? match[1] : null;
};

exports.handler = async (event) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    try {
        const body = JSON.parse(event.body);
        
        // Determina se é familiar ou individual
        const isFamiliar = body.passengers.length > 1;
        const method = isFamiliar ? 'InsereVoucherFamiliarV13' : 'InsereVoucherIndividualV13';
        
        // Parâmetros Base (Comuns)
        const params = {
            'login': { val: CORIS_LOGIN, type: 'varchar' },
            'senha': { val: CORIS_SENHA, type: 'varchar' },
            'idplano': { val: body.planId, type: 'int' },
            'qtdpaxes': { val: body.passengers.length, type: 'int' },
            'familiar': { val: 'N', type: 'char' },
            // Datas formatadas YYYY/MM/DD
            'inicioviagem': { val: body.dates.departure.replace(/-/g, '/'), type: 'varchar' },
            'fimviagem': { val: body.dates.return.replace(/-/g, '/'), type: 'varchar' },
            'destino': { val: body.destination, type: 'int' },
            'formapagamento': { val: 'FA', type: 'varchar' },
            'email': { val: body.comprador.email, type: 'varchar' },
            // Campos obrigatórios fixos
            'processo': { val: 0, type: 'int' }, 'meio': { val: 0, type: 'int' }, 'angola': { val: 'N', type: 'char' },
            'furtoelet': { val: 0, type: 'int' }, 'bagagens': { val: 0, type: 'int' }, 'morteac': { val: 0, type: 'int' },
            'mortenat': { val: 0, type: 'int' }, 'cancplus': { val: 0, type: 'int' }, 'cancany': { val: 0, type: 'int' },
            'codigofree': { val: '', type: 'varchar' }, 'valorvenda': { val: '00.00', type: 'float' },
            'categoria': { val: 1, type: 'int' }, 'danosmala': { val: 0, type: 'int' }, 'pet': { val: 0, type: 'int' },
            'p1': { val: '0', type: 'varchar' }, 'p2': { val: '0', type: 'varchar' }, 'p3': { val: '0', type: 'varchar' },
            // Dados Comprador/Contato
            'contatonome': { val: body.comprador.nome, type: 'varchar' },
            'contatofone': { val: '11999999999', type: 'varchar' }, // Pode vir do front se disponível
            'contatoendereco': { val: body.comprador.endereco.logradouro, type: 'varchar' }
        };

        // Preenche Passageiros
        body.passengers.forEach((pax, index) => {
            const suffix = isFamiliar ? (index + 1) : ''; // Se familiar: nome1, nome2... Se individual: nome
            
            // Dados Pessoais
            const nameParts = pax.nome.trim().split(' ');
            const firstName = nameParts[0];
            const lastName = nameParts.slice(1).join(' ') || '.';

            params[`nome${suffix}`] = { val: firstName, type: 'varchar' };
            params[`sobrenome${suffix}`] = { val: lastName, type: 'varchar' };
            params[`sexo${suffix}`] = { val: 'M', type: 'char' }; // Padrão se não vier
            params[`dtnascimento${suffix}`] = { val: pax.nascimento.replace(/-/g, '/'), type: 'varchar' };
            params[`documento${suffix}`] = { val: pax.cpf.replace(/\D/g,''), type: 'varchar' };
            params[`tipodoc${suffix}`] = { val: 'CPF', type: 'varchar' };
            
            // Dados de Endereço (Usa o do comprador para todos)
            // No método individual (index 0 e !isFamiliar), ou no método familiar para cada pax
            if (isFamiliar || index === 0) {
                 params[`endereco${suffix}`] = { val: body.comprador.endereco.logradouro, type: 'varchar' };
                 params[`telefone${suffix}`] = { val: '11999999999', type: 'varchar' };
                 params[`cidade${suffix}`] = { val: 'São Paulo', type: 'varchar' };
                 params[`uf${suffix}`] = { val: 'SP', type: 'char' };
                 params[`cep${suffix}`] = { val: body.comprador.endereco.cep.replace(/\D/g,''), type: 'varchar' };
                 params[`bairro${suffix}`] = { val: 'Centro', type: 'varchar' };
                 params[`numero${suffix}`] = { val: body.comprador.endereco.numero || '0', type: 'varchar' };
                 params[`endcomplemento${suffix}`] = { val: '', type: 'varchar' };
                 
                 if(isFamiliar) {
                     params[`voucherCreditoPax${suffix}`] = { val: '', type: 'varchar' };
                 } else {
                     params['vouchercredito'] = { val: '0', type: 'varchar' };
                     params['dataitemviagem'] = { val: '', type: 'varchar' };
                     params['file'] = { val: 'site', type: 'varchar' };
                 }
            }
        });

        // Gera Envelope
        const xmlBody = createSoapEnvelope(method, params);

        // Envia para Coris
        const response = await fetch(CORIS_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'text/xml; charset=utf-8', 
                'SOAPAction': `http://tempuri.org/${method}` 
            },
            body: xmlBody
        });

        const textResponse = await response.text();
        
        // Verifica Erros
        const erro = extractTagValue(textResponse, 'erro');
        if (erro && erro !== '0' && erro !== 'OK') {
            const msg = extractTagValue(textResponse, 'mensagem') || 'Erro desconhecido';
            throw new Error(`Falha na emissão (${erro}): ${msg}`);
        }

        const voucher = extractTagValue(textResponse, 'voucher');
        const link = `https://evoucher.coris.com.br/evoucher/chubb/bilhete_chubb_assistencia_v1.asp?voucher=${voucher}`;

        return { statusCode: 200, headers, body: JSON.stringify({ success: true, voucher, link }) };

    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
