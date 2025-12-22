const fetch = require('node-fetch');

// --- CREDENCIAIS OFICIAIS ---
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = 'MORJ6750';
const CORIS_SENHA = 'diego@';

// Helper: Gera XML Compacto (Sem espaços que quebram a API)
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, item] of Object.entries(params)) {
        const val = (item.val === null || item.val === undefined) ? '' : String(item.val);
        const type = item.type || 'varchar'; 
        // Importante: Sem espaços entre atributos
        paramString += `<param name='${key}' type='${type}' value='${val}' />`;
    }

    // Envelope SOAP Minificado (Uma única linha)
    return `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/"><soapenv:Header/><soapenv:Body><tem:${method}><tem:strXML><![CDATA[<execute>${paramString}</execute>]]></tem:strXML></tem:${method}></soapenv:Body></soapenv:Envelope>`;
};

const parseCorisXML = (xmlString, tagName) => {
    const results = [];
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'g');
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
    // Permitir CORS para testes locais e produção
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

        let homeVal = 0, multiVal = 0, destVal = parseInt(destination), catVal = 1;
        let searchDays = days; // Vigência padrão para a busca é a duração da viagem

        // Lógica de Tipo de Viagem Corrigida
        if (tripType == '3') { // Multiviagem (Anual)
            homeVal = 1; 
            catVal = 3;
            // Para planos anuais, a vigência de busca deve ser 365, não os dias da primeira viagem
            searchDays = 365; 
            // Para planos anuais, multi deve ser 30 (padrão de mercado) para retornar os planos corretos
            multiVal = 30; 
        }
        else if (tripType == '4') { // Receptivo
            homeVal = 22; 
            destVal = 2; // Força Brasil
            catVal = 5; 
        }
        else if (tripType == '2') { // Intercâmbio/Estudante
            catVal = 2; 
        }

        // 2. Buscar Planos (BuscarPlanosNovosV13)
        const planosParams = {
            'login': { val: CORIS_LOGIN, type: 'varchar' },
            'senha': { val: CORIS_SENHA, type: 'varchar' },
            'destino': { val: destVal, type: 'int' },
            'vigencia': { val: searchDays, type: 'int' }, // Usa a vigência ajustada
            'home': { val: homeVal, type: 'int' },
            'multi': { val: multiVal, type: 'int' }
        };

        console.log("Busca Params:", JSON.stringify(planosParams)); // Log para debug no Netlify

        const planosRes = await fetch(CORIS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://tempuri.org/BuscarPlanosNovosV13' },
            body: createSoapEnvelope('BuscarPlanosNovosV13', planosParams)
        });
        
        const planosText = await planosRes.text();
        
        // Verifica erro de negócio da API
        const erroMatch = planosText.match(/<erro>(.*?)<\/erro>/);
        const msgMatch = planosText.match(/<mensagem>(.*?)<\/mensagem>/);
        if (erroMatch && erroMatch[1] !== '0') {
             const msg = msgMatch ? msgMatch[1] : 'Erro desconhecido';
             console.error("Erro CORIS API:", msg, "Params:", planosParams);
             return { statusCode: 400, headers, body: JSON.stringify({ error: `Coris: ${msg}` }) };
        }

        let planos = parseCorisXML(planosText, 'buscaPlanos');

        if (planos.length === 0) {
            console.error("Nenhum plano encontrado. Params:", planosParams);
            return { 
                statusCode: 400, 
                headers, 
                body: JSON.stringify({ 
                    error: `Nenhum plano disponível para o destino ${destVal} (${tripType == 3 ? 'Multiviagem' : 'Lazer'}) com ${searchDays} dias. Verifique se a agência possui produtos ativos para este perfil.` 
                }) 
            };
        }

        // 3. Buscar Preços (BuscarPrecosIndividualV13)
        // Nota: Para Multiviagem, o preço geralmente é fixo anual, mas enviamos 'days' da viagem para cálculo de cotação se necessário,
        // mas a API geralmente ignora dias para produtos anuais ou usa a tabela fixa.
        const plansWithPrice = await Promise.all(planos.map(async (p) => {
            const precoParams = {
                'login': { val: CORIS_LOGIN, type: 'varchar' },
                'senha': { val: CORIS_SENHA, type: 'varchar' },
                'idplano': { val: p.id, type: 'int' },
                'dias': { val: days, type: 'int' }, // Aqui mantemos os dias reais da viagem para o cálculo (exceto se for multi, mas a API resolve)
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
                'formapagamento': { val: '', type: 'varchar' },
                'destino': { val: destVal, type: 'int' },
                'categoria': { val: catVal, type: 'int' },
                'codigodesconto': { val: '', type: 'varchar' },
                'danosmala': { val: 0, type: 'int' },
                'pet': { val: 0, type: 'int' },
                'p1': { val: '0', type: 'varchar' },
                'p2': { val: brackets.p2.toString(), type: 'varchar' },
                'p3': { val: '0', type: 'varchar' } 
            };

            const precoRes = await fetch(CORIS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://tempuri.org/BuscarPrecosIndividualV13' },
                body: createSoapEnvelope('BuscarPrecosIndividualV13', precoParams)
            });

            const precoText = await precoRes.text();
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
        return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) };
    }
};
