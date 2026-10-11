/**
 * City name -> coordinates via the Open-Meteo Geocoding API (https://open-meteo.com/en/docs/geocoding-api).
 * No API key; free for non-commercial use; location data based on GeoNames (attribute it in the UI).
 * It sends CORS headers, so the browser calls it directly. Searches run on submit only (no
 * search-as-you-type) and results are cached for the session.
 */
export const GEOCODE_ATTRIBUTION = "Location search by Open-Meteo · data from GeoNames";

const ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const MAX_RESULTS = 5;

export interface Place {
  /** Short name, e.g. "Hubballi". */
  name: string;
  /** e.g. "Karnataka, India". */
  region: string;
  lat: number;
  lon: number;
  /** Metres above sea level, when the service knows it. */
  elevation: number | null;
}

interface RawPlace {
  name: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  admin1?: string;
  country?: string;
}

export class GeocodeError extends Error {}

const cache = new Map<string, Place[]>();

async function query(name: string, signal?: AbortSignal): Promise<Place[]> {
  let res: Response;
  try {
    const url = `${ENDPOINT}?${new URLSearchParams({ name, count: String(MAX_RESULTS), language: "en", format: "json" })}`;
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new GeocodeError("Could not reach the location search service. Check your connection.");
  }
  if (!res.ok) throw new GeocodeError(`Location search failed (HTTP ${res.status}).`);

  const body = (await res.json()) as { results?: RawPlace[] };
  return (body.results ?? []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(", "),
    lat: r.latitude,
    lon: r.longitude,
    elevation: typeof r.elevation === "number" ? r.elevation : null,
  }));
}

export async function searchPlaces(input: string, signal?: AbortSignal): Promise<Place[]> {
  const q = input.trim().replace(/\s+/g, " ");
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  let places = await query(q, signal);
  // The service only narrows by state/country after a comma ("Hubballi, Karnataka"); people type
  // "Hubballi Karnataka". If nothing matched, retry with the last word split off as the region.
  const words = q.split(" ");
  if (places.length === 0 && !q.includes(",") && words.length >= 2) {
    places = await query(`${words.slice(0, -1).join(" ")}, ${words[words.length - 1]}`, signal);
  }
  cache.set(key, places);
  return places;
}
