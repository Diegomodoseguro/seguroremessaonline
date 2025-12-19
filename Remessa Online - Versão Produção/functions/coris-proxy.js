const fetch = require('node-fetch');

// --- CREDENCIAIS DE AMBIENTE ---
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = process.env.CORIS_LOGIN;
const CORIS_SENHA = process.env.CORIS_SENHA;

// Helper: XML Formato Padrão ASMX (<key>value</key>)
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, value] of Object.entries(params)) {
        // Garante que valores nulos sejam strings vazias
        const val = value === null || value === undefined ? '' : value;
        paramString += `<${key}>${val}</${key}>`;
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
        const fieldRegex = /<(\w+)>([^<]*)<\/\1>/g; // Alterado para aceitar valores vazios
        let fieldMatch;
        while ((fieldMatch = fieldRegex.exec(content)) !== null) {
            item[fieldMatch[1]] = fieldMatch[2];
        }
        results.push(item);
    }
    return results;
};

// Extração de valor mais robusta
const extractCoverageValue = (planName) => {
    if (!planName) return 0;
    // Tenta capturar "60.000", "60K", "60 mil", "60"
    let match = planName.match(/(\d{1,3})[.,]?(\d{3})?(\s*k|\s*mil)?/i);
    if (match) {
        let val = parseInt(match[1].replace(/[.,]/g, ''));
        // Se capturou decimal (ex: 60) e tem K ou é menor que 1000, multiplica
        if (match[3] || (!match[2] && val < 1000)) val = val * 1000;
        else if (match[2]) val = parseInt(match[1] + match[2]);
        return val;
    }
    return 0; // Se não conseguir ler, retorna 0 (para lógica de fallback)
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!CORIS_LOGIN || !CORIS_SENHA) return { statusCode: 500, body: JSON.stringify({ error: 'Credenciais ausentes.' }) };

    try {
        const { destination, days, ages, tripType, origin } = JSON.parse(event.body); 

        if (!destination || !days || !ages) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Dados incompletos' }) };
        }

        // 1. Distribuir idades nas faixas da Coris (Manual V5)
        const brackets = { pax065: 0, pax7685: 0, pax86100: 0, p2: 0 };
        ages.forEach(ageStr => {
            const age = parseInt(ageStr);
            if (age <= 65) brackets.pax065++;
            else if (age <= 70) brackets.pax7685++; // 66-70
            else if (age <= 80) brackets.pax86100++; // 71-80
            else if (age <= 85) brackets.p2++; // 81-85
        });

        // 2. Parâmetros de Busca de Planos
        let homeVal = 0;
        let multiVal = 0;
        let destVal = parseInt(destination);
        let catVal = 1; // Default Lazer

        if (tripType == '3') { // Multiviagem
            homeVal = 1;
            catVal = 3;
        } else if (tripType == '4') { // Receptivo
            homeVal = 22;
            destVal = 2; // Manual exige destino 2 para receptivo
            catVal = 5;
        } else if (tripType == '2') { // Intercambio
            catVal = 2;
        }

        const planosParams = {
            'login': CORIS_LOGIN,
            'senha': CORIS_SENHA,
            'destino': destVal,
            'vigencia': days,
            'home': homeVal,
            'multi': multiVal
        };

        const planosRes = await fetch(CORIS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/BuscarPlanosNovosV13' },
            body: createSoapEnvelope('BuscarPlanosNovosV13', planosParams)
        });
        
        const planosText = await planosRes.text();
        let planos = parseCorisXML(planosText, 'buscaPlanos');

        // Se a API retornar erro explícito no XML
        const erroTag = planosText.match(/<erro>(.*?)<\/erro>/);
        if (erroTag && erroTag[1] !== '0' && planos.length === 0) {
             console.error("Erro API Coris:", planosText);
             // Se erro for "nenhum plano", retornamos array vazio limpo
             return { statusCode: 200, body: JSON.stringify([]) };
        }

        // 3. Filtragem de Planos
        planos = planos.filter(p => {
            const val = extractCoverageValue(p.nome);
            
            // SE conseguir ler o valor, aplica o filtro. SE NÃO (val=0), mostra o plano por segurança.
            if (val > 0) {
                // Sempre Único: 60k a 1M
                if (origin === 'sempre_unico') return val >= 60000 && val <= 1000000;
                // Index: Até 700k
                if (origin === 'index') return val <= 700000;
            }
            return true; // Fallback: mostra tudo que não conseguiu filtrar
        });

        if (planos.length === 0) return { statusCode: 200, body: JSON.stringify([]) };

        // 4. Buscar Preços Individuais
        const plansWithPrice = await Promise.all(planos.map(async (p) => {
            const precoParams = {
                'login': CORIS_LOGIN,
                'senha': CORIS_SENHA,
                'idplano': p.id,
                'dias': days,
                'pax065': brackets.pax065,
                'pax6675': 0, 
                'pax7685': brackets.pax7685, 
                'pax86100': brackets.pax86100,
                'angola': 'N',
                'furtoelet': 0,
                'bagagens': 0,
                'morteac': 0,
                'mortenat': 0,
                'cancplus': 0,
                'cancany': 0,
                'formapagamento': '',
                'destino': destVal,
                'categoria': catVal,
                'codigodesconto': '',
                'danosmala': 0,
                'pet': 0,
                'p1': 0, 
                'p2': brackets.p2, 
                'p3': 0 
            };

            const precoRes = await fetch(CORIS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/BuscarPrecosIndividualV13' },
                body: createSoapEnvelope('BuscarPrecosIndividualV13', precoParams)
            });

            const precoText = await precoRes.text();
            const precoData = parseCorisXML(precoText, 'buscaPrecos')[0];

            if (precoData && (precoData.precoindividualrs || precoData.totalrs)) {
                // Prioriza totalrs se existir, senão calcula
                let rawPrice = precoData.totalrs ? precoData.totalrs : precoData.precoindividualrs;
                const totalBRL = parseFloat(rawPrice.replace('.', '').replace(',', '.'));
                
                const coverage = extractCoverageValue(p.nome);
                const dmh = coverage > 0 ? `USD ${coverage.toLocaleString('pt-BR')}` : p.nome; // Fallback nome se não ler valor
                
                // Lógica visual de bagagem
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

        return { statusCode: 200, body: JSON.stringify(validPlans) };

    } catch (error) {
        console.error('Erro Proxy Coris:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
