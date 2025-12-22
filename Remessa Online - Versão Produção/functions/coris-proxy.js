const fetch = require('node-fetch');

// --- CREDENCIAIS OFICIAIS ---
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = 'MORJ6750';
const CORIS_SENHA = 'diego@';

// Helper: Decode HTML Entities (ESSENCIAL para respostas SOAP string)
const decodeHtmlEntities = (text) => {
    if (!text) return '';
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
};

// Helper: Gera XML Compacto (Sem espaços que quebram a API)
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, item] of Object.entries(params)) {
        const val = (item.val === null || item.val === undefined) ? '' : String(item.val);
        const type = item.type || 'varchar'; 
        // Importante: Sem espaços entre atributos, conforme padrão
        paramString += `<param name='${key}' type='${type}' value='${val}' />`;
    }

    // Envelope SOAP Minificado (Uma única linha)
    return `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/"><soapenv:Header/><soapenv:Body><tem:${method}><tem:strXML><![CDATA[<execute>${paramString}</execute>]]></tem:strXML></tem:${method}></soapenv:Body></soapenv:Envelope>`;
};

const parseCorisXML = (xmlString, tagName) => {
    const results = [];
    // Regex ajustada para ser case insensitive e pegar o conteúdo
    const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 'gi');
    let match;
    while ((match = regex.exec(xmlString)) !== null) {
        const content = match[1];
        const item = {};
        const fieldRegex = /<(\w+)>([^<]*)<\/\1>/g;
        let fieldMatch;
        while ((fieldMatch = fieldRegex.exec(content)) !== null) {
            item[fieldMatch[1]] = fieldMatch[2];
        }
        results.push(item);
    }
    return results;
};

const extractCoverageValue = (planName) => {
    if (!planName) return 0;
    let match = planName.match(/(\d{1,3})[.,]?(\d{3})?(\s*k|\s*mil)?/i);
    if (match) {
        let val = parseInt(match[1].replace(/[.,]/g, ''));
        if (match[3] || (!match[2] && val < 1000)) val = val * 1000;
        else if (match[2]) val = parseInt(match[1] + match[2]);
        return val;
    }
    return 0;
};

