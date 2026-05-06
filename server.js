/**
 * ═══════════════════════════════════════════════════════════════════
 * NATURGY CONSULTA - BACKEND (server.js)
 * ═══════════════════════════════════════════════════════════════════
 *
 * ARQUITECTURA SIMPLIFICADA:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  TODA la lógica de consulta está aquí.                         │
 * │  Si algo falla en las APIs → busca aquí.                       │
 * │  Si algo falla visualmente → edita index.html.                 │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ENDPOINTS:
 *   POST /consultar          → Consulta principal (DNI + dirección/CUPS)
 *   GET  /autocomplete       → Sugerencias de dirección en tiempo real
 *   GET  /horizontal         → Pisos/puertas de una dirección
 *   GET  /vertical           → Datos finales de una vivienda
 *   GET  /health             → Estado del servidor
 *
 * NOTAS SOBRE IPs:
 *   - Render por defecto tiene IPs de EE.UU. → Naturgy puede bloquear
 *   - Solución A: Despliega en Railway con región Europe West
 *   - Solución B: Usa Render con región Frankfurt (Europe)
 *   - Solución C: Usa un proxy residencial español (ver PROXY_CONFIG abajo)
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════════════

const CONFIG = {
  // URLs de las APIs de Naturgy
  CHECKOUT_ORIGIN: 'https://checkout.naturgy.es',
  LOCATION_API: 'https://naturgy-location-api.ed-integrations.com',
  EXISTING_CUPS_URL: 'https://services.zapotek.adn.naturgy.com/middleware/existingCups',
  TECHNICAL_INFO_URL: 'https://services.zapotek.adn.naturgy.com/middleware/sips/technical_infos',
  LEADS_URL: 'https://services.zapotek.adn.naturgy.com/middleware/leads',
  CHECK_LIMIT_URL: 'https://services.zapotek.adn.naturgy.com/middleware/leads/checkLimit',

  // Configuración de scoring
  MAX_SCORING_RETRIES: 10,
  SCORING_RETRY_DELAY: 1500,

  // Headers comunes que simulan un navegador real (Chrome en Windows)
  BROWSER_HEADERS: {
    'accept': 'application/json',
    'accept-language': 'es-419,es;q=0.9,es-ES;q=0.8',
    'origin': 'https://checkout.naturgy.es',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'priority': 'u=1, i'
  }
};

// ════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════════

app.use(cors({
  origin: '*', // Permite cualquier origen (necesario para GitHub Pages)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Log de todas las peticiones
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ════════════════════════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════════════════════════

/**
 * Genera un UUID v4 para sessionId y componentSessionId
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function generateComponentSessionId(sessionId) {
  const suffix = Math.random().toString(36).substring(2, 10);
  return `${sessionId}_${suffix}`;
}

/**
 * Genera un DNI válido aleatorio para las consultas anónimas
 */
function generateValidDNI() {
  const letters = 'TRWAGMYFPDXBNJZSQVHLCKE';
  const number = Math.floor(Math.random() * 100000000);
  const padded = number.toString().padStart(8, '0');
  const letter = letters[number % 23];
  return padded + letter;
}

/**
 * Genera datos de persona aleatoria para el scoring
 */
function generateFakeData() {
  const nombres = ['Carlos', 'Maria', 'Jose', 'Ana', 'Luis', 'Laura', 'David', 'Sofia', 'Javier', 'Elena'];
  const apellidos = ['Garcia', 'Rodriguez', 'Gonzalez', 'Fernandez', 'Lopez', 'Martinez', 'Sanchez', 'Perez'];

  const nombre = nombres[Math.floor(Math.random() * nombres.length)];
  const apellido1 = apellidos[Math.floor(Math.random() * apellidos.length)];
  const apellido2 = apellidos[Math.floor(Math.random() * apellidos.length)];
  const prefix = Math.random() > 0.5 ? '6' : '7';
  let phone = prefix;
  for (let i = 0; i < 8; i++) phone += Math.floor(Math.random() * 10);
  const randomNum = Math.floor(Math.random() * 9000 + 1000);
  const email = `${nombre.toLowerCase()}.${apellido1.toLowerCase()}${randomNum}@gmail.com`;

  return { nombre, apellido1, apellido2, telefono: phone, email };
}

/**
 * Delay helper
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Interpreta el código de estado del CUPS
 * 00 = Contratable, 04/05 = Activo (tiene contrato), 03 = En curso
 */
