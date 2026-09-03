// ════════════════════════════════════════════════════════════════════
//  /api/prihlasit.js
//  Backend pro přihlášku na zájezd Bosenské pyramidy 2026
//  ──────────────────────────────────────────────────────────────────
//  1. Přijme data z formuláře
//  2. Validuje
//  3. Uloží do Supabase → získá VS
//  4. Vygeneruje SPAYD řetězec pro QR kód
//  5. Odešle email klientovi (s údaji + QR řetězcem)
//  6. Odešle notifikaci adminovi
//  7. Vrátí frontendu data pro zobrazení QR + shrnutí
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

// ── Konfigurace (z Vercel Environment Variables) ──────────────────
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const BREVO_API_KEY         = process.env.BREVO_API_KEY;
const SENDER_EMAIL          = process.env.SENDER_EMAIL || 'info@oaza-adamanthea.cz';
const SENDER_NAME           = process.env.SENDER_NAME  || 'Oáza Adamanthea';
const ADMIN_EMAIL           = process.env.ADMIN_EMAIL  || 'oaza.adamanthea@gmail.com';

// ── Bankovní účty ─────────────────────────────────────────────────
const UCET_CZK = {
  iban:     'CZ1655000000008159854004',
  ucet:     '8159854004/5500',  // pro zobrazení
  banka:    'Raiffeisenbank',
};

const UCET_EUR = {
  iban:     'CZ1820100000002500144501',
  bic:      'FIOBCZPPXXX',
  ucet:     '2500144501/2010',  // pro zobrazení
  banka:    'Fio banka',
};

const PRIJEMCE = 'Lukas Hudecek';  // bez diakritiky pro QR (SPAYD spec)

// ── Ceník ─────────────────────────────────────────────────────────
const CENIK = {
  CZK: {
    standard:    12900,
    deti:        10900,
    foceni_aury:   500,
    zaloha:       5900,
  },
  EUR: {
    standard:    516,
    deti:        436,
    foceni_aury:  20,
    zaloha:      236,
  },
};

// ════════════════════════════════════════════════════════════════════
//  Hlavní handler
// ════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // CORS pro případ, že by se to volalo z jiné domény
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ chyba: 'Pouze POST.' });
  }

  try {
    const data = req.body;

    // ── 1) Validace ────────────────────────────────────────────────
    const chyba = validujData(data);
    if (chyba) return res.status(400).json({ chyba });

    // ── 2) Výpočet částky ─────────────────────────────────────────
    const mena = data.mena === 'EUR' ? 'EUR' : 'CZK';
    const ceny = CENIK[mena];
    const zaklad = ceny[data.cena_typ];                 // standard | deti
    const doplnek = data.foceni_aury ? ceny.foceni_aury : 0;
    const celkemZaPobyt = zaklad + doplnek;
    const castka = data.platba_typ === 'zaloha' ? ceny.zaloha : celkemZaPobyt;

    // ── 3) Uložení do Supabase (tím dostaneme VS) ─────────────────
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: vlozene, error: dbError } = await supabase
      .from('prihlasky_pyramidy')
      .insert({
        jmeno:            data.jmeno,
        datum_narozeni:   data.datum_narozeni,
        narodnost:        data.narodnost,
        cislo_dokladu:    data.cislo_dokladu,
        adresa:           data.adresa,
        email:            data.email,
        telefon:          data.telefon,
        jak_se_dozvedeli: data.jak_se_dozvedeli || null,
        nastupni_misto:   data.nastupni_misto,
        strava:           data.strava,
        ubytovani:        data.ubytovani,
        spolubydlici:     data.spolubydlici || null,
        sdileni_pokoj:    !!data.sdileni_pokoj,
        cena_typ:         data.cena_typ,
        foceni_aury:      !!data.foceni_aury,
        mena,
        platba_typ:       data.platba_typ,
        castka,
        souhlas_podminky: !!data.souhlas_podminky,
      })
      .select('vs')
      .single();

    if (dbError) {
      console.error('Supabase error:', dbError);
      return res.status(500).json({ chyba: 'Chyba při ukládání. Kontaktujte nás prosím.' });
    }

    const vs = vlozene.vs;

    // ── 4) Vygenerování SPAYD řetězce pro QR kód ──────────────────
    const ucet = mena === 'EUR' ? UCET_EUR : UCET_CZK;
    const zprava = `Pyramidy ${data.jmeno}`.substring(0, 60);
    const spayd = generujSPAYD({
      iban: ucet.iban,
      castka,
      mena,
      vs: String(vs),
      zprava,
      prijemce: PRIJEMCE,
    });

    // ── 5) Odeslat emaily (souběžně) ──────────────────────────────
    const ucetText = mena === 'EUR'
      ? `IBAN: ${UCET_EUR.iban}\nBIC/SWIFT: ${UCET_EUR.bic}\nBanka: ${UCET_EUR.banka}`
      : `Číslo účtu: ${UCET_CZK.ucet}\nIBAN: ${UCET_CZK.iban}\nBanka: ${UCET_CZK.banka}`;

    await Promise.allSettled([
      odeslatKlientovi({ data, vs, castka, mena, ucet, ucetText, spayd, celkemZaPobyt }),
      odeslatAdminovi({ data, vs, castka, mena, celkemZaPobyt }),
    ]);

    // ── 6) Odpověď frontendu ──────────────────────────────────────
    return res.status(200).json({
      uspech: true,
      vs,
      castka,
      mena,
      celkemZaPobyt,
      platba_typ: data.platba_typ,
      spayd,
      ucet: {
        iban:  ucet.iban,
        ucet:  ucet.ucet,
        banka: ucet.banka,
        bic:   ucet.bic || null,
        prijemce: 'Lukáš Hudeček',
      },
      zprava,
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ chyba: 'Nastala neočekávaná chyba. Zkuste to prosím znovu.' });
  }
}

