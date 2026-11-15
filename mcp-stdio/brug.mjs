// Logica van de stdio-brug, los van stdin/stdout zodat hij te testen is.
//
// Normaal stuurt de brug elk JSON-RPC-bericht ongewijzigd door naar de MCP-
// server in de draaiende app. Draait de app niet, dan antwoordt de brug zelf:
// initialize en tools/list uit de meegeleverde lijst (tools.json, de publieke
// lijst van de app), en een aanroep met een duidelijke instructie. Zo is de
// extensie in Claude Desktop niet leeg als Claude eerder start dan de app, en
// werkt ze zodra de app draait.
//
// Zonder app kent de brug alleen de ingebouwde gereedschappen: add-ons
// registreren de hunne pas in de draaiende app. Dat zegt de brug ook: in
// de instructies van initialize, in _meta van tools/list en bij een aanroep
// van een add-on-gereedschap. Komt de app daarna op, dan meldt de brug
// notifications/tools/list_changed, zodat de client de volledige lijst ophaalt.

export const NIET_BEREIKBAAR =
  'Oculith Draw is not reachable. Start Oculith Draw and check ' +
  'Settings > General > AI link (MCP) (on by default). The port there must match the port ' +
  "in this extension's settings (default 9223).";

export const ALLEEN_INGEBOUWD =
  'Oculith Draw is not running, so only its built-in tools are listed. Tools from installed ' +
  'add-ons (names starting with addon_) are listed once the app runs: start Oculith Draw ' +
  '(Settings > General > AI link (MCP) is on by default) and list the tools again.';

export const ADDON_NIET_BEREIKBAAR =
  'This tool comes from an add-on and is only available while Oculith Draw is running. ' +
  'Start Oculith Draw (Settings > General > AI link (MCP), on by default, port 9223 unless changed) ' +
  'and list the tools again.';

const isNotificatie = (m) => m && typeof m === 'object' && !Array.isArray(m) && !('id' in m);
const antwoord = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });
const fout = (id, code, message) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
const LIJST_GEWIJZIGD = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });

/**
 * @param {{ endpoint: string, tools: object[], versie: string, fetchFn?: typeof fetch }} opties
 * @returns {(regel: string) => Promise<string|null>} verwerkt één regel, geeft
 *   de te schrijven antwoordregel of null (geen antwoord)
 */
export function maakBrug({ endpoint, tools, versie, fetchFn = fetch }) {
  const ingebouwd = new Set(tools.map((t) => t?.name));
  // De client kreeg de lijst zonder add-ons: meld een wijziging zodra de app antwoordt.
  let lijstZonderApp = false;
  async function stuurDoor(body) {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return res.text();
  }

  function terugval(msg) {
    const id = msg.id ?? null;
    switch (msg.method) {
      case 'initialize':
        return antwoord(id, {
          protocolVersion: msg.params?.protocolVersion || '2025-03-26',
          serverInfo: { name: 'oculith-draw', version: versie },
          // De lijst verandert als de app opkomt (add-on-gereedschappen erbij).
          capabilities: { tools: { listChanged: true } },
          instructions: ALLEEN_INGEBOUWD,
        });
      case 'tools/list':
        lijstZonderApp = true;
        return antwoord(id, { tools, _meta: { notice: ALLEEN_INGEBOUWD } });
      case 'tools/call': {
        const naam = String(msg.params?.name ?? '');
        const tekst = !ingebouwd.has(naam) && naam.startsWith('addon_') ? ADDON_NIET_BEREIKBAAR : NIET_BEREIKBAAR;
        return antwoord(id, { content: [{ type: 'text', text: tekst }], isError: true });
      }
      default:
        return fout(id, -32001, NIET_BEREIKBAAR);
    }
  }

  return async function verwerk(regel) {
    const tekst = String(regel ?? '').trim();
    if (!tekst) return null;
    let msg;
    try {
      msg = JSON.parse(tekst);
    } catch {
      return null;
    }

    // Ping lokaal, zodat de verbinding ook zonder app blijft leven.
    if (!Array.isArray(msg) && msg.method === 'ping' && 'id' in msg) return antwoord(msg.id, {});

    let uit;
    try {
      uit = await stuurDoor(tekst);
    } catch {
      if (isNotificatie(msg)) return null;
      return Array.isArray(msg) ? fout(null, -32001, NIET_BEREIKBAAR) : terugval(msg);
    }
    // De app draait weer: de client heeft de lijst zonder add-ons, laat hem opnieuw vragen.
    const melding = lijstZonderApp ? `${LIJST_GEWIJZIGD}\n` : '';
    lijstZonderApp = false;
    if (isNotificatie(msg)) return melding ? melding.trim() : null;
    const schoon = (uit || '').trim();
    if (schoon) return melding + schoon;
    return melding + fout(Array.isArray(msg) ? null : (msg.id ?? null), -32002, `Empty response from ${endpoint}`);
  };
}
