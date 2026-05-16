import { defaultEndpoints, getJson } from "../config";

export interface DataApiValueRow {
  user: string;
  value: number;
}

export async function fetchPortfolioValue(
  user: string,
  endpoints = defaultEndpoints,
): Promise<number> {
  const url = `${endpoints.data}/value?user=${encodeURIComponent(user)}`;
  const rows = await getJson<DataApiValueRow[]>(url);
  const row = rows.find((r) => r.user.toLowerCase() === user.toLowerCase()) ?? rows[0];
  return row?.value ?? 0;
}
