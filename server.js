// ════════════════════════════════════════════════════════════════
// NATURGY CONSULTA BACKEND v1.0
// Servidor Express que actúa de intermediario con las APIs de Naturgy
// ════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────────
app.use(cors({
  origin: '*', // Permitir cualquier origen (GitHub Pages, etc.)
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ── Constantes de las APIs de Naturgy ──────────────────────────
const CHECKOUT_ORIGIN       = 'https://checkout.naturgy.es';
const CALCULATOR_ORIGIN     = 'https://front-calculator.zapotek-pre.adn.naturgy.com';
const BASE_EXISTING_CUPS    = 'https://services.zapotek.adn.naturgy.com/middleware/existingCups';
const BASE_TECHNICAL_INFO   = 'https://services.zapotek.adn.naturgy.com/middleware/sips/technical_infos';
const BASE_TECHNICAL_PRE    = 'https://services.zapotek-pre.adn.naturgy.com/middleware/sips/technical_infos';
const BASE_PRICING          = 'https://services.zapotek-pre.adn.naturgy.com/pricing/calculations';
const PRICING_API_KEY       = '7c5f5b203bbe3642bd702a157f88b981876cdda8';
const LOCATION_API          = 'https://naturgy-location-api.ed-integrations.com';

// Endpoints de leads para scoring
const LEADS_CHECK_LIMIT     = 'https://services.zapotek.adn.naturgy.com/middleware/leads/checkLimit';
const LEADS_BASE            = 'https://services.zapotek.adn.naturgy.com/middleware/leads';

// ════════════════════════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════════════════════════

/** Genera un UUID v4 aleatorio (para sessionId) */
function generateSessionId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/** Genera un componentSessionId derivado del sessionId */
function generateComponentSessionId(sessionId) {
  return `${sessionId}_${Math.random().toString(36).substring(2, 10)}`;
}

/** DNI válido aleatorio para consultas que lo requieren */
function generateValidDNI() {
  const letters = 'TRWAGMYFPDXBNJZSQVHLCKE';
  const number  = Math.floor(Math.random() * 100000000);
  return number.toString().padStart(8, '0') + letters[number % 23];
}

/** Convierte código de estado a texto legible */
function getEstadoFromCode(code) {
  const c = String(code);
  if (c === '00')            return { texto: 'Contratable', color: 'green' };
  if (c === '04' || c === '05') return { texto: 'Activo (con otra compañía)', color: 'red' };
  if (c === '03')            return { texto: 'En curso (cambio en proceso)', color: 'orange' };
  return                            { texto: 'Desconocido', color: 'gray' };
}

/** Formatea potencia a 2 decimales */
function formatPotencia(p) {
  if (!p) return null;
  const n = parseFloat(String(p).replace(',', '.'));
  return isNaN(n) ? null : n.toFixed(2).replace('.', ',');
}

/** Capitaliza palabras */
function capitalizeWords(str) {
  if (!str) return '';
  return str.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Delay helper */
const delay = ms => new Promise(r => setTimeout(r, ms));

/** Datos de persona falsa para el flow de scoring */
function generateFakePersonData() {
  const nombres   = ['Carlos','Maria','Jose','Ana','Luis','Laura','David','Sofia','Javier','Elena'];
  const apellidos = ['Garcia','Rodriguez','Gonzalez','Fernandez','Lopez','Martinez','Sanchez','Perez'];
  const nombre    = nombres[Math.floor(Math.random() * nombres.length)];
  const ap1       = apellidos[Math.floor(Math.random() * apellidos.length)];
  const ap2       = apellidos[Math.floor(Math.random() * apellidos.length)];
  const prefix    = Math.random() > 0.5 ? '6' : '7';
  let phone       = prefix;
  for (let i = 0; i < 8; i++) phone += Math.floor(Math.random() * 10);
  const rand      = Math.floor(Math.random() * 9000 + 1000);
  return {
    nombre,
    apellido1: ap1,
    apellido2: ap2,
    telefono: phone,
    email: `${nombre.toLowerCase()}.${ap1.toLowerCase()}${rand}@gmail.com`
  };
}

// ════════════════════════════════════════════════════════════════
// FUNCIONES DE CONSULTA A APIS NATURGY
// ════════════════════════════════════════════════════════════════

/** 1. Autocomplete de direcciones */
async function consultarAutocomplete(texto) {
  const sid = generateSessionId();
  const cid = generateComponentSessionId(sid);
  const url = `${LOCATION_API}/v1/autocomplete?sessionId=${sid}&componentSessionID=${cid}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&input=${encodeURIComponent(texto)}`;
  const res = await fetch(url, { headers: { accept: '*/*', origin: CHECKOUT_ORIGIN } });
  const data = await res.json();
  return data?.results || [];
}

/** 2. Buscar CUPS directamente por código */
async function consultarCupsPorCodigo(cups) {
  const clean    = cups.replace(/\s/g, '').toUpperCase();
  const sid      = generateSessionId();
  const cid      = generateComponentSessionId(sid);
  const category = clean.startsWith('ES02') ? 'gas' : 'electricity';
  const url      = `${LOCATION_API}/v1/cups/${clean}?sessionId=${sid}&componentSessionID=${cid}&step=3&category=${category}&provider=newco&cups=&postalCode=hide`;
  const res      = await fetch(url, { headers: { accept: '*/*', origin: CHECKOUT_ORIGIN } });
  const data     = await res.json();
  if (data?.code === 404) return null;
  return data;
}

/** 3. Detalle horizontal (pisos de una dirección) */
async function consultarHorizontal(addressData, label, types) {
  const sid = generateSessionId();
  const cid = generateComponentSessionId(sid);
  let url;
  if (addressData.origin === 'sips' && addressData.uuid) {
    url = `${LOCATION_API}/v1/detail/horizontal/byid/${addressData.uuid}?sessionId=${sid}&componentSessionID=${cid}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&label=${encodeURIComponent(label)}&origin=sips&types=${encodeURIComponent(types||'')}&addressWithNumber=false&googleCP=undefined`;
  } else if (addressData.placeIDGoogle) {
    url = `${LOCATION_API}/v1/detail/horizontal/byplaceid/${addressData.placeIDGoogle}?sessionId=${sid}&componentSessionID=${cid}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&label=${encodeURIComponent(label)}&origin=google&types=${encodeURIComponent(types||'')}&addressWithNumber=false&googleCP=`;
  } else if (addressData.uuid) {
    url = `${LOCATION_API}/v1/detail/horizontal/byid/${addressData.uuid}?sessionId=${sid}&componentSessionID=${cid}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&label=${encodeURIComponent(label)}&origin=${addressData.origin||'sips'}&types=${encodeURIComponent(types||'')}&addressWithNumber=false&googleCP=undefined`;
  } else {
    return [];
  }
  const res  = await fetch(url, { headers: { accept: '*/*', origin: CHECKOUT_ORIGIN } });
  const data = await res.json();
  return data?.results || [];
}

/** 4. Detalle vertical (datos del suministro de una vivienda) */
async function consultarVertical(id, label) {
  const sid = generateSessionId();
  const cid = generateComponentSessionId(sid);
  const url = `${LOCATION_API}/v1/detail/vertical/${id}?sessionId=${sid}&componentSessionID=${cid}&step=3&category=electricity&enabledGoogle=true&cups=&postalCode=hide&id=${id}&label=${encodeURIComponent(label)}`;
  const res  = await fetch(url, { headers: { accept: '*/*', origin: CHECKOUT_ORIGIN } });
  const data = await res.json();
  return data?.results?.[0] || null;
}

/** 5. Estado del CUPS (contratable / activo / en curso) */
async function consultarEstadoCups(cups, tipo = 'ELECTRICITY') {
  const clean = cups.replace(/\s/g, '').toUpperCase();
  const doc   = generateValidDNI();
  const url   = `${BASE_EXISTING_CUPS}?cups=${clean}&docNumber=${doc}&comercializadora=newco&energia=${tipo}`;
  try {
    const res  = await fetch(url, { headers: { accept: 'application/json', origin: CHECKOUT_ORIGIN } });
    const data = await res.json();
    if (data?.code !== undefined) return getEstadoFromCode(data.code);
  } catch (e) {
    console.error('Error estado CUPS:', e.message);
  }
  return null;
}

/** 6. Información técnica (consumo, potencia, tarifa) — endpoint principal */
async function consultarTechnicalInfo(cups, tipo = 'ELECTRICITY') {
  const clean = cups.replace(/\s/g, '').toUpperCase();
  const doc   = generateValidDNI();
  const url   = `${BASE_TECHNICAL_INFO}/${tipo}?cups=${clean}&docType=NIF&document=${doc}&energyType=${tipo}`;
  try {
    const res  = await fetch(url, { headers: { accept: 'application/json', origin: CHECKOUT_ORIGIN } });
    return await res.json();
  } catch (e) {
    console.error('Error technical info:', e.message);
  }
  return null;
}

/** 7. Información técnica — endpoint alternativo (pre-producción) */
async function consultarTechnicalInfoAlternativa(cups, tipo = 'ELECTRICITY') {
  const clean = cups.replace(/\s/g, '').toUpperCase();
  const url   = `${BASE_TECHNICAL_PRE}/${tipo}?cups=${clean}&energyType=${tipo}`;
  try {
    const res  = await fetch(url, { headers: { accept: 'application/json', origin: CALCULATOR_ORIGIN } });
    return await res.json();
  } catch (e) {
    console.error('Error technical info alternativa:', e.message);
  }
  return null;
}

/** 8. Pricing (importe estimado mensual) */
async function consultarPricing(cups, tipo = 'ELECTRICITY') {
  const clean = cups.replace(/\s/g, '').toUpperCase();
  const url   = `${BASE_PRICING}?cups=${clean}&channel=00&energyType=${tipo}`;
  for (let i = 1; i <= 3; i++) {
    try {
      const res  = await fetch(url, {
        headers: { accept: 'application/json', origin: CHECKOUT_ORIGIN, 'x-api-key': PRICING_API_KEY }
      });
      if (!res.ok) { if (res.status >= 500 && i < 3) { await delay(1500 * i); continue; } return null; }
      const data = await res.json();
      if (data?.monthlyCostNoTaxes !== undefined) return parseFloat(data.monthlyCostNoTaxes) * 0.55;
    } catch (e) {
      if (i < 3) await delay(1500 * i);
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
// FUNCIÓN DE SCORING (DNI/NIE)
// ════════════════════════════════════════════════════════════════

async function consultarScoring(dni) {
  const fake = generateFakePersonData();
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };

  // Paso 1 — checkLimit
  const checkUrl = new URL(LEADS_CHECK_LIMIT);
  checkUrl.searchParams.append('phone', fake.telefono);
  checkUrl.searchParams.append('isPyme', '0');
  checkUrl.searchParams.append('email', fake.email);
  checkUrl.searchParams.append('nif', dni);

  const res1 = await fetch(checkUrl.href, { method: 'GET', headers });
  const d1   = await res1.json();
  if (!res1.ok || !d1.success) throw new Error('No supera checkLimit');

  // Paso 2 — crear lead
  const leadPayload = {
    email: fake.email, phone: fake.telefono,
    firstName: fake.nombre.toUpperCase(),
    lastName: fake.apellido1.toUpperCase(),
    secondLastName: fake.apellido2.toUpperCase(),
    documentType: 'NIF', nationality: 'ES',
    documentNumber: dni, preferredLanguage: 'Castellano',
    referralCode: null, productReferralCode: null, buyapowaCode: null,
    contact: null, checkGDPR1: false, checkGDPR2: false, checkGDPR3: false,
    retargeting: false, socialBonus: false, birthdayDate: null,
    orders: [{
      energyUse: 'Doméstico',
      priceReservationDate: new Date().toISOString(),
      user: '/middleware/users/6545faa4-632b-4ff6-bc2d-88fbb6f98e0a',
      channelOffer: '/middleware/channel_offers/e1f2c4b6-0460-43d4-80b6-af82b8987921',
      campaign: '/middleware/campaigns/f904d1dd-5da4-4fe6-9644-db76007901e0',
      cnae: null
    }],
    alliancesWanted: null, alliances: [],
    company: '/middleware/companies/2a1f6a03-d056-4e8d-af97-7603b1375c9f',
    onlineInvoice: true, pyme: false,
    metadata: {
      sel: 'E0001', vn: '907008005', agv: 'GRWEBCOL',
      src: 'hogar', origen: 'web', id: 'es', tipo: 'luz',
      'idCampaign[]': 'f904d1dd-5da4-4fe6-9644-db76007901e0', company: 'nycli'
    },
    step: 0
  };

  const res2 = await fetch(LEADS_BASE, { method: 'POST', headers, body: JSON.stringify(leadPayload) });
  if (!res2.ok) throw new Error('Error creando lead');
  const d2   = await res2.json();
  const leadId = d2.id;
  if (!leadId) throw new Error('Sin leadId');

  // Paso 3 — polling scoring (hasta 10 intentos)
  const scoringUrl = `${LEADS_BASE}/${leadId}/scoring`;
  const validos    = ['0000', '0001', '0005'];

  for (let i = 0; i < 10; i++) {
    const res3 = await fetch(scoringUrl, { method: 'PUT', headers, body: JSON.stringify({}) });
    if (res3.ok) {
      const d3  = await res3.json();
      const cod = d3.result;
      if (validos.includes(cod)) {
        return {
          codigo: cod,
          esScoring: cod === '0001' || cod === '0005',
          texto: cod === '0000' ? 'NO ES SCORING ✅' : 'ES SCORING ⚠️'
        };
      }
    }
    if (i < 9) await delay(1500);
  }
  throw new Error('No se obtuvo código válido tras 10 intentos');
}

// ════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL: construye el JSON de resultado completo
// ════════════════════════════════════════════════════════════════

async function buildResult(cupsLuz, cupsGas, addressRaw) {
  const resultado = {
    direccion: null,
    luz: null,
    gas: null
  };

  // Dirección
  if (addressRaw) {
    resultado.direccion = {
      calle:       `${capitalizeWords(addressRaw.roadTypeName || '')} ${capitalizeWords(addressRaw.road || '')}`.trim(),
      numero:      addressRaw.number || '',
      piso:        [addressRaw.building, addressRaw.staircase, addressRaw.floor, addressRaw.door].filter(Boolean).join(' '),
      codigoPostal: addressRaw.postCode || '',
      municipio:   capitalizeWords(addressRaw.municipality || ''),
      provincia:   capitalizeWords(addressRaw.province || '')
    };
  }

  // ── LUZ ──────────────────────────────────────────────────────
  if (cupsLuz) {
    const clean = cupsLuz.replace(/\s/g, '').toUpperCase();
    resultado.luz = { cups: clean, estado: null, consumoAnual: null, potenciaP1: null, potenciaP2: null, importeMensual: null };

    const [estado, techInfo, techAlt] = await Promise.allSettled([
      consultarEstadoCups(clean, 'ELECTRICITY'),
      consultarTechnicalInfo(clean, 'ELECTRICITY'),
      consultarTechnicalInfoAlternativa(clean, 'ELECTRICITY')
    ]);

    if (estado.status === 'fulfilled' && estado.value) resultado.luz.estado = estado.value;

    // Consumo y potencia (primero principal, luego alternativa como fallback)
    let tech = techInfo.status === 'fulfilled' ? techInfo.value : null;
    if (!tech || (!tech.consumption12Months && !tech.capacityP1)) {
      tech = techAlt.status === 'fulfilled' ? techAlt.value : null;
    }
    if (tech) {
      if (tech.consumption12Months) {
        const n = parseFloat(String(tech.consumption12Months).replace(',', '.'));
        if (!isNaN(n)) resultado.luz.consumoAnual = Math.round(n);
      }
      if (tech.capacityP1) resultado.luz.potenciaP1 = formatPotencia(tech.capacityP1);
      if (tech.capacityP2) resultado.luz.potenciaP2 = formatPotencia(tech.capacityP2);
    }

    // Importe estimado
    const pot    = resultado.luz.potenciaP1 ? parseFloat(resultado.luz.potenciaP1.replace(',', '.')) : 0;
    const cons   = resultado.luz.consumoAnual;
    if (cons !== null) {
      resultado.luz.importeMensual = Math.floor((cons / 12) * 0.10 + pot * 1.95);
    }
  }

  // ── GAS ───────────────────────────────────────────────────────
  if (cupsGas) {
    const clean = cupsGas.replace(/\s/g, '').toUpperCase();
    resultado.gas = { cups: clean, tarifa: null, estado: null, consumoAnual: null, importeMensual: null };

    const [estado, techInfo] = await Promise.allSettled([
      consultarEstadoCups(clean, 'GAS'),
      consultarTechnicalInfoAlternativa(clean, 'GAS')
    ]);

    if (estado.status === 'fulfilled' && estado.value) resultado.gas.estado = estado.value;

    const tech = techInfo.status === 'fulfilled' ? techInfo.value : null;
    if (tech) {
      if (tech.consumption12Months) {
        resultado.gas.consumoAnual = Math.round(parseFloat(String(tech.consumption12Months).replace(',', '.'))) || null;
      }
      if (tech.accessTariff) resultado.gas.tarifa = tech.accessTariff;
    }

    // Importe gas
    const cons = resultado.gas.consumoAnual;
    if (cons !== null) {
      let cargoFijo = 3.50;
      const t = (resultado.gas.tarifa || '').toUpperCase();
      if (t.includes('RL.2') || t.includes('RL2')) cargoFijo = 5.00;
      if (t.includes('RL.3') || t.includes('RL3')) cargoFijo = 6.00;
      resultado.gas.importeMensual = Math.floor((cons / 12) * 0.04 + cargoFijo);
    }
  }

  return resultado;
}

// ════════════════════════════════════════════════════════════════
// ENDPOINTS DE LA API
// ════════════════════════════════════════════════════════════════

/**
 * GET /health
 * Comprobación de que el servidor está vivo
 */
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/**
 * POST /consultar
 * Body: { query: "dirección | CUPS | DNI" }
 *
 * Detecta automáticamente si es CUPS, dirección o DNI y lanza
 * las consultas correspondientes. Devuelve JSON limpio.
 */
app.post('/consultar', async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    return res.status(400).json({ error: 'Introduce una dirección, CUPS o DNI válido.' });
  }

  const texto = query.trim();
  const upper = texto.replace(/\s/g, '').toUpperCase();

  try {
    // ── CASO 1: CUPS de luz (ES00...) ────────────────────────
    if (upper.startsWith('ES00') && upper.length >= 20) {
      console.log('🔌 Búsqueda por CUPS de luz:', upper);

      // Intentar obtener dirección y CUPS gas asociado
      const locationData = await consultarCupsPorCodigo(upper);
      let cupsLuz = upper;
      let cupsGas = null;
      let addressRaw = null;

      if (locationData) {
        const r = locationData.results?.[0] || locationData;
        cupsLuz    = (r.cupsID    || upper).replace(/\s/g, '').toUpperCase();
        cupsGas    = r.gasCupsID  ? r.gasCupsID.replace(/\s/g, '').toUpperCase() : null;
        addressRaw = r;
      }

      const resultado = await buildResult(cupsLuz, cupsGas, addressRaw);
      return res.json({ tipo: 'cups-luz', ...resultado });
    }

    // ── CASO 2: CUPS de gas (ES02...) ────────────────────────
    if (upper.startsWith('ES02') && upper.length >= 20) {
      console.log('🔥 Búsqueda por CUPS de gas:', upper);

      const locationData = await consultarCupsPorCodigo(upper);
      let cupsLuz = null;
      let cupsGas = upper;
      let addressRaw = null;

      if (locationData) {
        const r = locationData.results?.[0] || locationData;
        cupsLuz    = r.cupsID     ? r.cupsID.replace(/\s/g, '').toUpperCase() : null;
        cupsGas    = (r.gasCupsID || upper).replace(/\s/g, '').toUpperCase();
        addressRaw = r;
      }

      const resultado = await buildResult(cupsLuz, cupsGas, addressRaw);
      return res.json({ tipo: 'cups-gas', ...resultado });
    }

    // ── CASO 3: DNI / NIE ────────────────────────────────────
    const esDNI = /^[0-9]{8}[A-Za-z]$/.test(texto.replace(/\s/g, ''));
    const esNIE = /^[XYZxyz][0-9]{7}[A-Za-z]$/.test(texto.replace(/\s/g, ''));

    if (esDNI || esNIE) {
      console.log('🔐 Consulta de scoring para:', upper.replace(/\s/g, ''));
      const scoring = await consultarScoring(upper.replace(/\s/g, ''));
      return res.json({ tipo: 'scoring', scoring });
    }

    // ── CASO 4: Dirección ────────────────────────────────────
    console.log('📍 Búsqueda por dirección:', texto);

    const suggestions = await consultarAutocomplete(texto);
    if (!suggestions || suggestions.length === 0) {
      return res.status(404).json({ error: 'No se encontró ninguna dirección con ese texto. Intenta ser más específico.' });
    }

    // Tomar la primera sugerencia automáticamente
    const firstSuggestion = suggestions[0];
    const horizontals = await consultarHorizontal(
      { uuid: firstSuggestion.uuid, placeIDGoogle: firstSuggestion.placeIDGoogle, origin: firstSuggestion.origin },
      firstSuggestion.niceAddress,
      firstSuggestion.types || ''
    );

    if (!horizontals || horizontals.length === 0) {
      // Devolver las sugerencias para que el usuario elija
      return res.json({
        tipo: 'sugerencias',
        mensaje: 'Encontramos estas direcciones. Selecciona la más parecida o sé más específico.',
        sugerencias: suggestions.slice(0, 5).map(s => ({
          etiqueta: s.niceAddress,
          uuid: s.uuid,
          placeIDGoogle: s.placeIDGoogle,
          origin: s.origin,
          types: s.types
        }))
      });
    }

    // Si solo hay una vivienda, consultar directamente
    if (horizontals.length === 1) {
      const h      = horizontals[0];
      const label  = [h.building, h.staircase, h.floor, h.door].filter(Boolean).join(' ') || 'Dirección única';
      const vert   = await consultarVertical(h.id, label);
      if (vert) {
        const cupsLuz = (vert.cupsID    || '').trim() || null;
        const cupsGas = (vert.gasCupsID || '').trim() || null;
        const resultado = await buildResult(cupsLuz, cupsGas, vert);
        return res.json({ tipo: 'direccion', ...resultado });
      }
    }

    // Hay varias viviendas → devolver opciones de piso
    return res.json({
      tipo: 'seleccion-piso',
      direccion: firstSuggestion.niceAddress,
      mensaje: 'Se encontraron varias viviendas. Indica el piso/puerta.',
      opciones: horizontals.map(h => ({
        id: h.id,
        etiqueta: [h.building && `Edif. ${h.building}`, h.staircase && `Esc. ${h.staircase}`, h.floor && `Piso ${h.floor}`, h.door && `Pta. ${h.door}`].filter(Boolean).join(', ') || 'Dirección única',
        piso: h.floor,
        puerta: h.door,
        escalera: h.staircase,
        edificio: h.building
      }))
    });

  } catch (err) {
    console.error('❌ Error en /consultar:', err);
    return res.status(500).json({ error: 'Error interno al procesar la consulta. Inténtalo de nuevo.' });
  }
});

/**
 * POST /consultar/piso
 * Cuando el usuario selecciona un piso concreto de la lista
 * Body: { id: "...", label: "Piso 3 Pta. A" }
 */
app.post('/consultar/piso', async (req, res) => {
  const { id, label } = req.body;
  if (!id) return res.status(400).json({ error: 'Falta el id del piso.' });

  try {
    const vert = await consultarVertical(id, label || '');
    if (!vert) return res.status(404).json({ error: 'No se encontraron datos para esa vivienda.' });

    const cupsLuz = (vert.cupsID    || '').trim() || null;
    const cupsGas = (vert.gasCupsID || '').trim() || null;
    const resultado = await buildResult(cupsLuz, cupsGas, vert);
    return res.json({ tipo: 'direccion', ...resultado });
  } catch (err) {
    console.error('❌ Error en /consultar/piso:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * POST /scoring
 * Body: { dni: "12345678Z" }
 * Consulta riesgo crediticio de un DNI/NIE
 */
app.post('/scoring', async (req, res) => {
  const { dni } = req.body;
  if (!dni) return res.status(400).json({ error: 'Introduce un DNI o NIE.' });

  const clean = dni.trim().toUpperCase();
  const esDNI = /^[0-9]{8}[A-Z]$/.test(clean);
  const esNIE = /^[XYZ][0-9]{7}[A-Z]$/.test(clean);
  if (!esDNI && !esNIE) return res.status(400).json({ error: 'Formato de DNI/NIE inválido.' });

  try {
    const scoring = await consultarScoring(clean);
    return res.json({ scoring });
  } catch (err) {
    console.error('❌ Error en /scoring:', err);
    return res.status(500).json({ error: 'Error al consultar el scoring. Inténtalo de nuevo.' });
  }
});

// ── Iniciar servidor ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Servidor Naturgy API escuchando en http://localhost:${PORT}`);
  console.log(`   Endpoints disponibles:`);
  console.log(`   POST /consultar  — Dirección, CUPS o DNI`);
  console.log(`   POST /consultar/piso — Selección de vivienda`);
  console.log(`   POST /scoring    — Solo scoring DNI`);
  console.log(`   GET  /health     — Estado del servidor`);
});