function getEstadoFromCode(code) {
  const c = String(code);
  if (c === '00') return { texto: 'Contratable', icono: '🟢', color: '#4CAF50', contratable: true };
  if (c === '04' || c === '05') return { texto: 'Activo (con contrato)', icono: '🔴', color: '#f44336', contratable: false };
  if (c === '03') return { texto: 'En curso', icono: '🟡', color: '#FF9800', contratable: false };
  return { texto: 'Desconocido', icono: '⚪', color: '#888', contratable: null };
}

/**
 * Detecta el tipo de documento (DNI o NIE)
 */
function detectarTipoDocumento(doc) {
  const clean = doc.toUpperCase().trim();
  if (/^[XYZ]/.test(clean)) return 'NIE';
  return 'DNI';
}

/**
 * Formatea potencia limpiando comas y asegurando formato correcto
 */
function formatPotencia(valor) {
  if (!valor) return null;
  const num = parseFloat(String(valor).replace(',', '.'));
  if (isNaN(num)) return null;
  return num.toFixed(2).replace('.', ',');
}

/**
 * Calcula media mensual estimada de luz
 */
function calcularMediaLuz(consumoLuz, potenciaP1) {
  if (consumoLuz === null) return null;
  const potencia = potenciaP1 ? parseFloat(String(potenciaP1).replace(',', '.')) || 0 : 0;
  const consumoMensual = consumoLuz / 12;
  const costeEnergia = consumoMensual * 0.10;
  const ajustePotencia = potencia * 1.95;
  return Math.floor(costeEnergia + ajustePotencia);
}

/**
 * Calcula media mensual estimada de gas
 * Tarifa RL.1 → 3.50€, RL.2 → 5€, RL.3 → 6€
 */
function calcularMediaGas(consumoGas, tarifaGas) {
  if (consumoGas === null) return null;
  const consumoMensual = consumoGas / 12;
  const costeGas = consumoMensual * 0.04;
  let cargoFijo = 0;
  if (tarifaGas) {
    const t = tarifaGas.toUpperCase();
    if (t.includes('RL.1') || t.includes('RL1')) cargoFijo = 3.50;
    else if (t.includes('RL.2') || t.includes('RL2')) cargoFijo = 5.00;
    else if (t.includes('RL.3') || t.includes('RL3')) cargoFijo = 6.00;
  }
  return Math.floor(costeGas + cargoFijo);
}

// ════════════════════════════════════════════════════════════════
// FUNCIONES DE CONSULTA A APIs DE NATURGY
// ════════════════════════════════════════════════════════════════

/**
 * Realiza una petición fetch con los headers de navegador
 * NOTA: Si Naturgy bloquea por IP, los errores aparecerán aquí
 */
