const fetch = require('node-fetch');

// --- CREDENCIAIS OFICIAIS ---
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = 'MORJ6750';
const CORIS_SENHA = 'diego@';

// Helper: Gera XML IDÊNTICO ao formato solicitado
const createSoapEnvelope = (method, params) => {
    let paramLines = '';
    
    // Monta cada linha de parâmetro mantendo a estrutura interna com aspas simples
    for (const [key, item] of Object.entries(params)) {
        const val = (item.val === null || item.val === undefined) ? '' : String(item.val);
        const type = item.type || 'varchar'; 
        // Adiciona indentação para ficar visualmente igual ao exemplo
        paramLines += `               <param name='${key}' type='${type}' value='${val}' />\n`;
    }

    // Estrutura SOAP ajustada com aspas duplas no Envelope e indentação
    return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
   <soapenv:Header/>
   <soapenv:Body>
      <tem:${method}>
         <tem:strXML>
            <![CDATA[
            <execute>
${paramLines}            </execute>
            ]]>
         </tem:strXML>
      </tem:${method}>
   </soapenv:Body>
</soapenv:Envelope>`;
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
    // 1. Validação de Método e Headers
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const { destination, days, ages, tripType } = JSON.parse(event.body); 

        // 2. Validação de Dados
        if (!destination || !days) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Dados incompletos (Destino ou Dias).' }) };
        }

        // Distribuição de Idades (Manual V5)
        const brackets = { pax065: 0, pax7685: 0, pax86100: 0, p2: 0 };
        (ages || []).forEach(ageStr => {
            const age = parseInt(ageStr);
            if (age <= 65) brackets.pax065++;
            else if (age <= 70) brackets.pax7685++;
            else if (age <= 80) brackets.pax86100++;
            else if (age <= 85) brackets.p2++;
        });
        if ((ages || []).length === 0) brackets.pax065 = 1;

        // Configuração de Parâmetros
        let homeVal = 0, multiVal = 0, destVal = parseInt(destination), catVal = 1;

        if (tripType == '3') { homeVal = 1; catVal = 3; } // Multiviagem
        else if (tripType == '4') { homeVal = 22; destVal = 2; catVal = 5; } // Receptivo
        else if (tripType == '2') { catVal = 2; } // Intercambio

        // 3. BUSCAR PLANOS (BuscarPlanosNovosV13)
        const planosParams = {
            'login': { val: CORIS_LOGIN, type: 'varchar' },
            'senha': { val: CORIS_SENHA, type: 'varchar' },
            'destino': { val: destVal, type: 'int' },
            'vigencia': { val: days, type: 'int' },
            'home': { val: homeVal, type: 'int' },
            'multi': { val: multiVal, type: 'int' }
        };

        console.log("Enviando Cotação para Coris:", JSON.stringify(planosParams));

        const planosRes = await fetch(CORIS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8' },
            body: createSoapEnvelope('BuscarPlanosNovosV13', planosParams)
        });
        
        const planosText = await planosRes.text();
        
        // Verifica erro explícito no XML de resposta
        const erroMatch = planosText.match(/<erro>(.*?)<\/erro>/);
        const msgMatch = planosText.match(/<mensagem>(.*?)<\/mensagem>/);
        
        if (erroMatch && erroMatch[1] !== '0') {
             const msg = msgMatch ? msgMatch[1] : 'Erro desconhecido da Coris';
             console.error(`Erro Coris Planos: ${msg}`);
             return { statusCode: 400, body: JSON.stringify({ error: `Coris: ${msg} (Cód: ${erroMatch[1]})` }) };
        }

        let planos = parseCorisXML(planosText, 'buscaPlanos');

        if (planos.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: `Nenhum plano disponível para a sua agência (${CORIS_LOGIN}) com estes filtros. Verifique o destino (${destVal}) e dias (${days}).` }) };
        }

        // 4. BUSCAR PREÇOS (BuscarPrecosIndividualV13)
        const plansWithPrice = await Promise.all(planos.map(async (p) => {
            const precoParams = {
                'login': { val: CORIS_LOGIN, type: 'varchar' },
                'senha': { val: CORIS_SENHA, type: 'varchar' },
                'idplano': { val: p.id, type: 'int' },
                'dias': { val: days, type: 'int' },
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
                'formapagamento': { val: 'FA', type: 'varchar' }, // FA no Postman
                'destino': { val: destVal, type: 'int' },
                'categoria': { val: catVal, type: 'int' },
                'codigodesconto': { val: '0', type: 'varchar' }, 
                'danosmala': { val: 0, type: 'int' },
                'pet': { val: 0, type: 'int' },
                'p1': { val: '0', type: 'varchar' },
                'p2': { val: brackets.p2.toString(), type: 'varchar' },
                'p3': { val: '0', type: 'varchar' } 
            };

            const precoRes = await fetch(CORIS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8' },
                body: createSoapEnvelope('BuscarPrecosIndividualV13', precoParams)
            });

            const precoText = await precoRes.text();
            
            // Ignora planos com erro na precificação
            if (precoText.includes('<erro>') && !precoText.includes('<erro>0</erro>')) return null;

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
             return { statusCode: 400, body: JSON.stringify({ error: 'Planos encontrados, mas a Coris não retornou preço válido.' }) };
        }

        return { statusCode: 200, body: JSON.stringify(validPlans) };

    } catch (error) {
        console.error("Erro Geral Coris:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