// ════════════════════════════════════════════════════════════════════
//  Validace dat z formuláře
// ════════════════════════════════════════════════════════════════════
function validujData(d) {
  if (!d || typeof d !== 'object') return 'Neplatná data.';

  const povinne = [
    'jmeno', 'datum_narozeni', 'narodnost', 'cislo_dokladu', 'adresa',
    'email', 'telefon', 'nastupni_misto', 'strava', 'ubytovani',
    'cena_typ', 'platba_typ',
  ];
  for (const k of povinne) {
    if (!d[k] || String(d[k]).trim() === '') return `Chybí povinné pole: ${k}.`;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return 'Neplatný e-mail.';
  if (!['standard', 'deti'].includes(d.cena_typ)) return 'Neplatný typ ceny.';
  if (!['zaloha', 'cela'].includes(d.platba_typ)) return 'Neplatný typ platby.';
  if (!['CZK', 'EUR'].includes(d.mena)) return 'Neplatná měna.';
  if (!d.souhlas_podminky) return 'Musíte souhlasit s podmínkami.';

  return null;
}

// ════════════════════════════════════════════════════════════════════
//  Generování SPAYD řetězce (Short Payment Descriptor — český QR)
//  Specifikace: https://qr-platba.cz/pro-vyvojare/specifikace-formatu/
// ════════════════════════════════════════════════════════════════════
function generujSPAYD({ iban, castka, mena, vs, zprava, prijemce }) {
  // SPAYD: SPD*1.0*ACC:IBAN*AM:částka*CC:měna*X-VS:VS*MSG:zpráva*RN:příjemce
  // Pole musí být v ASCII (bez diakritiky)
  const sanitize = (s) => String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // odstranit diakritiku
    .replace(/[*]/g, ' ')              // hvězdička je oddělovač
    .substring(0, 60);

  const parts = [
    'SPD',
    '1.0',
    `ACC:${iban}`,
    `AM:${Number(castka).toFixed(2)}`,
    `CC:${mena}`,
    `X-VS:${vs}`,
    `MSG:${sanitize(zprava)}`,
    `RN:${sanitize(prijemce)}`,
  ];
  return parts.join('*');
}

// ════════════════════════════════════════════════════════════════════
//  Odeslání e-mailu přes Brevo API
// ════════════════════════════════════════════════════════════════════
async function brevoSend({ to, subject, html, replyTo }) {
  const body = {
    sender:  { email: SENDER_EMAIL, name: SENDER_NAME },
    to:      [{ email: to.email, name: to.name }],
    subject,
    htmlContent: html,
  };
  if (replyTo) body.replyTo = { email: replyTo };

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: {
      'accept':       'application/json',
      'api-key':      BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error('Brevo error:', resp.status, text);
    throw new Error('Email se nepodařilo odeslat.');
  }
  return resp.json();
}

// ════════════════════════════════════════════════════════════════════
//  E-mail klientovi — potvrzení přihlášky + údaje k platbě
// ════════════════════════════════════════════════════════════════════
async function odeslatKlientovi({ data, vs, castka, mena, ucet, ucetText, spayd, celkemZaPobyt }) {
  const symbolMeny = mena === 'EUR' ? '€' : 'Kč';
  const formatovanaCastka = mena === 'EUR'
    ? `${castka.toLocaleString('de-DE')} €`
    : `${castka.toLocaleString('cs-CZ')} Kč`;
  const formatovanaCelkem = mena === 'EUR'
    ? `${celkemZaPobyt.toLocaleString('de-DE')} €`
    : `${celkemZaPobyt.toLocaleString('cs-CZ')} Kč`;

  const platbaText = data.platba_typ === 'zaloha'
    ? `Záloha: <strong>${formatovanaCastka}</strong><br>Doplatek do plné ceny (${formatovanaCelkem}) bude splatný před odjezdem.`
    : `Plná částka: <strong>${formatovanaCastka}</strong>`;

  // QR kód generujeme z platebního řetězce SPAYD (stejně jako na webu) přes spolehlivou službu
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(spayd)}`;

  const html = `
<!DOCTYPE html>
<html lang="cs">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background:#f5efe1; font-family: Georgia, serif; color:#3a2e1a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5efe1; padding:30px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fffaf0; border:1px solid #d4b878; border-radius:8px; max-width:600px;">
        <tr><td style="padding:40px 40px 20px; text-align:center;">
          <div style="font-size:11px; letter-spacing:6px; color:#a8893d; margin-bottom:14px;">✦ &nbsp;·&nbsp; ✦</div>
          <h1 style="font-family: Georgia, serif; font-size:24px; color:#8a6820; letter-spacing:2px; margin:0 0 10px;">AKTIVACE NA BOSENSKÝCH PYRAMIDÁCH</h1>
          <p style="color:#a8893d; font-size:13px; letter-spacing:3px; margin:0;">24. – 29. září 2026</p>
        </td></tr>

        <tr><td style="padding:0 40px;">
          <hr style="border:none; border-top:1px solid #e8d8b0; margin:0;">
        </td></tr>

        <tr><td style="padding:30px 40px;">
          <p style="font-size:16px; line-height:1.7; margin:0 0 20px;">Milý/á <strong>${escHtml(data.jmeno)}</strong>,</p>
          <p style="font-size:15px; line-height:1.7; margin:0 0 20px;">
            děkujeme za Vaši přihlášku na zájezd k Bosenským pyramidám.
            Vaše místo je rezervováno po připsání platby na účet.
          </p>

          <h2 style="font-family: Georgia, serif; font-size:16px; color:#8a6820; letter-spacing:2px; margin:30px 0 14px; border-bottom:1px solid #e8d8b0; padding-bottom:8px;">ÚDAJE K PLATBĚ</h2>

          <table width="100%" cellpadding="6" cellspacing="0" style="font-size:14px;">
            <tr><td style="color:#7a6a4a; width:160px;">Částka:</td><td><strong style="color:#8a6820; font-size:18px;">${formatovanaCastka}</strong></td></tr>
            <tr><td style="color:#7a6a4a;">Variabilní symbol:</td><td><strong>${vs}</strong></td></tr>
            <tr><td style="color:#7a6a4a;">Zpráva pro příjemce:</td><td>Pyramidy ${escHtml(data.jmeno)}</td></tr>
            <tr><td style="color:#7a6a4a; vertical-align:top;">Příjemce:</td><td>Lukáš Hudeček</td></tr>
            ${mena === 'CZK'
              ? `<tr><td style="color:#7a6a4a;">Číslo účtu:</td><td><strong>${UCET_CZK.ucet}</strong></td></tr>
                 <tr><td style="color:#7a6a4a;">IBAN:</td><td>${UCET_CZK.iban}</td></tr>
                 <tr><td style="color:#7a6a4a;">Banka:</td><td>${UCET_CZK.banka}</td></tr>`
              : `<tr><td style="color:#7a6a4a;">IBAN:</td><td><strong>${UCET_EUR.iban}</strong></td></tr>
                 <tr><td style="color:#7a6a4a;">BIC/SWIFT:</td><td>${UCET_EUR.bic}</td></tr>
                 <tr><td style="color:#7a6a4a;">Banka:</td><td>${UCET_EUR.banka}</td></tr>`
            }
          </table>

          <p style="font-size:14px; line-height:1.7; margin:20px 0 0; color:#7a6a4a;">${platbaText}</p>

          <div style="text-align:center; margin:30px 0;">
            <p style="font-size:13px; color:#7a6a4a; margin:0 0 14px;">QR kód pro rychlou platbu:</p>
            <img src="${qrUrl}" alt="QR platba" width="240" height="240" style="border:1px solid #e8d8b0; border-radius:8px; padding:10px; background:#fff;">
          </div>

          <h2 style="font-family: Georgia, serif; font-size:16px; color:#8a6820; letter-spacing:2px; margin:30px 0 14px; border-bottom:1px solid #e8d8b0; padding-bottom:8px;">SHRNUTÍ PŘIHLÁŠKY</h2>
          <table width="100%" cellpadding="5" cellspacing="0" style="font-size:14px;">
            <tr><td style="color:#7a6a4a; width:160px;">Nástupní místo:</td><td>${escHtml(data.nastupni_misto)}</td></tr>
            <tr><td style="color:#7a6a4a;">Strava:</td><td>${escHtml(data.strava)}</td></tr>
            <tr><td style="color:#7a6a4a;">Ubytování:</td><td>${escHtml(data.ubytovani)} pokoj</td></tr>
            <tr><td style="color:#7a6a4a;">Cena (typ):</td><td>${data.cena_typ === 'standard' ? 'Standard (dospělý)' : 'Dítě do 12 let'}</td></tr>
            ${data.foceni_aury ? `<tr><td style="color:#7a6a4a;">Doplněk:</td><td>Focení aury a čaker</td></tr>` : ''}
            <tr><td style="color:#7a6a4a;">Celková cena pobytu:</td><td><strong>${formatovanaCelkem}</strong></td></tr>
          </table>

          <p style="font-size:13px; line-height:1.7; margin:30px 0 0; color:#7a6a4a; font-style:italic;">
            V případě jakýchkoli dotazů odpovězte přímo na tento e-mail nebo nás kontaktujte na
            <a href="mailto:oaza.adamanthea@gmail.com" style="color:#8a6820;">oaza.adamanthea@gmail.com</a>.
          </p>
        </td></tr>

        <tr><td style="padding:20px 40px 30px; text-align:center; border-top:1px solid #e8d8b0;">
          <p style="font-size:12px; color:#a8893d; margin:0; letter-spacing:1px;">© 2026 Oáza Adamanthea</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return brevoSend({
    to:      { email: data.email, name: data.jmeno },
    subject: `Potvrzení přihlášky – Bosenské pyramidy 2026 (VS: ${vs})`,
    html,
    replyTo: ADMIN_EMAIL,
  });
}