async function naturgyFetch(url, options = {}) {
  const fetchOptions = {
    method: options.method || 'GET',
    headers: {
      ...CONFIG.BROWSER_HEADERS,
      ...(options.headers || {})
    }
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
    fetchOptions.headers['content-type'] = 'application/json';
  }

  // Usar node-fetch si está disponible, sino fetch nativo
  const fetchFn = globalThis.fetch || require('node-fetch');
  
  const response = await fetchFn(url, fetchOptions);
  
  if (!response.ok && response.status !== 404) {
    throw new Error(`HTTP ${response.status} en ${url}`);
  }
  
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Autocomplete de direcciones
 */
async function consultarAutocomplete(texto) {
  const sessionId = generateUUID();
  const componentSessionId = generateComponentSessionId(sessionId);
  const url = `${CONFIG.LOCATION_API}/v1/autocomplete?sessionId=${sessionId}&componentSessionID=${componentSessionId}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&input=${encodeURIComponent(texto)}`;

  const data = await naturgyFetch(url);
  return data?.results || [];
}

/**
 * Obtiene pisos/puertas de una dirección (horizontal)
 */
async function consultarHorizontal(addressData, label, types = '') {
  const sessionId = generateUUID();
  const componentSessionId = generateComponentSessionId(sessionId);

  let url;
  if (addressData.origin === 'sips' && addressData.uuid) {
    url = `${CONFIG.LOCATION_API}/v1/detail/horizontal/byid/${addressData.uuid}?sessionId=${sessionId}&componentSessionID=${componentSessionId}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&label=${encodeURIComponent(label)}&origin=sips&types=${encodeURIComponent(types)}&addressWithNumber=false&googleCP=undefined`;
  } else if (addressData.placeIDGoogle) {
    url = `${CONFIG.LOCATION_API}/v1/detail/horizontal/byplaceid/${addressData.placeIDGoogle}?sessionId=${sessionId}&componentSessionID=${componentSessionId}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&label=${encodeURIComponent(label)}&origin=google&types=${encodeURIComponent(types)}&addressWithNumber=false&googleCP=`;
  } else if (addressData.uuid) {
    url = `${CONFIG.LOCATION_API}/v1/detail/horizontal/byid/${addressData.uuid}?sessionId=${sessionId}&componentSessionID=${componentSessionId}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&label=${encodeURIComponent(label)}&origin=${addressData.origin || 'sips'}&types=${encodeURIComponent(types)}&addressWithNumber=false&googleCP=undefined`;
  } else {
    throw new Error('No hay identificador válido para consultar horizontal');
  }

  const data = await naturgyFetch(url);
  return data?.results || [];
}

/**
 * Obtiene datos finales de una vivienda (vertical - incluye CUPS)
 */
async function consultarVertical(id, label) {
  const sessionId = generateUUID();
  const componentSessionId = generateComponentSessionId(sessionId);
  const url = `${CONFIG.LOCATION_API}/v1/detail/vertical/${id}?sessionId=${sessionId}&componentSessionID=${componentSessionId}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&id=${id}&label=${encodeURIComponent(label)}`;

  const data = await naturgyFetch(url);
  return data?.results?.[0] || null;
}

/**
 * Consulta CUPS directamente por código
 */
async function consultarCupsPorCodigo(cups) {
  const cleanCups = cups.replace(/\s/g, '').toUpperCase();
  const sessionId = generateUUID();
  const componentSessionId = generateComponentSessionId(sessionId);
  const category = cleanCups.startsWith('ES02') ? 'gas' : 'electricity';

  const url = `${CONFIG.LOCATION_API}/v1/cups/${cleanCups}?sessionId=${sessionId}&componentSessionID=${componentSessionId}&step=3&category=${category}&provider=newco&cups=&postalCode=hide`;
  
  const data = await naturgyFetch(url);
  if (data?.code === 404) return null;
  return data;
}

/**
 * Consulta el estado de un CUPS (contratable/activo/en curso)
 */
async function consultarEstadoCups(cups, tipo = 'ELECTRICITY') {
  const cleanCups = cups.replace(/\s/g, '').toUpperCase();
  const docNumber = generateValidDNI();
  const url = `${CONFIG.EXISTING_CUPS_URL}?cups=${cleanCups}&docNumber=${docNumber}&comercializadora=newco&energia=${tipo}`;

  const data = await naturgyFetch(url);
  if (data?.code !== undefined) {
    return getEstadoFromCode(data.code);
  }
  return null;
}

/**
 * Consulta datos técnicos (consumo, potencia, tarifa)
 * Endpoint principal (con DNI aleatorio)
 */
async function consultarTechnicalInfo(cups, tipo = 'ELECTRICITY') {
  const cleanCups = cups.replace(/\s/g, '').toUpperCase();
  const docNumber = generateValidDNI();
  const url = `${CONFIG.TECHNICAL_INFO_URL}/${tipo}?cups=${cleanCups}&docType=NIF&document=${docNumber}&energyType=${tipo}`;

  return await naturgyFetch(url);
}

/**
 * Consulta datos técnicos - endpoint alternativo (sin DNI)
 */
async function consultarTechnicalInfoAlternativa(cups, tipo = 'ELECTRICITY') {
  const cleanCups = cups.replace(/\s/g, '').toUpperCase();
  const url = `https://services.zapotek-pre.adn.naturgy.com/middleware/sips/technical_infos/${tipo}?cups=${cleanCups}&energyType=${tipo}`;

  return await naturgyFetch(url);
}

/**
 * Verifica el scoring de un DNI
 * Proceso en 3 pasos:
 *   1. checkLimit → verifica disponibilidad
 *   2. POST /leads → crea un lead temporal con datos ficticios
 *   3. PUT /leads/{id}/scoring → consulta el resultado (con reintentos)
 */
async function verificarScoring(dni) {
  const tipoDoc = detectarTipoDocumento(dni);
  const fakeData = generateFakeData();

  const headersComunes = {
    'accept': 'application/json',
    'content-type': 'application/json',
    'origin': 'https://checkout.naturgy.es',
    'user-agent': CONFIG.BROWSER_HEADERS['user-agent']
  };

  // PASO 1: Verificar disponibilidad
  const checkUrl = `${CONFIG.CHECK_LIMIT_URL}?phone=${fakeData.telefono}&isPyme=0&email=${encodeURIComponent(fakeData.email)}&nif=${dni}`;
  const checkData = await naturgyFetch(checkUrl, { headers: headersComunes });

  if (!checkData?.success) {
    throw new Error('No supera verificación inicial');
  }

  // PASO 2: Crear lead temporal
  const leadPayload = {
    email: fakeData.email,
    phone: fakeData.telefono,
    firstName: fakeData.nombre.toUpperCase(),
    lastName: fakeData.apellido1.toUpperCase(),
    secondLastName: fakeData.apellido2.toUpperCase(),
    documentType: 'NIF',
    nationality: 'ES',
    documentNumber: dni,
    preferredLanguage: 'Castellano',
    referralCode: null,
    productReferralCode: null,
    buyapowaCode: null,
    contact: null,
    checkGDPR1: false,
    checkGDPR2: false,
    checkGDPR3: false,
    retargeting: false,
    socialBonus: false,
    birthdayDate: null,
    orders: [{
      energyUse: 'Doméstico',
      priceReservationDate: new Date().toISOString(),
      user: '/middleware/users/6545faa4-632b-4ff6-bc2d-88fbb6f98e0a',
      channelOffer: '/middleware/channel_offers/e1f2c4b6-0460-43d4-80b6-af82b8987921',
      campaign: '/middleware/campaigns/f904d1dd-5da4-4fe6-9644-db76007901e0',
      cnae: null
    }],
    alliancesWanted: null,
    alliances: [],
    company: '/middleware/companies/2a1f6a03-d056-4e8d-af97-7603b1375c9f',
    onlineInvoice: true,
    pyme: false,
    metadata: {
      sel: 'E0001', vn: '907008005', agv: 'GRWEBCOL',
      src: 'hogar', origen: 'web', id: 'es', tipo: 'luz',
      'idCampaign[]': 'f904d1dd-5da4-4fe6-9644-db76007901e0',
      company: 'nycli'
    },
    step: 0
  };

  const leadData = await naturgyFetch(CONFIG.LEADS_URL, {
    method: 'POST',
    headers: headersComunes,
    body: leadPayload
  });

  if (!leadData?.id) {
    throw new Error('Error al crear lead para scoring');
  }

  // PASO 3: Consultar scoring con reintentos
  const scoringUrl = `${CONFIG.LEADS_URL}/${leadData.id}/scoring`;
  const codigosValidos = ['0000', '0001', '0005'];

  for (let intento = 1; intento <= CONFIG.MAX_SCORING_RETRIES; intento++) {
    const scoringData = await naturgyFetch(scoringUrl, {
      method: 'PUT',
      headers: headersComunes,
      body: {}
    });

    const codigo = scoringData?.result;
    console.log(`[Scoring] Intento ${intento}: código = "${codigo}"`);

    if (codigosValidos.includes(codigo)) {
      // 0000 = NO es scoring (puede contratar)
      // 0001 o 0005 = ES scoring (riesgo)
      return {
        esScoring: codigo === '0001' || codigo === '0005',
        codigo,
        mensaje: codigo === '0000' ? 'NO ES SCORING ✅' : 'ES SCORING ⚠️'
      };
    }

    if (intento < CONFIG.MAX_SCORING_RETRIES) {
      await delay(CONFIG.SCORING_RETRY_DELAY);
    }
  }

  throw new Error('No se obtuvo respuesta de scoring tras múltiples intentos');
}

// ════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL DE CONSULTA
// ════════════════════════════════════════════════════════════════

/**
 * Procesa los datos de un resultado de dirección/CUPS y obtiene toda la info
 * Este es el núcleo del sistema
 */
async function procesarDatosCups(resultData) {
  const cupsLuz = (resultData.cupsID || '').trim() || null;
  let cupsGas = (resultData.gasCupsID || '').trim() || null;

  // Validar que el CUPS de gas empiece por ES02
  if (cupsGas && !cupsGas.toUpperCase().startsWith('ES02')) {
    cupsGas = null;
  }

  const direccion = {
    calle: resultData.roadTypeName
      ? `${resultData.roadTypeName} ${resultData.road || ''} ${resultData.number || ''}`.trim()
      : (resultData.streetType ? `${resultData.streetType} ${resultData.streetName || ''}`.trim() : ''),
    piso: [
      resultData.building ? `Edif. ${resultData.building}` : '',
      resultData.staircase ? `Esc. ${resultData.staircase}` : '',
      resultData.floor ? `Piso ${resultData.floor}` : '',
      resultData.door ? `Pta. ${resultData.door}` : ''
    ].filter(Boolean).join(', '),
    cp: resultData.postCode || '',
    municipio: resultData.municipality || resultData.town || '',
    provincia: resultData.province || ''
  };

  // Consultas paralelas para máxima velocidad
  const promesas = [];
  let estadoLuz = null, estadoGas = null;
  let techLuz = null, techGas = null;

  if (cupsLuz) {
    promesas.push(
      consultarEstadoCups(cupsLuz, 'ELECTRICITY')
        .then(e => { estadoLuz = e; })
        .catch(err => console.error('Error estado luz:', err))
    );

    promesas.push(
      consultarTechnicalInfo(cupsLuz, 'ELECTRICITY')
        .then(async (data) => {
          techLuz = data;
          // Si no hay datos, intentar con el endpoint alternativo
          if (!data?.consumption12Months && !data?.capacityP1) {
            const dataAlt = await consultarTechnicalInfoAlternativa(cupsLuz, 'ELECTRICITY').catch(() => null);
            if (dataAlt?.consumption12Months || dataAlt?.capacityP1) {
              techLuz = dataAlt;
            }
          }
        })
        .catch(err => console.error('Error tech luz:', err))
    );
  }

  if (cupsGas) {
    promesas.push(
      consultarEstadoCups(cupsGas, 'GAS')
        .then(e => { estadoGas = e; })
        .catch(err => console.error('Error estado gas:', err))
    );

    promesas.push(
      consultarTechnicalInfo(cupsGas, 'GAS')
        .then(async (data) => {
          techGas = data;
          if (!data?.consumption12Months) {
            const dataAlt = await consultarTechnicalInfoAlternativa(cupsGas, 'GAS').catch(() => null);
            if (dataAlt?.consumption12Months) techGas = dataAlt;
          }
        })
        .catch(err => console.error('Error tech gas:', err))
    );
  }

  await Promise.all(promesas);

  // Procesar datos de luz
  let consumoLuz = null, potenciaP1 = null, potenciaP2 = null, mediaLuz = null;
  if (techLuz) {
    if (techLuz.consumption12Months) {
      consumoLuz = Math.round(parseFloat(String(techLuz.consumption12Months).replace(',', '.'))) || null;
    }
    potenciaP1 = formatPotencia(techLuz.capacityP1);
    potenciaP2 = formatPotencia(techLuz.capacityP2);
    mediaLuz = calcularMediaLuz(consumoLuz, potenciaP1);
  }

  // Procesar datos de gas
  let consumoGas = null, tarifaGas = null, mediaGas = null;
  if (techGas) {
    if (techGas.consumption12Months) {
      consumoGas = Math.round(parseFloat(String(techGas.consumption12Months).replace(',', '.'))) || null;
    }
    tarifaGas = techGas.accessTariff || null;
    mediaGas = calcularMediaGas(consumoGas, tarifaGas);
  }

  return {
    direccion,
    luz: cupsLuz ? {
      cups: cupsLuz,
      estado: estadoLuz,
      consumoAnual: consumoLuz,
      potenciaP1,
      potenciaP2,
      mediaMensual: mediaLuz,
      tarifa: techLuz?.accessTariff || null
    } : null,
    gas: cupsGas ? {
      cups: cupsGas,
      estado: estadoGas,
      consumoAnual: consumoGas,
      tarifa: tarifaGas,
      mediaMensual: mediaGas
    } : null
  };
}

// ════════════════════════════════════════════════════════════════
// ENDPOINTS DE LA API
// ════════════════════════════════════════════════════════════════

/**
 * GET /health
 * Verifica que el servidor está funcionando
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /autocomplete?q=texto
 * Devuelve sugerencias de direcciones en tiempo real
 * Usado por el frontend para mostrar resultados mientras el usuario escribe
 */
app.get('/autocomplete', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 3) return res.json({ results: [] });

  try {
    const results = await consultarAutocomplete(q);
    res.json({ results });
  } catch (error) {
    console.error('Error autocomplete:', error.message);
    res.status(500).json({ error: 'Error al buscar direcciones', results: [] });
  }
});

