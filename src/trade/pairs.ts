interface PairDef {
  symbol: string;
  display: string;
  aliases: string[];
}

const PAIRS: PairDef[] = [
  { symbol: 'EURUSD', display: 'Euro Dollar', aliases: ['eurusd', 'eur usd', 'euro dollar', 'euro us dollar', 'fiber'] },
  { symbol: 'GBPUSD', display: 'Pound Dollar', aliases: ['gbpusd', 'gbp usd', 'pound dollar', 'sterling dollar', 'cable'] },
  { symbol: 'USDJPY', display: 'Dollar Yen', aliases: ['usdjpy', 'usd jpy', 'dollar yen'] },
  { symbol: 'AUDUSD', display: 'Aussie Dollar', aliases: ['audusd', 'aud usd', 'aussie dollar', 'aussie'] },
  { symbol: 'USDCAD', display: 'Dollar Loonie', aliases: ['usdcad', 'usd cad', 'dollar cad', 'loonie'] },
  { symbol: 'USDCHF', display: 'Dollar Swiss', aliases: ['usdchf', 'usd chf', 'dollar swiss', 'swissy'] },
  { symbol: 'XAUUSD', display: 'Gold', aliases: ['xauusd', 'xau usd', 'gold'] },
  { symbol: 'XAGUSD', display: 'Silver', aliases: ['xagusd', 'xag usd', 'silver'] },
  { symbol: 'USOIL', display: 'Oil', aliases: ['usoil', 'oil', 'crude', 'wti'] },
  { symbol: 'NAS100', display: 'Nasdaq', aliases: ['nas100', 'nasdaq', 'nas 100', 'us tech 100'] },
  { symbol: 'US30', display: 'Dow', aliases: ['us30', 'us 30', 'dow', 'dow jones'] },
  { symbol: 'US500', display: 'S and P 500', aliases: ['us500', 'us 500', 's and p', 'sp500', 'spx'] },
];

/** Longest alias first, so "euro dollar" never loses to a shorter partial match. */
const SORTED = PAIRS.flatMap((p) => p.aliases.map((a) => ({ alias: a, symbol: p.symbol }))).sort(
  (a, b) => b.alias.length - a.alias.length,
);

export function resolvePair(text: string): string | null {
  const normalised = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const { alias, symbol } of SORTED) {
    const pattern = new RegExp(`(^|\\s)${alias.replace(/\s+/g, '\\s+')}($|\\s)`);
    if (pattern.test(normalised)) return symbol;
  }
  return null;
}

export function displayPair(symbol: string): string {
  return PAIRS.find((p) => p.symbol === symbol)?.display ?? symbol;
}
