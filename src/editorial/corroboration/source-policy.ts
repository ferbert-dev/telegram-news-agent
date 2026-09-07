/**
 * How much weight a publisher carries when it repeats a story.
 *
 * `strong` counts towards the corroboration threshold and can lift the
 * unverified caveat. `other` does not, but its reporting still reaches the
 * model as material to write from.
 *
 * The two tiers exist because one list was doing two incompatible jobs.
 * `normalizeFactResult` in the frozen `src/exa-provider.js` discards every
 * result whose host is not one of about forty domains, which is a defensible
 * rule for "may this lift a caveat" and a ruinous one for "may the article
 * mention this". Measured on the stage: three paid searches returned fifteen
 * candidates for a Miami runway crash -- a story covered by the Miami Herald,
 * CNN, NBC and local outlets, none of them on the list -- and the published
 * article cited exactly one source, the one it started with.
 */
export type SourceTier = "strong" | "other";

/**
 * Publishers whose agreement is treated as verification.
 *
 * Inherited from the legacy list rather than reinvented, because the question
 * it answers has not changed. It is separate from the legacy copy on purpose:
 * that one lives in the frozen runtime and stays as it is.
 */
const STRONG_HOSTS: readonly string[] = [
  // Wire services and international broadcasters
  "reuters.com",
  "apnews.com",
  "afp.com",
  "bbc.com",
  "bbc.co.uk",
  "dw.com",
  "npr.org",
  "pbs.org",
  "euronews.com",
  "aljazeera.com",
  // Newspapers of record
  "theguardian.com",
  "ft.com",
  "bloomberg.com",
  "economist.com",
  "wsj.com",
  "nytimes.com",
  "washingtonpost.com",
  "politico.com",
  "tagesschau.de",
  "spiegel.de",
  "zeit.de",
  "faz.net",
  "sueddeutsche.de",
  "elpais.com",
  "lemonde.fr",
  "pravda.com.ua",
  "suspilne.media",
  // Official and intergovernmental
  "europa.eu",
  "un.org",
  "who.int",
  "nato.int",
  "oecd.org",
  "worldbank.org",
  "imf.org",
  "esa.int",
  "nasa.gov",
  // Academic and primary research
  "arxiv.org",
  "doi.org",
  "nature.com",
  "science.org",
  "cell.com",
  "pnas.org",
  "nejm.org",
  "thelancet.com",
];

const STRONG_SUFFIXES: readonly string[] = [
  ".gov",
  ".edu",
  "gov.uk",
  "gov.au",
  "gov.ca",
  "gov.nz",
  "gov.sg",
  "gob.es",
  "gouv.fr",
  "bund.de",
  "ac.uk",
  "edu.au",
  "edu.ca",
];

/** The registrable host, lowercased, without a leading `www.`. */
export function publisherOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function tierOf(url: string): SourceTier | null {
  const host = publisherOf(url);
  if (!host) return null;
  if (STRONG_HOSTS.includes(host)) return "strong";
  if (STRONG_HOSTS.some((strong) => host.endsWith(`.${strong}`))) return "strong";
  if (STRONG_SUFFIXES.some((suffix) => host === suffix || host.endsWith(suffix))) {
    return "strong";
  }
  // Everything else is a publisher we have not vetted. It contributes detail
  // and is attributed by name; it does not decide whether a story is verified.
  return "other";
}