/**
 * GET /horizontal?uuid=...&placeIDGoogle=...&label=...&origin=...
 * Devuelve los pisos/puertas disponibles de una dirección
 */
app.get('/horizontal', async (req, res) => {
  const { uuid, placeIDGoogle, label, origin, types } = req.query;

  if (!uuid && !placeIDGoogle) {
    return res.status(400).json({ error: 'Se requiere uuid o placeIDGoogle' });
  }

  try {
    const results = await consultarHorizontal(
      { uuid, placeIDGoogle, origin: origin || 'sips' },
      label || '',
      types || ''
    );
    res.json({ results });
  } catch (error) {
    console.error('Error horizontal:', error.message);
    res.status(500).json({ error: 'Error al obtener pisos', results: [] });
  }
});

/**
 * GET /vertical?id=...&label=...
 * Devuelve los datos completos de una vivienda (incluyendo CUPS)
 */
app.get('/vertical', async (req, res) => {
  const { id, label } = req.query;

  if (!id) return res.status(400).json({ error: 'Se requiere id' });

  try {
    const data = await consultarVertical(id, label || '');
    if (!data) return res.status(404).json({ error: 'No se encontró la vivienda' });

    const resultado = await procesarDatosCups(data);
    res.json(resultado);
  } catch (error) {
    console.error('Error vertical:', error.message);
    res.status(500).json({ error: 'Error al obtener datos de la vivienda' });
  }
});

