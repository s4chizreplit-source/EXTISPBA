export function isValidProviderApiUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function getEnvProvider() {
  const apiUrl = String(process.env.PROVIDER_API_URL || '').trim();
  const apiKey = String(process.env.PROVIDER_API_KEY || '').trim();
  if (!apiKey || !isValidProviderApiUrl(apiUrl)) return null;
  return {
    api_url: apiUrl,
    api_key: apiKey,
    id: null,
    provider_service_id: null,
  };
}