// ════════════════════════════════════════════════════════════════════
//  E-mail adminovi — notifikace o nové přihlášce
// ════════════════════════════════════════════════════════════════════
async function odeslatAdminovi({ data, vs, castka, mena, celkemZaPobyt }) {
  const formCastka = mena === 'EUR'
    ? `${castka.toLocaleString('de-DE')} €`
    : `${castka.toLocaleString('cs-CZ')} Kč`;
  const formCelkem = mena === 'EUR'
    ? `${celkemZaPobyt.toLocaleString('de-DE')} €`
    : `${celkemZaPobyt.toLocaleString('cs-CZ')} Kč`;

  const html = `
<!DOCTYPE html>
<html><body style="font-family: Arial, sans-serif; color:#222; max-width:600px; margin:auto; padding:20px;">
  <h2 style="color:#8a6820;">🌟 Nová přihláška – Pyramidy 2026</h2>
  <p><strong>VS: ${vs}</strong></p>

  <h3>Osobní údaje</h3>
  <table cellpadding="4" style="font-size:14px;">
    <tr><td><strong>Jméno:</strong></td><td>${escHtml(data.jmeno)}</td></tr>
    <tr><td><strong>Datum narození:</strong></td><td>${escHtml(data.datum_narozeni)}</td></tr>
    <tr><td><strong>Národnost:</strong></td><td>${escHtml(data.narodnost)}</td></tr>
    <tr><td><strong>Doklad:</strong></td><td>${escHtml(data.cislo_dokladu)}</td></tr>
    <tr><td><strong>Adresa:</strong></td><td>${escHtml(data.adresa)}</td></tr>
    <tr><td><strong>E-mail:</strong></td><td><a href="mailto:${escHtml(data.email)}">${escHtml(data.email)}</a></td></tr>
    <tr><td><strong>Telefon:</strong></td><td>${escHtml(data.telefon)}</td></tr>
    <tr><td><strong>Jak se dozvěděli:</strong></td><td>${escHtml(data.jak_se_dozvedeli || '—')}</td></tr>
  </table>

  <h3>Zájezd</h3>
  <table cellpadding="4" style="font-size:14px;">
    <tr><td><strong>Nástupní místo:</strong></td><td>${escHtml(data.nastupni_misto)}</td></tr>
    <tr><td><strong>Strava:</strong></td><td>${escHtml(data.strava)}</td></tr>
    <tr><td><strong>Ubytování:</strong></td><td>${escHtml(data.ubytovani)}</td></tr>
    <tr><td><strong>Spolubydlící:</strong></td><td>${escHtml(data.spolubydlici || '—')}</td></tr>
    <tr><td><strong>Sdílení pokoje:</strong></td><td>${data.sdileni_pokoj ? 'Ano' : 'Ne'}</td></tr>
    <tr><td><strong>Cena (typ):</strong></td><td>${data.cena_typ === 'standard' ? 'Standard' : 'Dítě'}</td></tr>
    <tr><td><strong>Focení aury:</strong></td><td>${data.foceni_aury ? 'Ano' : 'Ne'}</td></tr>
  </table>

  <h3>Platba</h3>
  <table cellpadding="4" style="font-size:14px;">
    <tr><td><strong>Měna:</strong></td><td>${mena}</td></tr>
    <tr><td><strong>Typ platby:</strong></td><td>${data.platba_typ === 'zaloha' ? 'Záloha' : 'Plná částka'}</td></tr>
    <tr><td><strong>K úhradě:</strong></td><td><strong>${formCastka}</strong></td></tr>
    <tr><td><strong>Celkem za pobyt:</strong></td><td>${formCelkem}</td></tr>
  </table>

  <p style="margin-top:30px; font-size:12px; color:#888;">
    Záznam v Supabase: prihlasky_pyramidy (vs=${vs}).
  </p>
</body></html>`;

  return brevoSend({
    to:      { email: ADMIN_EMAIL, name: 'Admin' },
    subject: `🌟 Nová přihláška Pyramidy – ${data.jmeno} (VS: ${vs})`,
    html,
    replyTo: data.email,
  });
}

// ── Helper: HTML escape ────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