/**
 * POST /consultar
 * Endpoint principal - acepta DNI, dirección o CUPS
 *
 * Body: {
 *   tipo: 'cups' | 'scoring',
 *   cups: 'ES0021...',        // para tipo cups
 *   dni: '12345678Z',         // para tipo scoring
 * }
 */
app.post('/consultar', async (req, res) => {
  const { tipo, cups, dni } = req.body;

  // ═══ CONSULTA DE SCORING POR DNI ═══
  if (tipo === 'scoring' && dni) {
    try {
      const resultado = await verificarScoring(dni.toUpperCase().trim());
      return res.json({ tipo: 'scoring', ...resultado });
    } catch (error) {
      console.error('Error scoring:', error.message);
      return res.status(500).json({ error: 'Error al verificar scoring: ' + error.message });
    }
  }

  // ═══ CONSULTA POR CUPS ═══
  if (tipo === 'cups' && cups) {
    const cleanCups = cups.replace(/\s/g, '').toUpperCase();

    try {
      // Intentar obtener datos de la API de location
      const locationData = await consultarCupsPorCodigo(cleanCups);

      if (locationData) {
        let resultData;
        if (locationData.results && Array.isArray(locationData.results) && locationData.results.length > 0) {
          resultData = locationData.results[0];
        } else if (locationData.cupsID || locationData.gasCupsID) {
          resultData = locationData;
        }

        if (resultData) {
          const resultado = await procesarDatosCups(resultData);
          return res.json({ tipo: 'cups', ...resultado });
        }
      }

      // Si no hay datos de location, consultar directamente las APIs técnicas
      const tipo_energia = cleanCups.startsWith('ES02') ? 'GAS' : 'ELECTRICITY';
      const resultData = {
        cupsID: tipo_energia === 'ELECTRICITY' ? cleanCups : null,
        gasCupsID: tipo_energia === 'GAS' ? cleanCups : null
      };

      const resultado = await procesarDatosCups(resultData);
      return res.json({ tipo: 'cups', ...resultado });

    } catch (error) {
      console.error('Error consulta CUPS:', error.message);
      return res.status(500).json({ error: 'Error al consultar CUPS: ' + error.message });
    }
  }

  return res.status(400).json({ error: 'Parámetros incorrectos. Usa tipo=cups+cups=... o tipo=scoring+dni=...' });
});

// ════════════════════════════════════════════════════════════════
// INICIO DEL SERVIDOR
// ════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   🔌 Naturgy Consulta Backend - Iniciado             ║
║   Puerto: ${PORT}                                        ║
║   Endpoints:                                         ║
║     GET  /health         → Estado del servidor       ║
║     GET  /autocomplete   → Sugerencias dirección     ║
║     GET  /horizontal     → Pisos de una dirección    ║
║     GET  /vertical       → Datos de una vivienda     ║
║     POST /consultar      → Consulta principal        ║
╚══════════════════════════════════════════════════════╝
  `);
});