exports.handler = async (event) => {
    // Permitir CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

    try {
        const { destination, days, ages, tripType } = JSON.parse(event.body); 

        // 1. Validação e Preparação dos Dados
        if (!destination || !days) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Dados incompletos (Destino ou Dias faltando).' }) };

        const brackets = { pax065: 0, pax7685: 0, pax86100: 0, p2: 0 };
        (ages || []).forEach(ageStr => {
            const age = parseInt(ageStr);
            if (age <= 65) brackets.pax065++;
            else if (age <= 70) brackets.pax7685++;
            else if (age <= 80) brackets.pax86100++;
            else if (age <= 85) brackets.p2++;
        });
        if ((ages || []).length === 0) brackets.pax065 = 1;

        let homeVal = 0;
        let multiVal = 0;
        let destVal = parseInt(destination);
        let catVal = 1; // Default: Lazer (1)
        let searchDays = parseInt(days); // Garante inteiro

        // Lógica de Tipo de Viagem (Conforme Manual V5)
        if (tripType == '3') { // Multiviagem (Anual)
            homeVal = 1; 
            catVal = 3; 
            searchDays = 365; // Fixo para anual
            multiVal = 30;    // Padrão de mercado para multi
        }
        else if (tripType == '4') { // Receptivo
            homeVal = 22; 
            destVal = 2; // Força destino Brasil conforme manual
            catVal = 5; 
        }
        else if (tripType == '2') { // Intercâmbio
            catVal = 2; 
        }

        // 2. Buscar Planos (BuscarPlanosNovosV13)
        const planosParams = {
            'login': { val: CORIS_LOGIN, type: 'varchar' },
            'senha': { val: CORIS_SENHA, type: 'varchar' },
            'destino': { val: destVal, type: 'int' },
            'vigencia': { val: searchDays, type: 'int' },
            'home': { val: homeVal, type: 'int' },
            'multi': { val: multiVal, type: 'int' }
        };

        console.log("Busca Params:", JSON.stringify(planosParams));

        const planosRes = await fetch(CORIS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://tempuri.org/BuscarPlanosNovosV13' },
            body: createSoapEnvelope('BuscarPlanosNovosV13', planosParams)
        });
        
        let planosText = await planosRes.text();
        
        // Decodificar entidades HTML pois a resposta vem "escapada"
        planosText = decodeHtmlEntities(planosText);
        
        // Verifica erro de negócio da API
        const erroMatch = planosText.match(/<erro>(.*?)<\/erro>/);
        const msgMatch = planosText.match(/<mensagem>(.*?)<\/mensagem>/);
        if (erroMatch && erroMatch[1] !== '0') {
             const msg = msgMatch ? msgMatch[1] : 'Erro desconhecido';
             console.error("Erro CORIS API:", msg);
             return { statusCode: 400, headers, body: JSON.stringify({ error: `Coris: ${msg}` }) };
        }

        let planos = parseCorisXML(planosText, 'buscaPlanos');

        if (planos.length === 0) {
            const debugInfo = `Destino=${destVal}, Dias=${searchDays}, Home=${homeVal}, Multi=${multiVal}, Cat=${catVal}`;
            console.error(`Nenhum plano encontrado. Params: ${debugInfo}`);
            
            return { 
                statusCode: 400, 
                headers, 
                body: JSON.stringify({ 
                    error: `Nenhum plano disponível na Coris para este perfil. Parâmetros técnicos enviados: ${debugInfo}. Verifique se o login ${CORIS_LOGIN} possui produtos ativos para estes parâmetros.` 
                }) 
            };
        }

        // 3. Buscar Preços (BuscarPrecosIndividualV13)
        // SEGUINDO ESTRUTURA EXATA DO POSTMAN COLLECTION "BuscarPrecosIndividualV13"
        const plansWithPrice = await Promise.all(planos.map(async (p) => {
            const precoParams = {
                'login': { val: CORIS_LOGIN, type: 'varchar' },
                'senha': { val: CORIS_SENHA, type: 'varchar' },
                'idplano': { val: p.id, type: 'int' },
                'dias': { val: parseInt(days), type: 'int' },
                'pax065': { val: brackets.pax065, type: 'int' },
                'pax6675': { val: 0, type: 'int' },
                'pax7685': { val: brackets.pax7685, type: 'int' }, 
                'pax86100': { val: brackets.pax86100, type: 'int' },
                'angola': { val: 'N', type: 'char' },
                'furtoelet': { val: 0, type: 'int' },
                'bagagens': { val: 0, type: 'int' },
                'morteac': { val: 0, type: 'int' },
                'mortenat': { val: 0, type: 'int' },
                'cancplus': { val: 0, type: 'int' },
                'cancany': { val: 0, type: 'int' },
                // SEGUINDO POSTMAN: formapagamento='FA' (anteriormente estava vazio)
                'formapagamento': { val: 'FA', type: 'varchar' }, 
                'destino': { val: destVal, type: 'int' },
                'categoria': { val: catVal, type: 'int' },
                // SEGUINDO POSTMAN: codigodesconto='0' (anteriormente estava vazio)
                'codigodesconto': { val: '0', type: 'varchar' },
                'danosmala': { val: 0, type: 'int' },
                'pet': { val: 0, type: 'int' },
                // SEGUINDO POSTMAN: p1, p2, p3 = '0' (anteriormente p2 estava vazio)
                'p1': { val: '0', type: 'varchar' },
                'p2': { val: brackets.p2 > 0 ? brackets.p2.toString() : '0', type: 'varchar' },
                'p3': { val: '0', type: 'varchar' } 
            };

            const precoRes = await fetch(CORIS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://tempuri.org/BuscarPrecosIndividualV13' },
                body: createSoapEnvelope('BuscarPrecosIndividualV13', precoParams)
            });

            let precoText = await precoRes.text();
            precoText = decodeHtmlEntities(precoText); 

            const precoData = parseCorisXML(precoText, 'buscaPrecos')[0];

            if (precoData && (precoData.precoindividualrs || precoData.totalrs)) {
                let rawPrice = precoData.totalrs ? precoData.totalrs : precoData.precoindividualrs;
                const totalBRL = parseFloat(rawPrice.replace(/\./g, '').replace(',', '.'));
                const coverage = extractCoverageValue(p.nome);
                const dmh = coverage > 0 ? `USD ${coverage.toLocaleString('pt-BR')}` : p.nome;
                let bagagem = 'USD 1.000';
                if(coverage >= 60000) bagagem = 'USD 1.500';
                if(coverage >= 100000) bagagem = 'USD 2.000';

                return {
                    id: p.id,
                    nome: p.nome,
                    dmh: dmh,
                    bagagem: bagagem,
                    originalPriceTotalBRL: totalBRL,
                    tripTypeId: tripType
                };
            }
            return null;
        }));

        const validPlans = plansWithPrice.filter(p => p !== null).sort((a, b) => a.originalPriceTotalBRL - b.originalPriceTotalBRL);
        
        if (validPlans.length === 0) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Erro ao calcular preços: Planos encontrados mas sem preço retornado.' }) };

        return { statusCode: 200, headers, body: JSON.stringify(validPlans) };

    } catch (error) {
        console.error("Server Error:", error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
