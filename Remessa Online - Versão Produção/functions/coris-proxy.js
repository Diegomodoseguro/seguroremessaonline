const fetch = require('node-fetch');

// --- CREDENCIAIS DE PRODUÇÃO ---
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = 'MORJ6750';
const CORIS_SENHA = 'diego@';

// Helper: Decodifica o XML que vem "escapado" dentro da resposta SOAP
const decodeHtmlEntities = (text) => {
    if (!text) return '';
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
};

// Helper: Extrai cobertura do nome do plano
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

// Helper: Cria o Envelope SOAP EXATO (Baseado no sucesso do Postman)
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    // Constrói as tags <param ... />
    for (const [key, item] of Object.entries(params)) {
        const val = (item.val === null || item.val === undefined) ? '' : String(item.val);
        const type = item.type || 'varchar';
        // Atenção aos espaços e aspas simples conforme o XML validado
        paramString += `               <param name='${key}' type='${type}' value='${val}' />\n`;
    }

    // Retorna o envelope SOAP completo
    // Nota: O XML validado usa aspas duplas para xmlns e aspas simples para os atributos de param dentro do CDATA
    return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
   <soapenv:Header/>
   <soapenv:Body>
      <tem:${method}>
         <tem:strXML>
            <![CDATA[
            <execute>
${paramString}            </execute>
            ]]>
         </tem:strXML>
      </tem:${method}>
   </soapenv:Body>
</soapenv:Envelope>`;
};

// Helper: Parser manual mais robusto para a resposta <table...><row><column...>
const parseCorisTable = (xmlString) => {
    const results = [];
    if (!xmlString) return results;

    const rowRegex = /<row>(.*?)<\/row>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(xmlString)) !== null) {
        const rowContent = rowMatch[1];
        const item = {};
        const colRegex = /<column name="([^"]+)">([^<]*)<\/column>/g;
        let colMatch;
        while ((colMatch = colRegex.exec(rowContent)) !== null) {
            item[colMatch[1]] = colMatch[2];
        }
        results.push(item);
    }
    return results;
};

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body);
        const { destination, days, tripType, origin } = body;

        // Validação básica
        if (!destination || !days) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Parâmetros inválidos.' }) };
        }

        // 1. Definição de Parâmetros SOAP
        let homeVal = 0;
        let multiVal = 0;
        let destVal = parseInt(destination);

        if (tripType == '3') { // Multiviagem
            homeVal = 1; 
            multiVal = 30; // Padrão
        } else if (tripType == '4') { // Receptivo
            homeVal = 22; 
            destVal = 2;
        }

        // Prepara objeto de parâmetros para o helper
        const params = {
            'login': { val: CORIS_LOGIN, type: 'varchar' },
            'senha': { val: CORIS_SENHA, type: 'varchar' },
            'destino': { val: destVal, type: 'int' },
            'vigencia': { val: parseInt(days), type: 'int' },
            'home': { val: homeVal, type: 'int' },
            'multi': { val: multiVal, type: 'int' }
        };

        const xmlBody = createSoapEnvelope('BuscarPlanosNovosV13', params);

        // 2. Chamada à API Coris
        const response = await fetch(CORIS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': 'http://tempuri.org/BuscarPlanosNovosV13'
            },
            body: xmlBody
        });

        const responseText = await response.text();

        // Verifica status HTTP da Coris antes de tentar parsear
        if (response.status !== 200) {
            console.error("Erro Coris HTTP:", response.status, responseText);
            return { statusCode: 502, headers, body: JSON.stringify({ error: `Erro na seguradora: ${response.status}` }) };
        }

        // 3. Processamento da Resposta
        // Extrai o conteúdo de BuscarPlanosNovosV13Result
        const resultMatch = responseText.match(/<BuscarPlanosNovosV13Result>(.*?)<\/BuscarPlanosNovosV13Result>/s);
        
        if (!resultMatch) {
            // Tenta capturar erro SOAP Fault
            const faultMatch = responseText.match(/<soap:Fault>(.*?)<\/soap:Fault>/s);
            if (faultMatch) {
                console.error("SOAP Fault:", faultMatch[1]);
                return { statusCode: 502, headers, body: JSON.stringify({ error: 'Erro SOAP na seguradora.' }) };
            }
            console.error("XML Inesperado:", responseText);
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Resposta inválida da seguradora.' }) };
        }

        const innerXML = decodeHtmlEntities(resultMatch[1]);
        
        // Verifica se há erro lógico da Coris no XML interno (ex: <erro>1</erro>)
        const erroLogico = innerXML.match(/<erro>(.*?)<\/erro>/);
        if (erroLogico && erroLogico[1] !== '0') {
             const msgErro = innerXML.match(/<mensagem>(.*?)<\/mensagem>/);
             return { statusCode: 400, headers, body: JSON.stringify({ error: `Coris: ${msgErro ? msgErro[1] : 'Erro desconhecido'}` }) };
        }

        const planos = parseCorisTable(innerXML);

        if (!planos || planos.length === 0) {
            return { statusCode: 200, headers, body: JSON.stringify([]) }; // Retorna array vazio, não erro 500
        }

        // 4. Formatação e Filtros
        let planosFormatados = planos.map(p => {
            const price = parseFloat(p.preco.replace('.', '').replace(',', '.'));
            const cobVal = extractCoverageValue(p.nome);
            
            let bagagem = 'USD 1.000';
            if (cobVal >= 60000) bagagem = 'USD 1.500';
            if (cobVal >= 100000) bagagem = 'USD 2.000';

            return {
                id: p.id,
                nome: p.nome,
                dmh: cobVal > 0 ? `USD ${cobVal.toLocaleString('pt-BR')}` : p.nome,
                bagagem: bagagem,
                originalPriceTotalBRL: price,
                raw: p 
            };
        });

        if (origin === 'sempre_unico') {
            planosFormatados = planosFormatados.filter(p => {
                const cobVal = extractCoverageValue(p.nome);
                return cobVal >= 60000;
            });
        }

        planosFormatados.sort((a, b) => a.originalPriceTotalBRL - b.originalPriceTotalBRL);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(planosFormatados)
        };

    } catch (error) {
        console.error("Erro Catch Lambda:", error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message || 'Erro interno no servidor.' }) };
    }
};
