# rtm-mcp

MCP server voor Remember The Milk. Stdio-transport, bedoeld om vanuit Claude Code
in WSL taken weg te schrijven en op te halen.

## Wat het kan

| Tool | Wat het doet |
|---|---|
| `rtm_add_task` | Taak toevoegen, met Smart Add syntax (`^friday !1 #Werk`) of letterlijk |
| `rtm_list_tasks` | Taken ophalen met RTM's filter-taal (`status:incomplete AND dueBefore:today`) |
| `rtm_complete_task` | Afvinken |
| `rtm_update_task` | Naam, due date, prioriteit, tags, estimate |
| `rtm_delete_task` | Verwijderen (soft delete bij RTM) |
| `rtm_get_lists` | Lijsten, met smart lists gemarkeerd |
| `rtm_undo` | Laatste omkeerbare wijziging(en) van deze sessie terugdraaien |

De Smart Add tokens en de filter-syntax staan in de tool-descriptions, dus het
model hoeft ze niet te raden.

## Installeren

```bash
git clone <of pak het archief uit> ~/tools/rtm-mcp
cd ~/tools/rtm-mcp
npm install
npm run build
```

Zet je key en secret in de omgeving en autoriseer eenmalig:

```bash
export RTM_API_KEY=jouw_key
export RTM_SHARED_SECRET=jouw_secret
npm run auth
```

Dat print een URL. Keur hem goed in de browser, druk op Enter, en het token
belandt in `~/.config/rtm-mcp/auth.json` (mode 600). Het token verloopt niet
vanzelf — alleen als je de toegang bij RTM intrekt.

## Aanhaken in Claude Code

```bash
claude mcp add --scope user rtm \
  --env RTM_API_KEY=jouw_key \
  --env RTM_SHARED_SECRET=jouw_secret \
  -- node /home/JOUW_USER/tools/rtm-mcp/dist/index.js
```

`--scope user` zet hem in `~/.claude.json` zodat hij in al je projecten
beschikbaar is. Het pad moet absoluut zijn: Claude Code start dit proces zelf
en heeft geen idee van je working directory.

Controleren: `/mcp` in een sessie, of `claude mcp list`.

## Hoe het werkt

Claude Code start `dist/index.js` als subproces en praat JSON-RPC over
stdin/stdout. Er draait dus geen daemon en er is geen poort. Consequentie:
**stdout is heilig** — alle logging in deze server gaat naar stderr. Eén
`console.log` in de serverpad en de verbinding is stuk.

Wat de client voor je afvangt:

- **api_sig signing.** md5 van je shared secret plus alle parameters
  alfabetisch gesorteerd en aan elkaar geplakt.
- **Rate limiting.** RTM staat 1 request per seconde toe met burst tot 3.
  Daarboven vertraagt RTM je en gaat uiteindelijk 503'en. Er zit een token
  bucket voor met exponentiële backoff op 503.
- **Timeline-hergebruik.** Elke schrijfactie vereist een timeline. Er wordt er
  één per proces aangemaakt en hergebruikt; dat scheelt een call van je
  secondebudget bij elke actie.
- **De single-vs-array quirk.** RTM's JSON maakt van één element een object en
  van meerdere een array. Alles gaat door een normalisatie-helper.
- **Het id-triple.** Taakbewerkingen vereisen `list_id` + `taskseries_id` +
  `task_id`. Die worden gebundeld in één opaque handle, zodat het model ze niet
  door elkaar kan halen.
- **Herhalende taken.** Eén taskseries kan meerdere task-instanties bevatten;
  die worden allemaal apart teruggegeven met een eigen handle.

## Testen

```bash
npm test                       # signing, normalisatie, handles, flattening
node --test test/protocol.test.mjs   # volledige tool-flows tegen een mock-endpoint
node test/smoke.mjs            # echte stdio-server via een echte MCP client
```

De protocol-tests draaien tegen een lokale nagebootste RTM (`RTM_REST_ENDPOINT`
override), inclusief 503-retry en foutcode-mapping.

## Later: ook vanuit Cowork

Stdio werkt alleen op de machine waar Claude Code draait. Wil je dezelfde taken
ook vanuit Cowork of claude.ai benaderen, dan moet er een remote HTTP-variant
komen: `StreamableHTTPServerTransport` uit dezelfde SDK om `src/index.ts` heen,
draaiend op een machine die publiek bereikbaar is, met OAuth ervoor. De tools in
`src/tools.ts` en de client in `src/rtm.ts` zijn transport-agnostisch en kunnen
één op één mee.

Alternatief voor dat scenario: RTM's eigen gehoste MCP server op
`https://www.rememberthemilk.com/mcp`, die werkt in beide surfaces maar een
Pro-abonnement vereist.
