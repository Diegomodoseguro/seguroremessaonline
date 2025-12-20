const fetch = require('node-fetch');

// --- CREDENCIAIS ---
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = process.env.CORIS_LOGIN;
const CORIS_SENHA = process.env.CORIS_SENHA;

// Helper: Gera XML com tipagem estrita conforme Manual V5
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, item] of Object.entries(params)) {
        // item.val é o valor, item.type é o tipo (int, varchar, char)
        const val = (item.val === null || item.val === undefined) ? '' : String(item.val);
        const type = item.type || 'varchar'; 
        // Formato exato: <param name="nome" type="tipo" value="valor" />
        paramString += `<param name="${key}" type="${type}" value="${val}" />`;
    }
    return `<?xml version="1.0" encoding="utf-8"?>
    <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      <soap:Body>
        <${method} xmlns="http://www.coris.com.br/WebService/">
          ${paramString}
        </${method}>
      </soap:Body>
    </soap:Envelope>`;
};

const parseCorisXML = (xmlString, tagName) => {
    const results = [];
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'g');
    let match;
    while ((match = regex.exec(xmlString)) !== null) {
        const content = match[1];
        const item = {};
        // Regex ajustado para capturar conteúdo de tags simples
        const fieldRegex = /<(\w+)>([^<]*)<\/\1>/g;
        let fieldMatch;
        while ((fieldMatch = fieldRegex.exec(content)) !== null) {
            item[fieldMatch[1]] = fieldMatch[2];
        }
        results.push(item);
    }
    return results;
};

// Extração de valor para exibição (apenas visual, não filtra mais)
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
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    
    if (!CORIS_LOGIN || !CORIS_SENHA) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Credenciais ausentes no servidor.' }) };
    }

    try {
        const { destination, days, ages, tripType } = JSON.parse(event.body); 

        if (!destination || !days) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Dados incompletos (Destino ou Dias).' }) };
        }

        // Distribuição de Idades (Manual V5 - Faixas específicas)
        // pax065: 0-65 | pax7685: 66-70 | pax86100: 71-80 | p2: 81-85
        const brackets = { pax065: 0, pax7685: 0, pax86100: 0, p2: 0 };
        
        if (ages && Array.isArray(ages)) {
            ages.forEach(ageStr => {
                const age = parseInt(ageStr);
                if (age <= 65) brackets.pax065++;
                else if (age <= 70) brackets.pax7685++;
                else if (age <= 80) brackets.pax86100++;
                else if (age <= 85) brackets.p2++;
                // > 85 ignorado conforme regra do manual
            });
        } else {
            brackets.pax065 = 1; // Fallback
        }

        // Configuração de Parâmetros
        let homeVal = 0;
        let multiVal = 0;
        let destVal = parseInt(destination);
        let catVal = 1; // 1 = Lazer/Negócios

        if (tripType == '3') { // Multiviagem
            homeVal = 1;
            catVal = 3;
        } else if (tripType == '4') { // Receptivo
            homeVal = 22;
            destVal = 2; // Manual: destino deve ser 2 (Brasil) para receptivo
            catVal = 5;
        } else if (tripType == '2') { // Intercambio
            catVal = 2;
        }

        // 1. Buscar Planos (BuscarPlanosNovosV13)
        // ATENÇÃO: Tipos 'int' são obrigatórios para números no SOAP da Coris
        const planosParams = {
            'login': { val: CORIS_LOGIN, type: 'varchar' },
            'senha': { val: CORIS_SENHA, type: 'varchar' },
            'destino': { val: destVal, type: 'int' },
            'vigencia': { val: days, type: 'int' },
            'home': { val: homeVal, type: 'int' },
            'multi': { val: multiVal, type: 'int' }
        };

        const planosRes = await fetch(CORIS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/BuscarPlanosNovosV13' },
            body: createSoapEnvelope('BuscarPlanosNovosV13', planosParams)
        });
        
        const planosText = await planosRes.text();
        
        // Verifica erro explícito da API (ex: senha errada, produto inativo)
        const erroMatch = planosText.match(/<erro>(.*?)<\/erro>/);
        const msgMatch = planosText.match(/<mensagem>(.*?)<\/mensagem>/);
        
        if (erroMatch && erroMatch[1] !== '0') {
             const msg = msgMatch ? msgMatch[1] : 'Erro desconhecido da Coris';
             console.error(`Erro Coris Planos: ${msg}`);
             return { statusCode: 400, body: JSON.stringify({ error: `Coris: ${msg} (Cód: ${erroMatch[1]})` }) };
        }

        let planos = parseCorisXML(planosText, 'buscaPlanos');

        if (planos.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Nenhum plano disponível para o seu usuário Coris neste destino/data. Verifique se o produto está ativo na seguradora.' }) };
        }

        // 2. Buscar Preços (BuscarPrecosIndividualV13)
        // Tipagem rigorosa conforme Manual V5 pág 6
        const plansWithPrice = await Promise.all(planos.map(async (p) => {
            const precoParams = {
                'login': { val: CORIS_LOGIN, type: 'varchar' },
                'senha': { val: CORIS_SENHA, type: 'varchar' },
                'idplano': { val: p.id, type: 'int' },
                'dias': { val: days, type: 'int' },
                'pax065': { val: brackets.pax065, type: 'int' },
                'pax6675': { val: 0, type: 'int' }, // Campo legado, enviar 0
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
                'p2': { val: brackets.p2.toString(), type: 'varchar' }, // Manual diz que p2 é varchar
                'p3': { val: '0', type: 'varchar' } 
            };

            const precoRes = await fetch(CORIS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/BuscarPrecosIndividualV13' },
                body: createSoapEnvelope('BuscarPrecosIndividualV13', precoParams)
            });

            const precoText = await precoRes.text();
            
            // Verifica erro na precificação
            const erroPreco = precoText.match(/<erro>(.*?)<\/erro>/);
            if (erroPreco && erroPreco[1] !== '0') return null;

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
        
        if (validPlans.length === 0) {
             return { statusCode: 400, body: JSON.stringify({ error: 'Planos encontrados, mas sem preço calculado (possível erro de idade/produto).' }) };
        }

        return { statusCode: 200, body: JSON.stringify(validPlans) };

    } catch (error) {
        console.error('Erro Proxy Coris:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
